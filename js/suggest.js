// Propositions : l'application ne planifie pas seule, elle suggère.
// Logique d'énergie : les tâches plombantes plutôt le matin, ou à déléguer.

import { db, tasks, putTask, save, local, people, score, category, isLeader } from './store.js';
import { tStart, tEnd, setSpan, proposeSlot, analyze, propagate, findFreeSlot } from './sched.js';
import { fmt, cap, sameDay, addDays, startOfDay, toDateStr, MIN, HOUR } from './util.js';

const DISMISS_DAYS = 7;

function dismissed() {
  const d = local.get('dismissed', {});
  const now = Date.now();
  for (const k in d) if (d[k] < now) delete d[k];
  return d;
}
export function dismiss(key) {
  const d = dismissed();
  d[key] = Date.now() + DISMISS_DAYS * 864e5;
  local.set('dismissed', d);
}

const slotLabel = (d) => `${cap(fmt.dayShort.format(d))} à ${fmt.time.format(d)}`;

function placeAt(t, start) {
  t.allDay = false;
  setSpan(t, start, new Date(start.getTime() + (t.estimate || 60) * MIN));
  putTask(t, { silent: true });
  propagate([t.id]);
  save('suggest');
}

/**
 * Liste de propositions : { key, kind, tone, title, text, taskId, actions:[{label, run}] }
 */
export function suggestions(analysis = analyze()) {
  const out = [];
  const S = db.settings;
  const open = tasks().filter((t) => t.status !== 'done');
  const now = new Date();
  const horizon = addDays(now, 7);
  const dis = dismissed();
  const push = (s) => { if (!dis[s.key]) out.push(s); };
  const team = people();

  // 1. Retards prévus (rouge)
  for (const t of open) {
    const a = analysis[t.id];
    if (a?.late) {
      push({
        key: `late:${t.id}`, kind: 'late', tone: 'danger', taskId: t.id,
        title: 'Échéance menacée',
        text: `« ${t.title} » finira après son échéance${a.slackDays != null ? ` (${-a.slackDays} j de retard prévu)` : ''}.`,
        actions: [{ label: 'Ouvrir', open: true }],
      });
    }
  }

  // 2. Urgent et important non planifié
  for (const t of open.filter((t) => !t.start && category(t) === 'priorite').sort((a, b) => score(b) - score(a)).slice(0, 3)) {
    const slot = proposeSlot(t, { morning: t.energy <= 2 });
    if (!slot) continue;
    push({
      key: `doit:${t.id}`, kind: 'plan', tone: 'accent', taskId: t.id,
      title: 'Priorité non planifiée',
      text: `Placer « ${t.title} » ${slotLabel(slot)} ?`,
      actions: [{ label: 'Placer', run: () => placeAt(t, slot) }],
    });
  }

  // 3. Plombantes à faire le matin
  for (const t of open.filter((t) => t.energy <= 2 && !t.start && !t.delegate && (isLeader() ? !['deleguer', 'collaborer', 'cote'].includes(category(t)) : category(t) !== 'cote')).sort((a, b) => score(b) - score(a)).slice(0, 4)) {
    const slot = proposeSlot(t, { morning: true });
    if (!slot) continue;
    push({
      key: `morning:${t.id}`, kind: 'morning', tone: 'energy', taskId: t.id,
      title: isLeader() ? 'Tâche plombante : à faire le matin' : 'Moment propice',
      text: isLeader()
        ? `« ${t.title} » demande de l’énergie. Créneau libre : ${slotLabel(slot)}.`
        : `« ${t.title} » est plombante : ${slotLabel(slot)}, le matin, loin d’une autre tâche plombante et sans surcharger la journée.`,
      actions: [{ label: isLeader() ? 'Placer le matin' : 'Placer', run: () => placeAt(t, slot) }],
    });
  }

  // 4. Plombantes planifiées l'après-midi -> avancer au matin
  for (const t of open) {
    if (t.energy > 2 || !t.start || t.allDay) continue;
    const s = tStart(t);
    if (s < now || s > horizon || s.getHours() < S.morningEnd) continue;
    let slot = proposeSlot(t, { morning: true, fromDay: s, days: 0 });
    if (!slot || !sameDay(slot, s)) slot = proposeSlot(t, { morning: true, fromDay: addDays(startOfDay(s), 1), days: 2 });
    if (!slot) continue;
    push({
      key: `pm:${t.id}:${t.start}`, kind: 'morning', tone: 'energy', taskId: t.id,
      title: 'Plombante l’après-midi',
      text: `« ${t.title} » est prévue ${slotLabel(s)}. L’avancer ${slotLabel(slot)}, quand l’énergie est plus haute ?`,
      actions: [{ label: 'Avancer au matin', run: () => placeAt(t, slot) }],
    });
  }

  // 5. À déléguer / confier : catégories « déléguer ou automatiser » et « avec un collaborateur »
  for (const t of isLeader() ? open : []) {
    if (t.delegate) continue;
    const c = category(t);
    if (c !== 'deleguer' && c !== 'collaborer') continue;
    push({
      key: `delegate:${t.id}`, kind: 'delegate', tone: c === 'deleguer' ? 'warn' : 'energy', taskId: t.id,
      title: c === 'deleguer' ? 'Déléguer ou automatiser' : 'Confier à un collaborateur',
      text: c === 'deleguer'
        ? `« ${t.title} » est urgente et importante mais plombante : confiez-la ou automatisez-la.`
        : `« ${t.title} » est importante, pas urgente, mais plombante : planifiez-la dans le temps avec un collaborateur.`,
      actions: team.length
        ? team.slice(0, 4).map((p) => ({ label: `Confier à ${p.name}`, run: () => { t.delegate = p.id; putTask(t); } }))
        : [{ label: 'Ajouter une personne', href: '#ressources' }],
    });
  }

  // 6b. Collaborateur : tâche très plombante et longue -> séances courtes
  if (!isLeader()) {
    for (const t of open.filter((t) => t.energy === 1 && (t.estimate || 60) > 90 && !t.allDay)) {
      push({
        key: `split:${t.id}`, kind: 'split', tone: 'energy', taskId: t.id,
        title: 'Découper en séances',
        text: `« ${t.title} » est très plombante (${Math.round((t.estimate || 60) / 60 * 10) / 10} h). Mieux vaut 2 à 3 séances d’environ 45 min sur plusieurs matinées, notées en sous-tâches.`,
        actions: [{ label: 'Découper', run: () => {
          const n = Math.min(4, Math.ceil((t.estimate || 60) / 45));
          if (!t.subtasks.length) t.subtasks = Array.from({ length: n }, (_, i) => ({ id: `${t.id}-s${i}`, title: `Séance ${i + 1}`, done: false }));
          t.estimate = Math.ceil((t.estimate || 60) / n / 15) * 15;
          if (t.start) setSpan(t, tStart(t), new Date(tStart(t).getTime() + t.estimate * MIN));
          putTask(t);
        } }],
      });
    }
  }

  // 7. Enchaîner une tâche plombante avec une tâche dynamisante (récupération)
  const lift = open.filter((t) => !t.start && t.energy >= 3).sort((a, b) => score(b) - score(a));
  let liftN = 0;
  for (const t of open.filter((t) => t.start && !t.allDay && t.energy <= 2).sort((a, b) => a.start.localeCompare(b.start))) {
    if (!lift.length || liftN >= (isLeader() ? 1 : 2)) break;
    const end = tEnd(t);
    if (end < now || end > addDays(now, 2)) continue;
    const next = lift[0];
    const from = end.getHours() + end.getMinutes() / 60;
    const slot = findFreeSlot(end, next.estimate || 30, from, Math.min(S.dayEnd, from + 1), next.id);
    if (!slot || slot.getTime() !== end.getTime()) continue;
    lift.shift(); liftN++;
    push({
      key: `lift:${t.id}:${next.id}`, kind: 'lift', tone: 'accent', taskId: next.id,
      title: 'Enchaîner avec une dynamisante',
      text: `Après « ${t.title} » (plombante), « ${next.title} » redonnera de l’énergie : ${slotLabel(slot)}.`,
      actions: [{ label: 'Enchaîner', run: () => placeAt(next, slot) }],
    });
  }

  // 6. Journée trop plombante
  for (let i = 0; i < 5; i++) {
    const d = addDays(startOfDay(now), i);
    const heavy = open.filter((t) => t.start && !t.allDay && t.energy <= 2 && sameDay(tStart(t), d));
    const hours = heavy.reduce((h, t) => h + (tEnd(t) - tStart(t)) / HOUR, 0);
    if (hours >= (isLeader() ? 4 : 2.5)) {
      push({
        key: `heavy:${d.toDateString()}`, kind: 'balance', tone: 'warn',
        title: 'Journée chargée en plombant',
        text: `${cap(fmt.dayLong.format(d))} : ${hours.toFixed(1).replace('.', ',')} h de tâches plombantes. ${isLeader() ? 'Intercalez une tâche dynamisante ou déléguez-en une.' : 'Reportez-en une sur une autre matinée ou intercalez une tâche dynamisante.'}`,
        actions: [{ label: 'Voir le jour', href: `#calendrier/jour/${toDateStr(d)}` }],
      });
    }
  }

  return out;
}
