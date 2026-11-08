// Données de l'application : tâches, projets, ressources, réglages.
// Stockage local (hors connexion) + fusion pour la synchronisation entre appareils.

import { uid } from './util.js';

const KEY = 'gp:data:v1';
const LOCAL_KEY = 'gp:local:v1';

export const LEVELS = { 1: 'Pas du tout', 2: 'Peu', 3: 'Moyen', 4: 'Assez', 5: 'Très' };
export const ENERGY = {
  1: { label: 'Plombant', hint: 'Vide l’énergie : plutôt le matin, ou à déléguer' },
  2: { label: 'Fatigant', hint: 'Demande un effort' },
  3: { label: 'Stimulant', hint: 'Plutôt agréable' },
  4: { label: 'Dynamisant', hint: 'Recharge les batteries' },
};
export const STATUS = { todo: 'À faire', doing: 'En cours', done: 'Fait' };
export const RES_TYPES = {
  personne: { label: 'Personne', plural: 'Personnes', unit: 'h' },
  salle: { label: 'Salle', plural: 'Salles', unit: '' },
  lieu: { label: 'Lieu', plural: 'Lieux', unit: '' },
  budget: { label: 'Budget', plural: 'Budgets', unit: '€' },
  materiel: { label: 'Matériel', plural: 'Matériel', unit: 'u.' },
};
/** Cartographie : urgence × importance × énergie (ordre d'affichage). */
export const CATEGORIES = {
  priorite: { label: 'Priorités', hint: 'Urgentes, importantes et dynamisantes : à faire en premier.', short: 'Priorité' },
  deleguer: { label: 'Déléguer ou automatiser', hint: 'Urgentes et importantes, mais plombantes : à confier ou à automatiser.', short: 'À déléguer' },
  cote: { label: 'Laisser de côté', hint: 'Urgentes mais peu importantes, qu’elles dynamisent ou plombent.', short: 'De côté' },
  planifier: { label: 'À planifier', hint: 'Importantes, pas urgentes, dynamisantes : à placer dans l’agenda.', short: 'À planifier' },
  collaborer: { label: 'Planifier avec un collaborateur', hint: 'Importantes, pas urgentes, plombantes : à planifier dans le temps et à confier.', short: 'Avec un collaborateur' },
  reste: { label: 'Le reste', hint: 'Ni urgentes ni importantes.', short: 'Le reste' },
};
export const PROJECT_COLORS = ['#3b6fe0', '#2fa37a', '#d9792b', '#b5489a', '#7a5fd1', '#c8a52a', '#2a9bb5', '#d14b4b'];

export const DEFAULT_SETTINGS = {
  dayStart: 7, dayEnd: 20, morningEnd: 12,
  workDays: [1, 2, 3, 4, 5],
  autoShift: true,
  reminder: 15,
  theme: 'auto',
  role: 'dirigeant',
  updatedAt: 0,
};

function blank() {
  return { schema: 1, tasks: {}, projects: {}, resources: {}, deleted: {}, settings: { ...DEFAULT_SETTINGS } };
}

function normalizeTask(t) {
  return {
    title: '', notes: '', urgency: 3, importance: 3, energy: 3, status: 'todo',
    projectId: null, start: null, end: null, allDay: false, estimate: 60, due: null,
    subtasks: [], preds: [], assign: [], delegate: null, recur: null, reminder: null,
    outlook: null, createdAt: Date.now(), updatedAt: Date.now(), doneAt: null, slips: 0,
    ...t,
  };
}

function normalize(d) {
  const b = blank();
  const out = { ...b, ...d, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } };
  for (const k of ['tasks', 'projects', 'resources', 'deleted']) out[k] = { ...(d[k] || {}) };
  for (const id in out.tasks) out.tasks[id] = normalizeTask(out.tasks[id]);
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) { console.warn('Lecture des données impossible', e); }
  return blank();
}

export let db = load();

const listeners = new Set();
export const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

export function save(reason = 'change', { notify = true } = {}) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.error(e); }
  if (notify) listeners.forEach((f) => f(reason));
}

// ---------- Données propres à cet appareil (non synchronisées) ----------
let localCache;
function localAll() {
  if (!localCache) {
    try { localCache = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { localCache = {}; }
  }
  return localCache;
}
export const local = {
  get: (k, dflt = null) => (k in localAll() ? localAll()[k] : dflt),
  set: (k, v) => { localAll()[k] = v; try { localStorage.setItem(LOCAL_KEY, JSON.stringify(localCache)); } catch {} },
};
/** Événements Outlook (hors tâches) mis en cache pour l'affichage hors connexion. */
export const outlookEvents = () => local.get('outlookEvents', []);

// ---------- Accès ----------
export const tasks = () => Object.values(db.tasks);
export const projects = () => Object.values(db.projects).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
export const resources = () => Object.values(db.resources).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
export const people = () => resources().filter((r) => r.type === 'personne');

export const score = (t) => t.importance * 2 + t.urgency; // de 3 à 15
const CAT_COLLAB = {
  deleguer: { label: 'Au meilleur moment', hint: 'Urgentes et importantes mais plombantes : sur un créneau d’énergie haute (le matin), sans enchaîner deux tâches plombantes.', short: 'Meilleur moment' },
  collaborer: { label: 'À planifier au calme', hint: 'Importantes, pas urgentes, plombantes : à étaler dans le temps, en séances courtes, sur des créneaux propices.', short: 'Au calme' },
};
export const isLeader = () => db.settings.role !== 'collaborateur';
/** Libellé d'une catégorie selon le profil (dirigeant : déléguer ; collaborateur : moment propice). */
export const catInfo = (k) => (!isLeader() && CAT_COLLAB[k]) || CATEGORIES[k];
export const isUrgent = (t) => t.urgency >= 4;
export const isImportant = (t) => t.importance >= 4;
export const isEnergizing = (t) => t.energy >= 3;
export function category(t) {
  const u = isUrgent(t), i = isImportant(t), e = isEnergizing(t);
  if (u && i) return e ? 'priorite' : 'deleguer';
  if (u) return 'cote';
  if (i) return e ? 'planifier' : 'collaborer';
  return 'reste';
}

/** Date de dernière modification, y compris les métadonnées Outlook (pour la fusion). */
export const modAt = (x) => Math.max(x.updatedAt || 0, x.outlook?.syncedAt || 0);

// ---------- Écriture ----------
export function newTask(p = {}) {
  return normalizeTask({ id: uid(), reminder: db.settings.reminder, createdAt: Date.now(), updatedAt: Date.now(), ...p });
}

export function putTask(t, { silent = false, touch = true } = {}) {
  if (touch) t.updatedAt = Date.now();
  db.tasks[t.id] = t;
  if (!silent) save('task');
}

export function removeTask(id) {
  const t = db.tasks[id];
  if (!t) return;
  delete db.tasks[id];
  db.deleted[id] = { at: Date.now(), kind: 'task', outlookId: t.outlook?.id || null };
  for (const o of tasks()) {
    if (o.preds.some((p) => p.id === id)) { o.preds = o.preds.filter((p) => p.id !== id); o.updatedAt = Date.now(); }
  }
  save('task');
}

export function putProject(p) {
  p.updatedAt = Date.now();
  db.projects[p.id] = p;
  save('project');
}
export function newProject(p = {}) {
  const n = Object.keys(db.projects).length;
  return { id: uid(), name: '', color: PROJECT_COLORS[n % PROJECT_COLORS.length], deadline: null, notes: '', updatedAt: Date.now(), ...p };
}
export function removeProject(id) {
  delete db.projects[id];
  db.deleted[id] = { at: Date.now(), kind: 'project' };
  for (const t of tasks()) if (t.projectId === id) { t.projectId = null; t.updatedAt = Date.now(); }
  save('project');
}

export function newResource(p = {}) {
  return { id: uid(), name: '', type: 'personne', capacity: null, notes: '', email: '', updatedAt: Date.now(), ...p };
}
export function putResource(r) {
  r.updatedAt = Date.now();
  db.resources[r.id] = r;
  save('resource');
}
export function removeResource(id) {
  delete db.resources[id];
  db.deleted[id] = { at: Date.now(), kind: 'resource' };
  for (const t of tasks()) {
    let ch = false;
    if (t.assign.some((a) => a.id === id)) { t.assign = t.assign.filter((a) => a.id !== id); ch = true; }
    if (t.delegate === id) { t.delegate = null; ch = true; }
    if (ch) t.updatedAt = Date.now();
  }
  save('resource');
}

export function setSettings(patch) {
  Object.assign(db.settings, patch, { updatedAt: Date.now() });
  save('settings');
}

export function replaceDb(d) {
  db = normalize(d);
  save('import');
}

export function exportJson() {
  return JSON.stringify({ ...db, exportedAt: new Date().toISOString(), app: 'gestion-plannings' }, null, 2);
}

/**
 * Fusionne des données distantes dans les données locales.
 * Règle : pour chaque élément, la version modifiée le plus récemment gagne ;
 * une suppression gagne si elle est postérieure à la dernière modification.
 * Retourne true si les données locales ont changé.
 */
export function mergeRemote(remote) {
  if (!remote || typeof remote !== 'object') return false;
  const r = normalize(remote);
  let changed = false;
  for (const [id, del] of Object.entries(r.deleted)) {
    if (!db.deleted[id] || db.deleted[id].at < del.at) { db.deleted[id] = del; changed = true; }
  }
  for (const k of ['tasks', 'projects', 'resources']) {
    for (const [id, item] of Object.entries(r[k])) {
      const mine = db[k][id];
      if (!mine || modAt(item) > modAt(mine)) { db[k][id] = item; changed = true; }
    }
    for (const [id, item] of Object.entries(db[k])) {
      const del = db.deleted[id];
      if (del && del.at >= modAt(item)) { delete db[k][id]; changed = true; }
    }
  }
  if ((r.settings.updatedAt || 0) > (db.settings.updatedAt || 0)) { db.settings = r.settings; changed = true; }
  // Purge des suppressions de plus de 90 jours
  const limit = Date.now() - 90 * 864e5;
  for (const [id, del] of Object.entries(db.deleted)) if (del.at < limit) delete db.deleted[id];
  if (changed) save('merge');
  return changed;
}
