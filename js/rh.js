// Liaison avec la plateforme RH Aventum (gestion-aventum) : congés et absences.
// L'utilisateur colle son lien « Mon agenda » (…/agenda/<jeton>.ics) : il sert d'identifiant
// pour l'API /api/plannings/* (absences et assistant). Le lien reste sur cet appareil.

import { db, local, rhEvents } from './store.js';
import { toDateStr, fmt } from './util.js';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Découpe le lien d'agenda en { base, jeton }, ou null. */
export function parseLink(link) {
  const m = String(link || '').trim().match(/^(https:\/\/[^/]+(?:\/[^?#]*?)?)\/agenda\/([0-9]+-[0-9]+-[0-9a-f]{40})(?:\.ics)?$/i);
  return m ? { base: m[1], jeton: m[2] } : null;
}

export const rhLink = () => local.get('rhLink', '');
export const rhConfigured = () => !!parseLink(rhLink());
export const rhInfo = () => local.get('rhInfo', null); // { role, nom, at, error }

export async function rhApi(path, { method = 'GET', body } = {}) {
  const p = parseLink(rhLink());
  if (!p) throw new Error('Plateforme RH non reliée (Réglages › Plateforme RH).');
  const res = await fetch(p.base + path, {
    method, headers: { 'X-Plannings-Jeton': p.jeton, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  if (!res.ok) throw new Error(data?.erreur || `Erreur ${res.status} de la plateforme RH.`);
  return data;
}

let last = 0;
/** Lit les congés et absences (au plus toutes les 10 min, sauf force). */
export async function rhSync(force = false) {
  if (!rhConfigured() || !navigator.onLine) return false;
  if (!force && Date.now() - last < 10 * 60 * 1000) return false;
  last = Date.now();
  try {
    const r = await rhApi('/api/plannings/absences');
    const nom = norm(r.compte?.nom);
    const events = (r.evenements || []).filter((e) => ['conge', 'absence', 'demande', 'entretien', 'visite'].includes(e.type)).map((e) => {
      const who = (e.titre.split(' — ')[1] || '').trim();
      const own = e.titre === 'Congés payés' || e.titre === 'Mon entretien annuel' || (!!nom && norm(who) === nom);
      return { id: e.id, debut: e.debut, fin: e.fin, titre: e.titre, type: e.type, own, who: own ? '' : who };
    });
    local.set('rhEvents', events);
    local.set('rhInfo', { role: r.compte?.role, nom: r.compte?.nom, at: Date.now(), error: null });
    return true;
  } catch (e) {
    local.set('rhInfo', { ...(rhInfo() || {}), error: e.message, at: Date.now() });
    return false;
  }
}

export async function setRhLink(link) {
  local.set('rhLink', String(link || '').trim());
  if (!link) { local.set('rhEvents', []); local.set('rhInfo', null); return true; }
  return rhSync(true);
}

/** Absence (congé ou absence) d'une personne de l'équipe, par son nom, qui chevauche [from, to] (AAAA-MM-JJ). */
export function absenceOf(name, from = toDateStr(new Date()), to = from) {
  const n = norm(name);
  if (!n) return null;
  const first = n.split(' ')[0];
  return rhEvents().find((e) => !e.own && (e.type === 'conge' || e.type === 'absence') && e.debut <= to && e.fin >= from
    && (norm(e.who) === n || norm(e.who).split(' ')[0] === first && n.split(' ').length === 1)) || null;
}

/** Libellé court d'une absence : « absent(e) du 12 au 16 nov. » */
export const absenceLabel = (a) => a ? `absent(e) ${a.debut === a.fin ? 'le ' + fmt.dateShort.format(new Date(a.debut + 'T00:00')) : `du ${fmt.dateShort.format(new Date(a.debut + 'T00:00'))} au ${fmt.dateShort.format(new Date(a.fin + 'T00:00'))}`}` : '';

/** Absence d'une personne (ressource) pendant la période d'une délégation. */
export function delegateAbsence(t) {
  const p = t.delegate && db.resources[t.delegate];
  if (!p) return null;
  return absenceOf(p.name, toDateStr(new Date()), t.followUp || t.due || toDateStr(new Date()));
}
