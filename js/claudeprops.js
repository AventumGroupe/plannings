// Propositions de tâches déposées par les recherches planifiées de Claude (matin : journée à venir ;
// soir : journée passée) dans le dépôt de données privé (fichier propositions.json).
// L'utilisateur accepte (la tâche part dans Décision), modifie avant d'accepter, ou refuse.
// Le choix est synchronisé entre appareils : tâche « cl-<id> » créée, ou suppression notée (jamais reproposée).

import { db, local, newTask, putTask, save } from './store.js';
import { ghConfigured, ghRepo, ghToken } from './github.js';

const FILE = 'propositions.json';
const fromB64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export const propsCache = () => local.get('claudeProps', []);
const taskId = (p) => 'cl-' + String(p.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
/** Propositions encore en attente de réponse sur cet appareil (ni acceptées, ni refusées). */
export const pendingProps = () => propsCache().filter((p) => p && p.id && p.titre && !db.tasks[taskId(p)] && !db.deleted[taskId(p)]);

let last = 0, running = null;
/** Lit propositions.json dans le dépôt de données (au plus toutes les 5 min, sauf force). */
export function fetchProps(force = false) {
  if (!ghConfigured() || !navigator.onLine) return Promise.resolve(false);
  if (running) return running;
  if (!force && Date.now() - last < 5 * 60 * 1000) return Promise.resolve(false);
  last = Date.now();
  running = (async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${ghRepo()}/contents/${FILE}`, {
        cache: 'no-store', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${ghToken()}`, 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (res.status === 404) { local.set('claudeProps', []); return true; }
      if (!res.ok) return false;
      const j = await res.json();
      const data = JSON.parse(fromB64(j.content || ''));
      const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
      local.set('claudeProps', items.slice(-100));
      return true;
    } catch (e) { console.warn('Propositions de Claude illisibles', e); return false; } finally { running = null; }
  })();
  return running;
}

const lvl = (v, max, d) => (Number.isFinite(Number(v)) && v !== null ? Math.max(1, Math.min(max, Math.round(Number(v)))) : d);
/** Tâche (non enregistrée) correspondant à une proposition. */
export function taskFromProp(p) {
  return newTask({
    id: taskId(p), title: String(p.titre).slice(0, 200),
    notes: [p.description, p.raison ? `Pourquoi : ${p.raison}` : '', `Proposée par Claude (${p.source || 'recherche planifiée'}).`].filter(Boolean).join('\n'),
    urgency: lvl(p.urgence, 5, 3), importance: lvl(p.importance, 5, 3), energy: lvl(p.energie, 4, 3),
    estimate: lvl(p.estimation_min, 100000, 30), due: /^\d{4}-\d{2}-\d{2}$/.test(p.echeance || '') ? p.echeance : null,
    fromClaude: true,
  });
}
/** Accepter : la tâche est créée et part dans l'onglet Décision (motivation à noter). */
export function acceptProp(p) { const t = taskFromProp(p); putTask(t); return t; }
/** Refuser : notée comme supprimée (synchronisé), elle n'est plus jamais proposée. */
export function refuseProp(p) { db.deleted[taskId(p)] = { at: Date.now(), kind: 'proposition' }; save('proposition'); }
