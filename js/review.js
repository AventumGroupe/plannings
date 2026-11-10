// Revue de la semaine (le vendredi) : bilan, ce qui a glissé, délégations en attente, semaine prochaine.

import { db, tasks, putTask, removeTask, save, local, score, category, catInfo, people, spentOf, ENERGY, isLeader } from './store.js';
import { analyze, setSpan, propagate, proposeSlot } from './sched.js';
import { delegateTo, waiting, nudgeHref, recordNudge } from './delegation.js';
import { focusStats } from './focus.js';
import { openDialog, toast, ring } from './ui.js';
import { esc, icon, fmt, cap, startOfDay, addDays, addMinutes, toDateStr, fmtDuration, MIN } from './util.js';

const weekStart = (d = new Date()) => { const x = startOfDay(d); const k = (x.getDay() + 6) % 7; return addDays(x, -k); };
const weekKey = () => toDateStr(weekStart());

/** La revue est-elle à faire ? (dernier jour travaillé de la semaine, à partir de 14 h, pas encore faite) */
export function reviewDue(now = new Date()) {
  const wd = db.settings.workDays;
  const last = Math.max(...wd.map((d) => (d + 6) % 7)); // lundi = 0
  const today = (now.getDay() + 6) % 7;
  if (local.get('lastReview', '') === weekKey()) return false;
  return today > last || (today === last && now.getHours() >= 14);
}

function data() {
  const ws = weekStart().getTime(), we = addDays(weekStart(), 7).getTime();
  const an = analyze();
  const all = tasks();
  const done = all.filter((t) => t.status === 'done' && t.doneAt >= ws && t.doneAt < we);
  const open = all.filter((t) => t.status !== 'done');
  const today = toDateStr(new Date());
  const slipped = open.filter((t) => !t.delegate && (t.slips > 0 || t.overrun || an[t.id]?.late || (t.due && t.due < today)))
    .sort((a, b) => score(b) - score(a));
  const nextMon = addDays(weekStart(), 7);
  const nextEnd = addDays(nextMon, 7);
  const plannedNext = open.filter((t) => t.start && new Date(t.start) >= nextMon && new Date(t.start) < nextEnd);
  const candidates = open.filter((t) => !t.start && !t.delegate && !slipped.includes(t) && ['priorite', 'planifier', 'deleguer', 'collaborer'].includes(category(t)))
    .sort((a, b) => score(b) - score(a)).slice(0, 8);
  const stale = open.filter((t) => category(t) === 'reste' && !t.start && Date.now() - (t.createdAt || Date.now()) > 30 * 864e5).slice(0, 6);
  // estimé / réel sur les tâches finies avec du temps saisi
  const measured = done.filter((t) => t.estimate && spentOf(t) > 0);
  const est = measured.reduce((m, t) => m + t.estimate, 0), real = measured.reduce((m, t) => m + spentOf(t), 0);
  const fs = focusStats();
  let sessions = 0;
  for (let d = weekStart(); d < addDays(weekStart(), 7); d = addDays(d, 1)) sessions += fs.days[toDateStr(d)] || 0;
  return { done, slipped, plannedNext, candidates, stale, est, real, measured, sessions, streak: fs.streak, nextMon };
}

const STEPS = ['Bilan', 'Ce qui a glissé', 'En attente', 'Semaine prochaine', 'C’est fini'];

export function openReview() {
  let step = 0;
  const D = data();
  const pick = new Set(D.candidates.slice(0, 3).map((t) => t.id));

  const bilan = () => {
    const ratio = D.est ? D.real / D.est : null;
    return `<div class="rv-kpis">
        <div class="rv-kpi"><b>${D.done.length}</b><small>tâche${D.done.length > 1 ? 's' : ''} terminée${D.done.length > 1 ? 's' : ''}</small></div>
        <div class="rv-kpi"><b>${D.sessions}</b><small>séance${D.sessions > 1 ? 's' : ''} de concentration</small></div>
        <div class="rv-kpi"><b>${icon('flame', 18)} ${D.streak}</b><small>jour${D.streak > 1 ? 's' : ''} d’affilée</small></div>
      </div>
      ${ratio ? `<p class="rv-ratio ${ratio > 1.25 ? 'warn' : ''}">Temps réel / temps estimé : <b>${Math.round(ratio * 100)} %</b> sur ${D.measured.length} tâche(s).
        ${ratio > 1.25 ? 'Vos estimations sont optimistes : ajoutez une marge d’environ ' + Math.round((ratio - 1) * 100) + ' %.' : ratio < 0.8 ? 'Vous estimez large : vous pouvez prévoir plus serré.' : 'Vos estimations sont justes, bravo.'}</p>` : ''}
      ${D.done.length ? `<ul class="rv-list done">${D.done.slice(0, 12).map((t) => `<li>✓ ${esc(t.title)}</li>`).join('')}${D.done.length > 12 ? `<li class="muted">+ ${D.done.length - 12} autre(s)</li>` : ''}</ul>`
        : '<p class="muted">Aucune tâche terminée cette semaine. On repart du bon pied la semaine prochaine.</p>'}`;
  };

  const slippedHtml = () => D.slipped.length ? `<p class="hint">Pour chacune : on replanifie, on confie, ou on abandonne.</p>
    <ul class="rv-rows">${D.slipped.map((t) => `<li data-rv="${t.id}" class="${t._rv ? 'handled' : ''}">
      <div><b>${esc(t.title)}</b><small>${[t.slips ? `reportée ×${t.slips}` : '', t.overrun ? 'temps dépassé' : '', t.due ? `échéance ${fmt.dateShort.format(new Date(t.due + 'T00:00'))}` : ''].filter(Boolean).join(' · ')}</small></div>
      ${t._rv ? `<span class="badge accent">${esc(t._rv)}</span>` : `<span class="rv-acts">
        <button class="btn sm primary" data-rva="plan">Semaine prochaine</button>
        ${isLeader() && people().length ? `<select class="sm" data-rvdel><option value="">Confier…</option>${people().map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>` : ''}
        <button class="btn sm ghost danger-text" data-rva="drop">Abandonner</button></span>`}
    </li>`).join('')}</ul>` : '<p class="ok-msg">Rien n’a glissé cette semaine. Excellent !</p>';

  const waitHtml = () => {
    const w = waiting();
    return w.length ? `<ul class="rv-rows">${w.map((t) => `<li class="${(t.followUp || '9') <= toDateStr(new Date()) ? 'late' : ''}">
      <div><b>${esc(t.title)}</b><small>${esc(db.resources[t.delegate]?.name || '')}${t.followUp ? ` · retour ${fmt.dateShort.format(new Date(t.followUp + 'T00:00'))}` : ''}</small></div>
      <span class="rv-acts"><a class="btn sm" href="${nudgeHref(t)}" data-rvnudge="${t.id}">${icon('bell', 14)} Relancer</a><button class="btn sm ghost" data-rvrecv="${t.id}">${icon('check', 14)} Reçu</button></span>
    </li>`).join('')}</ul>` : '<p class="muted">Aucune délégation en attente.</p>';
  };

  const nextHtml = () => `
    <p class="hint">Cochez les 3 à 5 tâches qui comptent vraiment la semaine prochaine : elles seront placées sur des créneaux libres (plombantes le matin).</p>
    ${D.plannedNext.length ? `<p class="muted sm">${D.plannedNext.length} tâche(s) déjà prévue(s) la semaine prochaine.</p>` : ''}
    ${D.candidates.length ? `<ul class="rv-rows pick">${D.candidates.map((t) => `<li><label><input type="checkbox" data-pick="${t.id}" ${pick.has(t.id) ? 'checked' : ''}>
      <span><b>${esc(t.title)}</b><small>${esc(catInfo(category(t)).label)} · ${esc(ENERGY[t.energy].label)} · ${fmtDuration(t.estimate || 60)}</small></span></label></li>`).join('')}</ul>` : '<p class="muted">Pas de tâche importante en attente de planification.</p>'}
    ${D.stale.length ? `<details class="rv-stale"><summary>${D.stale.length} tâche(s) du « reste » qui traînent depuis plus d’un mois</summary>
      <ul class="rv-rows">${D.stale.map((t) => `<li data-rv="${t.id}" class="${t._rv ? 'handled' : ''}"><div><b>${esc(t.title)}</b></div>${t._rv ? `<span class="badge accent">${esc(t._rv)}</span>` : `<button class="btn sm ghost danger-text" data-rva="drop">Supprimer</button>`}</li>`).join('')}</ul></details>` : ''}`;

  const endHtml = () => `<div class="rv-end"><div class="big-tom"><span>🎉</span></div><h3>Semaine bouclée !</h3>
    <p>Votre semaine prochaine est prête. Bon week-end, déconnectez vraiment : c’est aussi ça, la performance.</p></div>`;

  const body = () => `<div class="rv-steps">${STEPS.map((s, i) => `<span class="${i === step ? 'on' : i < step ? 'ok' : ''}">${i < step ? '✓' : i + 1}<small>${s}</small></span>`).join('')}</div>
    <div class="rv-body">${[bilan, slippedHtml, waitHtml, nextHtml, endHtml][step]()}</div>`;
  const footer = () => `${step > 0 && step < 4 ? '<button type="button" class="btn ghost" data-rvprev>Retour</button>' : ''}<span class="spacer"></span>
    <button type="button" class="btn primary" data-rvnext>${step === 3 ? 'Planifier et terminer' : step === 4 ? 'Fermer' : 'Suivant'}</button>`;

  const { el, close } = openDialog({ title: 'Revue de la semaine', body: body(), footer: footer(), wide: true });
  const refresh = () => { el.querySelector('.sheet-body').innerHTML = body(); el.querySelector('.sheet-foot, footer').innerHTML = footer(); };

  const placeNextWeek = (t) => {
    const slot = proposeSlot(t, { morning: t.energy <= 2, fromDay: D.nextMon, days: 5 });
    if (!slot) return false;
    t.allDay = false; setSpan(t, slot, addMinutes(slot, Math.min(t.estimate || 60, 240))); putTask(t, { silent: true }); propagate([t.id]);
    return slot;
  };

  el.addEventListener('change', (e) => {
    const c = e.target.closest('[data-pick]');
    if (c) { if (c.checked) pick.add(c.dataset.pick); else pick.delete(c.dataset.pick); return; }
    const s = e.target.closest('[data-rvdel]');
    if (s && s.value) { const t = db.tasks[s.closest('[data-rv]').dataset.rv]; delegateTo(t, s.value); t._rv = `Confiée à ${db.resources[s.value].name}`; refresh(); }
  });
  el.addEventListener('click', (e) => {
    const q = (sel) => e.target.closest(sel);
    const a = q('[data-rva]');
    if (a) {
      const t = db.tasks[a.closest('[data-rv]').dataset.rv];
      if (a.dataset.rva === 'drop') { removeTask(t.id); t._rv = 'Abandonnée'; }
      if (a.dataset.rva === 'plan') { const s = placeNextWeek(t); t._rv = s ? cap(fmt.dayShort.format(s)) + ' ' + fmt.time.format(s) : 'Pas de créneau libre'; save('review'); }
      refresh(); return;
    }
    const n = q('[data-rvnudge]'); if (n) { recordNudge(db.tasks[n.dataset.rvnudge]); return; }
    const r = q('[data-rvrecv]'); if (r) { const t = db.tasks[r.dataset.rvrecv]; t.status = 'done'; t.doneAt = Date.now(); putTask(t); refresh(); return; }
    if (q('[data-rvprev]')) { step--; refresh(); return; }
    if (q('[data-rvnext]')) {
      if (step === 3) {
        let ok = 0;
        for (const id of pick) if (db.tasks[id] && placeNextWeek(db.tasks[id])) ok++;
        save('review');
        local.set('lastReview', weekKey());
        if (ok) toast(`${ok} tâche(s) placée(s) la semaine prochaine.`);
      }
      if (step === 4) { close(); return; }
      step++; refresh();
    }
  });
}
