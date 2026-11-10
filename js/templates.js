// Modèles de projets : rétroplanning à partir de la date clé (ex. le jour de la session).
// Chaque étape : décalage en jours ouvrés par rapport à la date clé (négatif = avant), durée en jours,
// charge de travail, critères, prédécesseurs (par index), responsable par défaut (nom d'une personne).

import { db, tasks, newTask, putTask, newProject, putProject, save, templates, putTemplate, removeTemplate, people } from './store.js';
import { tStart, tEnd, propagate } from './sched.js';
import { uid, parse, toDateStr, addDays, startOfDay, daysBetween, fmt, cap } from './util.js';

/** Modèle intégré : session de formation (démarche qualité type Qualiopi). */
export const BUILTIN = [{
  id: 'tpl-session', builtin: true, name: 'Session de formation', anchor: 'Date de la session',
  steps: [
    { title: 'Analyse du besoin et devis signé', off: -40, days: 2, est: 180, u: 3, i: 5, e: 3 },
    { title: 'Convention de formation envoyée', off: -35, days: 1, est: 45, u: 3, i: 4, e: 2, preds: [0] },
    { title: 'Programme et objectifs pédagogiques', off: -30, days: 3, est: 360, u: 3, i: 5, e: 3, preds: [0] },
    { title: 'Réservation de la salle et logistique', off: -28, days: 1, est: 60, u: 3, i: 3, e: 2, preds: [2] },
    { title: 'Questionnaire de positionnement des stagiaires', off: -21, days: 2, est: 90, u: 3, i: 4, e: 2, preds: [2] },
    { title: 'Supports pédagogiques', off: -20, days: 8, est: 900, u: 3, i: 5, e: 1, preds: [2] },
    { title: 'Convocations des stagiaires', off: -10, days: 1, est: 45, u: 4, i: 4, e: 2, preds: [3, 4] },
    { title: 'Émargement, évaluations et matériel', off: -4, days: 1, est: 90, u: 4, i: 4, e: 2, preds: [5, 6] },
    { title: 'Animation de la session', off: 0, days: 1, est: 420, u: 5, i: 5, e: 4, preds: [7] },
    { title: 'Évaluation à chaud', off: 0, days: 1, est: 30, u: 4, i: 4, e: 3, preds: [7] },
    { title: 'Bilan, attestations et facturation', off: 3, days: 1, est: 120, u: 4, i: 4, e: 2, preds: [8] },
    { title: 'Évaluation à froid', off: 40, days: 1, est: 60, u: 2, i: 4, e: 2, preds: [10] },
  ],
}];

export const allTemplates = () => [...BUILTIN, ...templates()];

const workDay = (d) => db.settings.workDays.includes(d.getDay());
/** Décale une date de n jours ouvrés (n négatif = en arrière). */
export function addWorkDays(d, n) {
  let x = startOfDay(d); const step = n < 0 ? -1 : 1;
  while (!workDay(x)) x = addDays(x, step);
  for (let k = 0; k < Math.abs(n); ) { x = addDays(x, step); if (workDay(x)) k++; }
  return x;
}

/** Crée le projet et ses tâches à partir d'un modèle et de la date clé. */
export function instantiate(tplId, { name, anchorDate, color }) {
  const tpl = allTemplates().find((t) => t.id === tplId);
  if (!tpl) return null;
  const p = newProject({ name: name || tpl.name, color });
  const anchor = parse(anchorDate);
  const team = people();
  const ids = [];
  tpl.steps.forEach((st, k) => {
    const start = addWorkDays(anchor, st.off);
    let endIncl = start;
    for (let j = 1; j < (st.days || 1); j++) endIncl = addWorkDays(endIncl, 1);
    const who = st.who && team.find((x) => x.name.toLowerCase() === String(st.who).toLowerCase());
    const t = newTask({
      title: st.title, projectId: p.id, urgency: st.u ?? 3, importance: st.i ?? 3, energy: st.e ?? 3,
      estimate: st.est ?? 60, allDay: true, start: toDateStr(start) + 'T00:00', end: toDateStr(endIncl) + 'T00:00',
      subtasks: (st.subs || []).map((x) => ({ id: uid(), title: x, done: false, spent: 0 })),
      delegate: who ? who.id : null, notes: st.notes || '',
    });
    ids.push(t.id);
    putTask(t, { silent: true });
  });
  tpl.steps.forEach((st, k) => {
    if (!st.preds?.length) return;
    const t = db.tasks[ids[k]];
    t.preds = st.preds.filter((j) => ids[j]).map((j) => ({ id: ids[j], lag: 0 }));
    putTask(t, { silent: true });
  });
  // Échéance du projet = dernière étape
  const last = Math.max(...ids.map((id) => tEnd(db.tasks[id]).getTime()));
  p.deadline = toDateStr(addDays(new Date(last), -1));
  putProject(p);
  propagate(ids);
  save('template');
  return { project: p, count: ids.length };
}

/** Enregistre un projet existant comme modèle (décalages relatifs à sa dernière tâche datée). */
export function saveAsTemplate(projectId, name) {
  const list = tasks().filter((t) => t.projectId === projectId && t.start).sort((a, b) => a.start.localeCompare(b.start));
  if (!list.length) return null;
  const anchor = new Date(Math.max(...list.map((t) => tStart(t).getTime())));
  const idx = new Map(list.map((t, k) => [t.id, k]));
  const workBetween = (a, b) => { let n = 0, x = startOfDay(a); const step = b < a ? -1 : 1; while (daysBetween(x, b) !== 0) { x = addDays(x, step); if (workDay(x)) n += step; } return n; };
  const tpl = {
    id: uid(), name, anchor: 'Date clé (dernière étape)',
    steps: list.map((t) => ({
      title: t.title, off: workBetween(anchor, tStart(t)), days: Math.max(1, daysBetween(tStart(t), tEnd(t))),
      est: t.estimate, u: t.urgency, i: t.importance, e: t.energy,
      preds: (t.preds || []).map((p) => idx.get(p.id)).filter((x) => x != null),
      subs: (t.subtasks || []).map((x) => x.title), who: t.delegate ? db.resources[t.delegate]?.name : null, notes: t.notes,
    })),
  };
  putTemplate(tpl);
  return tpl;
}

export { removeTemplate };
