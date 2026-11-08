// Moteur de planification : dates des tâches, dépendances (fin -> début),
// décalage des retards, chemin critique, créneaux libres, récurrence.

import { db, tasks, putTask, save, newTask, outlookEvents } from './store.js';
import { parse, toLocal, toDateStr, addDays, startOfDay, sameDay, daysBetween, roundUp, addMinutes, uid, MIN, DAY } from './util.js';

// ---------- Bornes d'une tâche ----------
// Tâche « journée entière » : start/end = premier/dernier jour (inclus), à minuit.
// Tâche horaire : start/end = date et heure.
export const isPlanned = (t) => !!t.start;

export function tStart(t) { return parse(t.start); }
/** Fin exclusive (lendemain minuit pour une tâche à la journée). */
export function tEnd(t) {
  if (!t.start) return null;
  if (t.allDay) return addDays(parse(t.end || t.start), 1);
  return parse(t.end) || new Date(parse(t.start).getTime() + (t.estimate || 60) * MIN);
}
export const tDur = (t) => tEnd(t) - tStart(t);

/** Écrit les bornes d'une tâche à partir d'un début et d'une fin exclusive. */
export function setSpan(t, start, endExcl) {
  if (t.allDay) {
    const s = startOfDay(start);
    let e = startOfDay(new Date(endExcl.getTime() - 1));
    if (e < s) e = s;
    t.start = toDateStr(s) + 'T00:00';
    t.end = toDateStr(e) + 'T00:00';
  } else {
    t.start = toLocal(start);
    t.end = toLocal(endExcl > start ? endExcl : new Date(start.getTime() + 15 * MIN));
  }
}

export function shiftTo(t, newStart) {
  if (t.allDay) {
    const n = Math.max(1, daysBetween(tStart(t), tEnd(t)));
    setSpan(t, newStart, addDays(startOfDay(newStart), n));
  } else {
    setSpan(t, newStart, new Date(newStart.getTime() + tDur(t)));
  }
}

// ---------- Jours et heures ouvrés ----------
const isWorkDay = (d) => db.settings.workDays.includes(d.getDay());

/** Premier instant travaillé à partir de d (plage horaire et jours ouvrés). */
export function nextWorkMoment(d) {
  const { dayStart, dayEnd } = db.settings;
  let x = new Date(d);
  for (let i = 0; i < 21; i++) {
    const h = x.getHours() + x.getMinutes() / 60;
    if (!isWorkDay(x) || h >= dayEnd) { x = startOfDay(addDays(x, 1)); x.setHours(dayStart, 0, 0, 0); continue; }
    if (h < dayStart) x.setHours(dayStart, 0, 0, 0);
    return x;
  }
  return x;
}
export function nextWorkDay(d) {
  let x = startOfDay(d);
  for (let i = 0; i < 21 && !isWorkDay(x); i++) x = addDays(x, 1);
  return x;
}

// ---------- Dépendances ----------
export function succsOf(id) { return tasks().filter((t) => t.preds?.some((p) => p.id === id)); }

/** Vrai si ajouter predId comme prédécesseur de succId créerait une boucle. */
export function wouldCycle(succId, predId) {
  if (succId === predId) return true;
  const seen = new Set();
  const stack = [predId];
  while (stack.length) {
    const x = stack.pop();
    if (x === succId) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    db.tasks[x]?.preds?.forEach((p) => stack.push(p.id));
  }
  return false;
}

/** Début au plus tôt imposé à la tâche s par ses prédécesseurs planifiés. */
export function requiredStart(s) {
  let req = null;
  for (const link of s.preds || []) {
    const p = db.tasks[link.id];
    if (!p || !p.start) continue;
    let r = addDays(tEnd(p), link.lag || 0);
    if (!req || r > req) req = r;
  }
  if (!req) return null;
  if (s.allDay) {
    if (req.getHours() || req.getMinutes()) req = startOfDay(addDays(req, 1));
    return nextWorkDay(req);
  }
  return nextWorkMoment(req);
}

/**
 * Repousse les successeurs (en cascade) qui commenceraient avant la fin de leurs prédécesseurs.
 * Retourne l'ensemble des tâches déplacées.
 */
export function propagate(rootIds) {
  const moved = new Set();
  const queue = [...rootIds];
  let guard = 0;
  while (queue.length && guard++ < 10000) {
    const id = queue.shift();
    for (const s of succsOf(id)) {
      if (!s.start || s.status === 'done') continue;
      const req = requiredStart(s);
      if (req && tStart(s) < req) {
        shiftTo(s, req);
        moved.add(s.id);
        queue.push(s.id);
      }
    }
  }
  moved.forEach((id) => putTask(db.tasks[id], { silent: true }));
  return moved;
}

/**
 * Décale les tâches non terminées dont la fin est passée, puis leurs successeurs.
 * - tâche courte : déplacée au prochain créneau travaillé (même durée) ;
 * - tâche longue ou à la journée : sa fin est prolongée jusqu'à aujourd'hui.
 */
export function rollOverdue(now = new Date()) {
  if (!db.settings.autoShift) return [];
  const moved = [];
  for (const t of tasks()) {
    if (t.status === 'done' || !t.start) continue;
    const end = tEnd(t);
    if (end > now) continue;
    if (t.allDay) {
      t.end = toDateStr(nextWorkDay(now)) + 'T00:00';
    } else if (tDur(t) >= 8 * 60 * MIN || !sameDay(tStart(t), new Date(end.getTime() - 1))) {
      const e = nextWorkMoment(now);
      e.setHours(db.settings.dayEnd, 0, 0, 0);
      t.end = toLocal(e);
    } else {
      shiftTo(t, nextWorkMoment(roundUp(now, 15)));
    }
    t.slips = (t.slips || 0) + 1;
    putTask(t, { silent: true });
    moved.push(t.id);
  }
  if (moved.length) { propagate(moved); save('roll'); }
  return moved;
}

// ---------- Analyse : retards prévus et chemin critique ----------
function topo(list) {
  const ids = new Set(list.map((t) => t.id));
  const indeg = new Map(list.map((t) => [t.id, 0]));
  const out = new Map(list.map((t) => [t.id, []]));
  for (const t of list) for (const p of t.preds || []) if (ids.has(p.id)) { indeg.set(t.id, indeg.get(t.id) + 1); out.get(p.id).push(t); }
  const q = list.filter((t) => indeg.get(t.id) === 0);
  const order = [];
  while (q.length) {
    const t = q.shift(); order.push(t);
    for (const s of out.get(t.id)) { indeg.set(s.id, indeg.get(s.id) - 1); if (indeg.get(s.id) === 0) q.push(s); }
  }
  return { order, out };
}

/**
 * Pour chaque tâche planifiée :
 *  - late     : la fin prévue dépasse son échéance, celle d'un successeur ou celle du projet (en rouge) ;
 *  - critical : sur le chemin critique de son projet (aucune marge) ;
 *  - overdue  : non terminée alors que sa fin est passée ;
 *  - slackDays: marge avant échéance, en jours.
 */
export function analyze() {
  const list = tasks().filter((t) => t.start);
  const { order, out } = topo(list);
  const now = new Date();
  const projEnd = {};
  for (const t of list) {
    const k = t.projectId || '_';
    projEnd[k] = Math.max(projEnd[k] || 0, tEnd(t).getTime());
  }
  const hasLinks = new Set();
  for (const t of list) if (t.preds?.length) { hasLinks.add(t.id); t.preds.forEach((p) => hasLinks.add(p.id)); }

  const deadlineOf = (t) => {
    let d = Infinity;
    if (t.due) d = Math.min(d, addDays(parse(t.due), 1).getTime());
    const pr = t.projectId && db.projects[t.projectId];
    if (pr?.deadline) d = Math.min(d, addDays(parse(pr.deadline), 1).getTime());
    return d;
  };

  const lfDl = {}, lfCp = {}, res = {};
  for (const t of [...order].reverse()) {
    let a = deadlineOf(t);
    let b = projEnd[t.projectId || '_'];
    for (const s of out.get(t.id)) {
      const lag = (s.preds.find((p) => p.id === t.id)?.lag || 0) * DAY;
      a = Math.min(a, lfDl[s.id] - tDur(s) - lag);
      b = Math.min(b, lfCp[s.id] - tDur(s) - lag);
    }
    lfDl[t.id] = a; lfCp[t.id] = b;
    const end = tEnd(t).getTime();
    const open = t.status !== 'done';
    const slack = a - end;
    res[t.id] = {
      late: open && Number.isFinite(slack) && slack < -MIN,
      slackDays: Number.isFinite(slack) ? Math.floor(slack / DAY) : null,
      critical: open && (t.projectId || hasLinks.has(t.id)) && Math.abs(b - end) < MIN,
      overdue: open && end < now.getTime(),
    };
  }
  return res;
}

// ---------- Créneaux libres ----------
export function busyOn(day, exceptId = null) {
  const ds = startOfDay(day), de = addDays(ds, 1);
  const out = [];
  for (const t of tasks()) {
    if (!t.start || t.allDay || t.status === 'done' || t.id === exceptId) continue;
    const s = tStart(t), e = tEnd(t);
    if (s < de && e > ds) out.push([s, e]);
  }
  for (const ev of outlookEvents()) {
    if (ev.isAllDay || ev.showAs === 'free') continue;
    const s = parse(ev.start), e = parse(ev.end);
    if (s < de && e > ds) out.push([s, e]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** Premier créneau libre de durMin minutes, entre fromH et toH, le jour donné. */
export function findFreeSlot(day, durMin, fromH, toH, exceptId = null, accept = null) {
  const now = new Date();
  let x = startOfDay(day); x.setHours(Math.floor(fromH), Math.round((fromH % 1) * 60), 0, 0);
  const lim = startOfDay(day); lim.setHours(toH, 0, 0, 0);
  if (x < now) x = roundUp(now, 15);
  const busy = busyOn(day, exceptId);
  let guard = 0;
  while (x.getTime() + durMin * MIN <= lim.getTime() && guard++ < 200) {
    const e = new Date(x.getTime() + durMin * MIN);
    const clash = busy.find(([s, b]) => s < e && b > x);
    if (!clash && (!accept || accept(x, e))) return x;
    if (!clash) { x = addMinutes(x, 15); continue; }
    x = roundUp(new Date(Math.max(clash[1].getTime(), x.getTime() + 15 * MIN)), 15);
  }
  return null;
}

/** Cherche sur plusieurs jours ouvrés un créneau (par défaut le matin). */
const PLOMB_DAY_MAX = 150; // minutes de tâches plombantes au plus par jour (créneaux propices)
const PLOMB_GAP = 30;      // pas deux tâches plombantes à moins de 30 min d'écart

/** Charge plombante du jour (minutes) et créneaux plombants existants. */
function plombOn(day, exceptId) {
  const ds = startOfDay(day), de = addDays(ds, 1);
  return tasks().filter((o) => o.id !== exceptId && o.start && !o.allDay && o.status !== 'done' && o.energy <= 2 && tStart(o) < de && tEnd(o) > ds);
}

/**
 * Créneau « propice » pour une tâche plombante : le matin, pas collée à une autre tâche plombante,
 * sans dépasser la charge plombante raisonnable de la journée ; les plus plombantes au plus tôt.
 */
export function gentleAccept(t, day) {
  const others = plombOn(day, t.id);
  const load = others.reduce((m, o) => m + (tEnd(o) - tStart(o)) / MIN, 0);
  return (s, e) => {
    if (load + (e - s) / MIN > PLOMB_DAY_MAX) return false;
    return !others.some((o) => tStart(o).getTime() < e.getTime() + PLOMB_GAP * MIN && tEnd(o).getTime() > s.getTime() - PLOMB_GAP * MIN);
  };
}

export function proposeSlot(t, { morning = true, fromDay = new Date(), days = 10, gentle = null } = {}) {
  const S = db.settings;
  const dur = t.estimate || 60;
  const soft = gentle ?? (S.role === 'collaborateur' && t.energy <= 2);
  let d = startOfDay(fromDay);
  for (let i = 0; i < days + 7; i++, d = addDays(d, 1)) {
    if (!S.workDays.includes(d.getDay())) continue;
    const accept = soft ? gentleAccept(t, d) : null;
    // Très plombante : dans les deux premières heures de la journée si possible
    const early = soft && t.energy === 1 ? Math.max(S.dayStart + 2, S.dayStart + dur / 60) : null;
    const slot = (early && findFreeSlot(d, dur, S.dayStart, early, t.id, accept))
      || (morning
        ? findFreeSlot(d, dur, S.dayStart, Math.max(S.morningEnd, S.dayStart + dur / 60), t.id, accept)
        : findFreeSlot(d, dur, S.dayStart, S.dayEnd, t.id, accept));
    if (slot) return slot;
  }
  return null;
}

// ---------- Récurrence ----------
export const RECUR = { daily: 'Chaque jour', weekly: 'Chaque semaine', monthly: 'Chaque mois', yearly: 'Chaque année' };

export function nextOccurrence(t) {
  const r = t.recur;
  if (!r?.freq) return null;
  const base = t.start ? tStart(t) : t.due ? parse(t.due) : startOfDay(new Date());
  const iv = Math.max(1, r.interval || 1);
  let d;
  if (r.freq === 'daily') d = addDays(base, iv);
  else if (r.freq === 'weekly') {
    const days = r.days?.length ? r.days : [base.getDay()];
    const w0 = startOfDay(addDays(base, -((base.getDay() + 6) % 7)));
    for (let i = 1; i < 7 * iv + 8; i++) {
      const x = addDays(base, i);
      const week = Math.floor(daysBetween(w0, x) / 7);
      if (week % iv === 0 && days.includes(x.getDay())) { d = x; break; }
    }
  } else if (r.freq === 'monthly') {
    d = new Date(base); d.setDate(1); d.setMonth(d.getMonth() + iv);
    d.setDate(Math.min(base.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  } else if (r.freq === 'yearly') {
    d = new Date(base); d.setFullYear(d.getFullYear() + iv);
  }
  if (!d) return null;
  if (r.until && d > addDays(parse(r.until), 1)) return null;
  return daysBetween(base, d);
}

/** Termine la tâche ; si elle est récurrente, crée l'occurrence suivante (retournée). */
export function completeTask(t) {
  t.status = 'done';
  t.doneAt = Date.now();
  let next = null;
  if (t.recur?.freq && !t.recurSpawned) {
    const n = nextOccurrence(t);
    if (n != null) {
      const sh = (s) => (s ? toLocal(addDays(parse(s), n)) : s);
      next = newTask({
        ...structuredClone(t), id: uid(), status: 'todo', doneAt: null, outlook: null, slips: 0, recurSpawned: false,
        start: sh(t.start), end: sh(t.end), due: t.due ? toDateStr(addDays(parse(t.due), n)) : null,
        subtasks: t.subtasks.map((s) => ({ ...s, done: false })), preds: [], createdAt: Date.now(),
      });
      putTask(next, { silent: true });
    }
    t.recurSpawned = true;
  }
  putTask(t, { silent: true });
  return next;
}
