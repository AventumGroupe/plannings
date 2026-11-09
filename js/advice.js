// Préconisations par tâche : urgence × importance × énergie × durée (+ récurrence, profil).
// Sources validées : Covey (Eisenhower), Allen (GTD, règle des 2 min), Tracy (« avaler le crapaud »),
// Cirillo (Pomodoro), Kleitman / Ericsson (cycles 60-90 min, ~4 h/jour), Newport (Deep Work),
// Csikszentmihalyi (flow), Leroy (résidu attentionnel), Albulescu et al. (micro-pauses),
// Schmidt et al. / Pink (rythme de la journée), Loehr & Schwartz (énergie), Gollwitzer (intentions « si… alors… »).

import { db, tasks, newTask, putTask, save, people, category, catInfo, isLeader } from './store.js';
import { proposeSlot, findFreeSlot, setSpan, tStart, tEnd, propagate, completeTask } from './sched.js';
import { esc, icon, fmt, cap, fmtDuration, addDays, addMinutes, startOfDay, MIN } from './util.js';

export const SOURCES = [
  ['Stephen Covey', '*Les 7 habitudes* (1989), *First Things First* (1994) — matrice urgent / important'],
  ['David Allen', '*Getting Things Done* (2001) — règle des 2 minutes, regrouper les petites tâches'],
  ['Brian Tracy', '*Avalez le crapaud* (2001) — la tâche pénible et importante en premier'],
  ['Francesco Cirillo', 'technique Pomodoro — 25 min de travail, 5 min de pause'],
  ['N. Kleitman ; K. A. Ericsson et al. (1993)', 'cycles d’attention de 60 à 90 min, ~4 h de travail profond par jour'],
  ['Cal Newport', '*Deep Work* (2016) — blocs concentrés, travail superficiel regroupé'],
  ['M. Csikszentmihalyi', '*Flow* (1990) — ne pas couper une tâche stimulante bien engagée'],
  ['Sophie Leroy (2009)', 'résidu attentionnel — le coût des changements de tâche'],
  ['Albulescu et al. (2022, PLOS ONE)', 'les micro-pauses réduisent la fatigue'],
  ['Schmidt, Collette et al. (2007) ; D. Pink, *When* (2018)', 'pic le matin, creux après le déjeuner'],
  ['Loehr & Schwartz (2003)', '*The Power of Full Engagement* — alterner effort et récupération'],
  ['P. Gollwitzer (1999)', 'intentions de mise en œuvre « si… alors… »'],
];
export const sourcesHtml = () => `<b>Sources de la méthode</b><br>${SOURCES.map(([a, b]) => `• <b>${esc(a)}</b> — ${esc(b).replace(/\*([^*]+)\*/g, '<i>$1</i>')}`).join('<br>')}<br><i>Écartée : « l’épuisement de la volonté » (Baumeister), non répliqué (Hagger et al., 2016).</i>`;

export const sessionOf = (t) => (t.energy <= 2 ? db.settings.sessionPlomb || 25 : db.settings.sessionDyn || 50);
const brk = () => db.settings.breakMin || 5;

/** Rythme conseillé pour une tâche. */
export function rhythmOf(t) {
  const d = t.estimate || 60, s = sessionOf(t), n = Math.max(1, Math.ceil(d / s));
  if (d <= 2) return { kind: 'now', n: 1, s: d, text: 'Moins de 2 minutes : faites-la tout de suite plutôt que de la planifier.', src: 'Allen' };
  if (d < 15) return { kind: 'small', n: 1, s: d, text: 'Petite tâche : regroupez-la avec d’autres dans un créneau « petites tâches », idéalement dans le creux de début d’après-midi.', src: 'Allen, Newport, Pink' };
  if (d <= s) return { kind: 'one', n: 1, s: d, text: `Une seule séance de ${fmtDuration(d)}.`, src: 'Cirillo' };
  return {
    kind: 'split', n, s,
    text: t.energy <= 2
      ? `${n} séances de ${s} min avec ${brk()} min de pause, 2 à 3 séances d’affilée au plus, de préférence sur plusieurs matinées.`
      : `${n} séances de ${s} min avec ${brk()} min de pause ; si vous êtes « dans le flow », prolongez jusqu’à 90 min.`,
    src: t.energy <= 2 ? 'Cirillo, Albulescu' : 'Kleitman, Csikszentmihalyi',
  };
}

/** Options de décision pour une tâche : [{ key, title, text, src, actions:[{label, act}] }] */
export function adviceFor(t) {
  const d = t.estimate || 60, plomb = t.energy <= 2, leader = isLeader();
  const cat = category(t), r = rhythmOf(t), long = r.kind === 'split';
  const team = people();
  const opts = [];
  const sessionsAct = { label: long ? `Planifier les ${r.n} séances` : 'Planifier', act: 'sessions' };
  const intent = `« Si c’est ${plomb ? `demain ${db.settings.dayStart} h` : 'l’heure prévue'}, alors je commence ${long ? 'la séance 1' : ''} de “${t.title}”, téléphone en silencieux. »`;
  const delegateActs = leader && team.length ? team.slice(0, 3).map((p) => ({ label: `Confier à ${p.name}`, act: `delegate:${p.id}` })) : [];
  const automate = {
    key: 'auto', title: 'Automatiser',
    text: leader
      ? `Modèle de document, réponse type, règle Outlook, Power Automate ou demande à Claude d’automatiser.${t.recur ? ' Tâche récurrente : candidate idéale.' : ''}`
      : `Proposer à votre responsable de l’automatiser (modèle, réponse type, Power Automate…).${t.recur ? ' Tâche récurrente : candidate idéale.' : ''}`,
    src: 'Loehr & Schwartz', actions: [{ label: t.automate ? 'Marquée « à automatiser » ✓' : leader ? 'Marquer « à automatiser »' : 'Marquer « à proposer »', act: 'automate' }],
  };

  if (r.kind === 'now') {
    return { r, cat, opts: [{ key: 'now', title: 'Le faire maintenant', text: 'Moins de 2 minutes : plus rapide que de la noter ou de la planifier.', src: 'Allen', actions: [{ label: 'C’est fait', act: 'done' }] }] };
  }

  if (cat === 'priorite') {
    opts.push({ key: 'do', title: 'Le faire en premier', text: `Bloquez le créneau aujourd’hui ou demain et protégez-le des interruptions.`, src: `Covey, ${r.src}, Leroy`, actions: [sessionsAct] });
    if (long) opts.push({ key: 'deep', title: 'Bloc de travail profond', text: 'Notifications coupées, une seule tâche, pause réelle entre les séances.', src: 'Newport', actions: [] });
  } else if (cat === 'deleguer') {
    opts.push({ key: 'force', title: 'Le faire quand même (pas le choix)', text: `Le matin, quand l’énergie est haute, puis enchaîner avec une tâche dynamisante. Engagement : ${intent}`, src: `Tracy, ${r.src}, Gollwitzer, Loehr & Schwartz`, actions: [sessionsAct] });
    opts.push(leader
      ? { key: 'deleg', title: 'Déléguer', text: 'Confier avec un objectif clair, une date de retour et un point d’étape. Vous gardez le contrôle du résultat.', src: 'Covey', actions: delegateActs.length ? delegateActs : [{ label: 'Ajouter une personne', act: 'people' }] }
      : { key: 'help', title: 'Demander un appui', text: 'Répartir avec un collègue ou signaler la charge à votre responsable pour arbitrer.', src: 'Covey', actions: [] });
    opts.push({ key: 'alt', title: 'Trouver une alternative', text: 'Négocier le délai, réduire le périmètre (80 % du résultat pour 20 % de l’effort), repartir d’un modèle existant.', src: 'Covey', actions: [] });
    opts.push(automate);
  } else if (cat === 'planifier') {
    opts.push({ key: 'plan', title: 'Planifier un bloc cette semaine', text: `C’est ici que se prépare l’avenir : réservez le créneau avant qu’il ne soit pris.`, src: `Covey, Newport, ${r.src}`, actions: [sessionsAct] });
  } else if (cat === 'collaborer') {
    opts.push({ key: 'calm', title: leader ? 'Planifier dans le temps' : 'Planifier au calme', text: `Étalez sur plusieurs matinées, jamais deux tâches plombantes d’affilée.`, src: `Cirillo, Albulescu, Pink`, actions: [{ ...sessionsAct, act: 'sessions-spread' }] });
    if (leader) opts.push({ key: 'deleg', title: 'Confier à un collaborateur', text: 'Avec une échéance et un point d’étape.', src: 'Covey', actions: delegateActs.length ? delegateActs : [{ label: 'Ajouter une personne', act: 'people' }] });
    opts.push({ key: 'alt', title: 'Trouver une alternative', text: 'Réduire le périmètre ou repartir d’un modèle.', src: 'Covey', actions: [] });
    if (t.recur || d >= 60) opts.push(automate);
  } else if (cat === 'cote') {
    opts.push(d <= 15
      ? { key: 'quick', title: 'Expédier ou refuser', text: 'Courte : traitez-la dans le créneau « petites tâches », ou refusez-la. Ne la laissez pas interrompre une séance.', src: 'Allen, Leroy', actions: [] }
      : { key: 'no', title: 'Refuser, reporter ou réduire', text: 'Urgente pour quelqu’un d’autre, peu importante pour vous : ne pas laisser l’urgence décider.', src: 'Covey', actions: [] });
    if (leader && team.length) opts.push({ key: 'deleg', title: 'Déléguer', text: 'Si elle doit vraiment être faite.', src: 'Covey', actions: delegateActs });
    if (t.recur) opts.push(automate);
  } else {
    opts.push({ key: 'drop', title: 'Faut-il vraiment le faire ?', text: plomb && d >= 60 ? 'Plombante, longue, ni urgente ni importante : candidate à l’abandon.' : 'Plus tard, dans un créneau libre ; revoir chaque semaine ce qui peut être supprimé.', src: 'Covey', actions: [] });
    if (t.recur) opts.push(automate);
  }
  if (r.kind === 'small' && !opts.some((o) => o.key === 'quick')) opts.push({ key: 'batch', title: 'Regrouper', text: r.text, src: r.src, actions: [{ label: 'Placer dans le creux de l’après-midi', act: 'batch' }] });
  return { r, cat, opts };
}

export function adviceHtml(t) {
  const { r, cat, opts } = adviceFor(t);
  return `
    <div class="adv">
      <div class="adv-head c-${cat}"><i class="grp-dot"></i><b>${esc(catInfo(cat).label)}</b><span>${esc(fmtDuration(t.estimate || 60))}</span></div>
      <p class="adv-rhythm">${icon('repeat', 14)} ${esc(r.text)} <small>(${esc(r.src)})</small></p>
      <ol class="adv-opts">${opts.map((o) => `
        <li><b>${esc(o.title)}</b><p>${esc(o.text)}</p><small class="muted">Source : ${esc(o.src)}</small>
          ${o.actions.length ? `<div class="adv-acts">${o.actions.map((a) => `<button type="button" class="btn sm ${a.act.startsWith('delegate') || a.act === 'sessions' || a.act === 'sessions-spread' ? 'primary' : 'ghost'}" data-adv="${esc(a.act)}">${esc(a.label)}</button>`).join('')}</div>` : ''}
        </li>`).join('')}
      </ol>
    </div>`;
}

/** Exécute une action de préconisation sur une tâche enregistrée. Retourne un message. */
export function runAdvice(t, act) {
  if (!t) return '';
  if (act === 'done') { completeTask(t); save('advice'); return 'Bravo, c’est fait !'; }
  if (act === 'automate') { t.automate = !t.automate; putTask(t); return t.automate ? 'Marquée « à automatiser ».' : 'Marque retirée.'; }
  if (act.startsWith('delegate:')) { t.delegate = act.slice(9); putTask(t); return `Confiée à ${db.resources[t.delegate]?.name || ''}.`; }
  if (act === 'people') { location.hash = '#ressources'; return ''; }
  if (act === 'batch') return batchSmall([t]);
  if (act === 'sessions' || act === 'sessions-spread') return planSessions(t, { spread: act === 'sessions-spread' });
  return '';
}

/** Place des petites tâches à la suite dans le creux de début d'après-midi du prochain jour ouvré. */
export function batchSmall(list) {
  const S = db.settings;
  let placed = 0, first = null;
  for (let i = 0; i < 10 && placed < list.length; i++) {
    const day = addDays(startOfDay(new Date()), i);
    if (!S.workDays.includes(day.getDay())) continue;
    for (const t of list.slice(placed)) {
      const slot = findFreeSlot(day, t.estimate || 10, Math.max(S.morningEnd + 1, 13.5), Math.min(S.dayEnd, 16), t.id);
      if (!slot) break;
      t.allDay = false; setSpan(t, slot, addMinutes(slot, t.estimate || 10)); putTask(t, { silent: true });
      first = first || slot; placed++;
    }
  }
  save('advice');
  return placed ? `${placed} petite(s) tâche(s) regroupée(s) ${cap(fmt.dayShort.format(first))} à ${fmt.time.format(first)}.` : 'Aucun créneau libre trouvé en début d’après-midi.';
}

/**
 * Découpe une tâche longue en séances (25 min si plombante, 50 min sinon) liées entre elles,
 * planifiées sur des créneaux libres : plombantes le matin, 2 séances d'affilée au plus,
 * ou une par jour si « spread ».
 */
export function planSessions(t, { spread = false } = {}) {
  const S = db.settings;
  const plomb = t.energy <= 2;
  const s = sessionOf(t), total = t.estimate || 60, n = Math.max(1, Math.ceil(total / s));
  const place = (task, from, sameDayAfter) => {
    let slot = null;
    if (sameDayAfter) {
      const h = sameDayAfter.getHours() + sameDayAfter.getMinutes() / 60;
      slot = findFreeSlot(sameDayAfter, task.estimate, h, plomb ? Math.max(S.morningEnd, h + task.estimate / 60) : S.dayEnd, task.id);
    }
    if (!slot) slot = proposeSlot(task, { morning: plomb, fromDay: from });
    if (!slot) return null;
    task.allDay = false; setSpan(task, slot, addMinutes(slot, task.estimate)); putTask(task, { silent: true });
    return slot;
  };
  if (n === 1) {
    const slot = place(t, new Date(), null);
    save('advice');
    return slot ? `Planifiée ${cap(fmt.dayShort.format(slot))} à ${fmt.time.format(slot)}.` : 'Aucun créneau libre trouvé.';
  }
  const base = t.title.replace(/\s*\(séance \d+\/\d+\)$/, '');
  t.title = `${base} (séance 1/${n})`;
  t.estimate = s;
  let prev = t, run = 1;
  const first = place(t, new Date(), null);
  if (!first) { save('advice'); return 'Aucun créneau libre trouvé.'; }
  for (let k = 2; k <= n; k++) {
    const c = newTask({
      title: `${base} (séance ${k}/${n})`, urgency: t.urgency, importance: t.importance, energy: t.energy,
      projectId: t.projectId, estimate: Math.min(s, total - s * (k - 1)), due: t.due, delegate: t.delegate,
      reminder: t.reminder, preds: [{ id: prev.id, lag: 0 }], notes: t.notes,
    });
    putTask(c, { silent: true });
    const pe = tEnd(prev);
    const nextDay = addDays(startOfDay(pe), 1);
    const sameDay = !spread && !(plomb && run >= 2) ? addMinutes(pe, brk()) : null;
    const slot = place(c, sameDay ? pe : nextDay, sameDay);
    run = slot && sameDay && slot.toDateString() === pe.toDateString() ? run + 1 : 1;
    prev = c;
  }
  propagate([t.id]);
  save('advice');
  return `${n} séances de ${s} min planifiées à partir de ${cap(fmt.dayShort.format(first))} ${fmt.time.format(first)}.`;
}
