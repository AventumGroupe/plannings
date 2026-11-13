// Multi-compte : tâches confiées en ligne via la plateforme RH (chacun avec son compte).
// - Envoyer : une tâche « Déléguer » à un membre de l'équipe lui est proposée ; il accepte ou refuse.
// - Recevoir : une proposition acceptée devient une tâche locale, à trancher (motivation privée).
// - Le profil dirigeant / salarié vient du rôle dans la plateforme RH.
// La motivation n'est jamais envoyée.

import { db, tasks, newTask, putTask, removeTask, save, local, people, newResource, putResource, setSettings, isLeader } from './store.js';
import { completeTask } from './sched.js';
import { rhApi, rhConfigured } from './rh.js';
import { delegateTo } from './delegation.js';
import { toast } from './ui.js';

export const team = () => local.get('team', null);              // { moi, equipe, at }
export const sharedList = () => local.get('sharedTasks', []);   // tâches confiées vues par la plateforme
export const teamOnline = () => rhConfigured() && !!team()?.moi;
const listeners = new Set();
export const onTeam = (f) => listeners.add(f);
const emit = () => listeners.forEach((f) => { try { f(); } catch { /* */ } });

/** Membres à qui je peux confier une tâche. */
export const assignable = () => (team()?.equipe || []).filter((m) => m.confiable);
/** Propositions reçues en attente de ma réponse. */
export const incoming = () => sharedList().filter((s) => s.moi === 'a' && s.statut === 'proposee');
/** Vue du dirigeant : propositions entre salariés. */
export const observed = () => sharedList().filter((s) => s.moi === 'observateur');

/** Personne locale (ressource) liée à un membre de la plateforme : créée au besoin. */
export function personFor(member) {
  let p = people().find((x) => x.rhId === member.id) || people().find((x) => x.name.toLowerCase() === member.nom.toLowerCase());
  if (!p) { p = newResource({ name: member.nom, type: 'personne', rhId: member.id }); putResource(p); }
  else if (p.rhId !== member.id) { p.rhId = member.id; putResource(p); }
  return p;
}

let running = null, last = 0;
export function teamSync(force = false) {
  if (!rhConfigured() || !navigator.onLine) return Promise.resolve(false);
  if (running) return running;
  if (!force && Date.now() - last < 60 * 1000) return Promise.resolve(false);
  last = Date.now();
  running = (async () => {
    try {
      const eq = await rhApi('/api/plannings/equipe');
      local.set('team', { moi: eq.moi, equipe: eq.equipe, at: Date.now() });
      // Profil automatique selon le rôle dans la plateforme RH
      const role = eq.moi?.dirigeant ? 'dirigeant' : 'collaborateur';
      if (db.settings.role !== role) setSettings({ role });
      const r = await rhApi('/api/plannings/partage');
      const prevIncoming = new Set(incoming().map((s) => s.id));
      local.set('sharedTasks', r.taches || []);
      reconcile();
      const fresh = incoming().filter((s) => !prevIncoming.has(s.id));
      if (fresh.length) toast(fresh.length === 1 ? `${fresh[0].de.nom} vous propose une tâche : « ${fresh[0].titre} »` : `${fresh.length} nouvelles tâches vous sont proposées.`, { timeout: 6000 });
      emit();
      return true;
    } catch (e) {
      console.warn('Équipe : synchronisation impossible', e);
      return false;
    } finally { running = null; }
  })();
  return running;
}

/** Met les tâches locales en accord avec la plateforme. */
function reconcile() {
  let changed = false;
  for (const s of sharedList()) {
    if (s.moi === 'a') {
      const lid = 'sh-' + s.id;
      let t = db.tasks[lid];
      if (s.statut === 'acceptee' && !t && !db.deleted[lid]) {
        t = newTask({
          id: lid, title: s.titre, notes: [s.description, `Confiée par ${s.de.nom}.`].filter(Boolean).join('\n'),
          urgency: s.urgence || 3, importance: s.importance || 3, energy: s.energie || 3, estimate: s.estimation_min || 60, due: s.echeance || null,
          shared: { id: s.id, role: 'a', from: s.de.nom, fromId: s.de.id, status: s.statut },
        });
        putTask(t, { silent: true }); changed = true;
      } else if (t) {
        if (s.statut === 'annulee' && t.status !== 'done') { removeTask(lid); toast(`${s.de.nom} a annulé « ${s.titre} ».`); changed = true; continue; }
        if (t.shared?.status !== s.statut) { t.shared = { ...(t.shared || {}), status: s.statut }; putTask(t, { silent: true, touch: false }); changed = true; }
        // Terminée ici, pas encore signalée : on la signale
        if (t.status === 'done' && s.statut === 'acceptee') setStatus(s.id, 'faite').catch(() => {});
      }
    } else if (s.moi === 'de') {
      const t = tasks().find((x) => x.shared?.id === s.id);
      if (!t) continue;
      const before = t.shared.status;
      if (before === s.statut) continue;
      t.shared = { ...t.shared, status: s.statut, motif: s.motif || null };
      if (s.statut === 'faite' && t.status !== 'done') { completeTask(t); toast(`${s.a.nom} a terminé « ${t.title} ».`); }
      if (s.statut === 'refusee') {
        delegateTo(t, null, { save: false });
        t.decision = null; // retour dans l'onglet Décision
        toast(`${s.a.nom} a refusé « ${t.title} »${s.motif ? ` : ${s.motif}` : ''}. Elle revient dans Décision.`, { timeout: 7000 });
      }
      if (s.statut === 'acceptee' && before === 'proposee') toast(`${s.a.nom} a accepté « ${t.title} ».`);
      putTask(t, { silent: true }); changed = true;
    }
  }
  if (changed) save('team');
}

/** Confie une tâche à un membre de l'équipe (proposition à accepter). */
export async function shareTask(t, member) {
  const p = t.projectId ? db.projects[t.projectId]?.name : '';
  await rhApi('/api/plannings/partage', { method: 'POST', body: {
    id: t.id, a_compte_id: member.id, titre: t.title, description: t.notes || '', projet: p || '',
    echeance: t.due || null, estimation_min: t.estimate || 60, urgence: t.urgency, importance: t.importance, energie: t.energy,
    // la motivation n'est jamais envoyée
  } });
  const person = personFor(member);
  delegateTo(t, person.id, { save: false });
  t.shared = { id: t.id, role: 'de', to: member.nom, toId: member.id, status: 'proposee' };
  t.decision = { key: 'deleguer', at: Date.now() };
  putTask(t);
  teamSync(true);
}

async function setStatus(id, statut, motif = '') {
  await rhApi(`/api/plannings/partage/${encodeURIComponent(id)}/statut`, { method: 'POST', body: { statut, motif } });
}
export async function acceptShared(id) { await setStatus(id, 'acceptee'); await teamSync(true); }
export async function refuseShared(id, motif) { await setStatus(id, 'refusee', motif); await teamSync(true); }
export async function cancelShared(t) { await setStatus(t.shared.id, 'annulee'); t.shared = { ...t.shared, status: 'annulee' }; delegateTo(t, null, { save: false }); t.decision = null; putTask(t); await teamSync(true); }

/** Une tâche reçue vient d'être terminée ici : prévenir la personne qui l'a confiée. */
export function notifyDone(t) {
  if (t.shared?.role === 'a' && t.shared.status === 'acceptee') setStatus(t.shared.id, 'faite').then(() => teamSync(true)).catch(() => {});
}

export const SHARE_LABEL = { proposee: 'proposée', acceptee: 'acceptée', refusee: 'refusée', faite: 'faite', annulee: 'annulée' };
