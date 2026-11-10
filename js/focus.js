// Minuteur de concentration ludique : séance (25 min plombante / 50 min sinon, selon les réglages),
// pause, temps passé enregistré automatiquement dans les sous-tâches, tomates, série de jours et badges.
// L'état est conservé : on peut changer d'onglet ou recharger, le minuteur continue (pastille flottante).

import { db, putTask, local, ENERGY, spentOf, remainingOf } from './store.js';
import { sessionOf } from './advice.js';
import { toast } from './ui.js';
import { refreshNative } from './notify.js';
import { esc, icon, uid, fmtDuration, toDateStr, addDays, MIN } from './util.js';

const R = 110, C = 2 * Math.PI * R;
let tick = null, wake = null, root = null;

const state = () => local.get('focus', null);
const setState = (s) => { local.set('focus', s); refreshNative(true); };
const stats = () => Object.assign({ total: 0, minutes: 0, days: {}, badges: [] }, local.get('focusStats', {}));

const PHRASES = [
  'Une chose à la fois. Le reste attendra.', 'Téléphone retourné, notifications coupées.', 'Commencez petit : la première minute est la plus dure.',
  'Pas besoin que ce soit parfait, juste avancé.', 'Respirez, et lancez-vous.', 'Votre futur vous remercie déjà.',
];
const CHEERS = ['Bravo !', 'Bien joué !', 'Et une de plus !', 'Superbe concentration !', 'Ça avance !', 'Chapeau !'];

const BADGES = [
  { id: 'first', label: 'Premier pas', test: (s) => s.total >= 1, ico: '🌱' },
  { id: 'day4', label: 'Journée pleine (4 séances)', test: (s) => (s.days[toDateStr(new Date())] || 0) >= 4, ico: '🔥' },
  { id: 'streak3', label: '3 jours d’affilée', test: (s) => streak(s) >= 3, ico: '⭐' },
  { id: 'streak5', label: 'Semaine complète', test: (s) => streak(s) >= 5, ico: '🏅' },
  { id: 'streak10', label: '10 jours d’affilée', test: (s) => streak(s) >= 10, ico: '🏆' },
  { id: 'n10', label: '10 séances', test: (s) => s.total >= 10, ico: '🍅' },
  { id: 'n50', label: '50 séances', test: (s) => s.total >= 50, ico: '🚀' },
  { id: 'h10', label: '10 heures de concentration', test: (s) => s.minutes >= 600, ico: '💎' },
];

/** Série : jours travaillés consécutifs (jusqu'à aujourd'hui ou hier) avec au moins une séance. */
export function streak(s = stats()) {
  let d = new Date(), n = 0;
  if (!s.days[toDateStr(d)]) d = addDays(d, -1);
  for (let guard = 0; guard < 400; guard++) {
    const k = toDateStr(d);
    if (s.days[k]) n++;
    else if (db.settings.workDays.includes(d.getDay())) break;
    d = addDays(d, -1);
  }
  return n;
}

function remainingMs(s) {
  const paused = s.pausedAt ? Date.now() - s.pausedAt : 0;
  return s.dur * MIN - (Date.now() - s.start - (s.pausedTotal || 0) - paused);
}
const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

/** Lance une séance sur une tâche. */
export function startFocus(t, { dur } = {}) {
  if (!t) return;
  const cur = state();
  if (cur && cur.mode === 'work' && cur.taskId !== t.id && remainingMs(cur) > 0) {
    toast('Une séance est déjà en cours.'); open(); return;
  }
  const d = dur || Math.max(5, Math.min(sessionOf(t), remainingOf(t) || sessionOf(t)));
  const sub = (t.subtasks || []).find((x) => !x.done);
  setState({ mode: 'work', taskId: t.id, subId: sub ? sub.id : '', start: Date.now(), dur: d, pausedTotal: 0, pausedAt: null, phrase: PHRASES[Math.floor(Math.random() * PHRASES.length)] });
  if (t.status === 'todo') { t.status = 'doing'; putTask(t, { silent: true }); }
  open();
}

function open() {
  if (!root) { root = document.createElement('div'); root.className = 'focus-root'; document.body.appendChild(root); bind(); }
  root.classList.remove('mini');
  render();
  run();
}

function run() {
  clearInterval(tick);
  tick = setInterval(update, 500);
  update();
  keepAwake(true);
}

function stop() { clearInterval(tick); tick = null; keepAwake(false); }

async function keepAwake(on) {
  try {
    if (on && !wake && navigator.wakeLock) wake = await navigator.wakeLock.request('screen');
    if (!on && wake) { await wake.release(); wake = null; }
  } catch { /* non disponible */ }
}

function render() {
  const s = state();
  if (!s) { root?.remove(); root = null; stop(); return; }
  const t = db.tasks[s.taskId];
  if (!t) { setState(null); render(); return; }
  const st = stats(), today = st.days[toDateStr(new Date())] || 0;
  if (s.mode === 'done') { root.innerHTML = doneHtml(s, t, st); return; }
  const brk = s.mode === 'break';
  const subs = (t.subtasks || []).filter((x) => !x.done);
  root.innerHTML = `
    <div class="focus ${brk ? 'brk' : 'e' + t.energy} ${s.pausedAt ? 'paused' : ''}">
      <header class="focus-top">
        <span class="tomatoes" title="Séances aujourd’hui">${'<i class="tom"></i>'.repeat(Math.min(today, 8))}${today > 8 ? `<b>+${today - 8}</b>` : ''}${today ? '' : '<small>Première séance du jour</small>'}</span>
        <span class="streak" title="Jours d’affilée">${icon('flame', 16)} ${streak(st)}</span>
        <button class="icon-btn" data-fmin title="Réduire" aria-label="Réduire">${icon('chevR', 20)}</button>
      </header>
      <div class="focus-mid">
        <p class="focus-kind">${brk ? 'Pause' : esc(ENERGY[t.energy].label)}</p>
        <h2 class="focus-title">${brk ? 'Levez-vous, respirez, buvez un verre d’eau.' : esc(t.title)}</h2>
        <div class="focus-dial">
          <svg viewBox="0 0 260 260"><circle class="trk" cx="130" cy="130" r="${R}"/><circle class="arc" cx="130" cy="130" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="0" transform="rotate(-90 130 130)"/></svg>
          <div class="focus-time"><b data-ftime>${mmss(remainingMs(s))}</b><small>${brk ? 'avant de reprendre' : `sur ${fmtDuration(s.dur)}`}</small></div>
        </div>
        ${!brk && subs.length ? `<label class="focus-sub"><span>Sur</span><select data-fsub><option value="">la tâche en général</option>${subs.map((x) => `<option value="${x.id}" ${x.id === s.subId ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>` : ''}
        <p class="focus-phrase">${brk ? 'Le cerveau consolide pendant la pause.' : esc(s.phrase)}</p>
      </div>
      <footer class="focus-acts">
        ${brk ? `<button class="btn ghost" data-fskip>Reprendre maintenant</button><button class="btn" data-fclose>Terminer</button>`
          : `<button class="btn ghost" data-fplus>+5 min</button>
             <button class="btn primary big" data-fpause>${s.pausedAt ? icon('play', 20) + ' Reprendre' : icon('pause', 20) + ' Pause'}</button>
             <button class="btn ghost" data-fend>J’ai fini</button>`}
        <button class="link danger-text" data-fquit>${brk ? '' : 'Abandonner'}</button>
      </footer>
    </div>`;
  update();
}

function doneHtml(s, t, st) {
  const newB = s.newBadges || [];
  return `<div class="focus done">
    <div class="confetti">${Array.from({ length: 36 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 0.12}s;--h:${(i * 47) % 360}"></i>`).join('')}</div>
    <div class="focus-mid">
      <div class="big-tom"><i class="tom xl"></i><b>+1</b></div>
      <h2>${esc(s.cheer || 'Bravo !')}</h2>
      <p>${fmtDuration(s.logged)} enregistrées sur « ${esc(t.title)} »${s.subTitle ? ` (${esc(s.subTitle)})` : ''}.</p>
      <p class="muted">${st.days[toDateStr(new Date())] || 0} séance(s) aujourd’hui · série de ${streak(st)} jour(s) · ${fmtDuration(Math.max(0, remainingOf(t)))} restantes sur la tâche</p>
      ${newB.length ? `<div class="badges-new">${newB.map((b) => `<span class="badge-pop"><i>${b.ico}</i>${esc(b.label)}</span>`).join('')}</div>` : ''}
    </div>
    <footer class="focus-acts col">
      <button class="btn primary big" data-fbreak>Pause de ${db.settings.breakMin || 5} min</button>
      <div class="row gap-sm"><button class="btn" data-fagain>Encore une séance</button><button class="btn" data-fdone>${icon('check', 16)} Tâche terminée</button></div>
      <button class="link" data-fclose>Fermer</button>
    </footer>
  </div>`;
}

function update() {
  const s = state();
  if (!s || !root) return;
  if (s.mode === 'done') return;
  const ms = remainingMs(s);
  const el = root.querySelector('[data-ftime]');
  if (el) el.textContent = mmss(ms);
  const arc = root.querySelector('.arc');
  if (arc) arc.setAttribute('stroke-dashoffset', String(C * (1 - Math.max(0, ms) / (s.dur * MIN))));
  const pill = root.querySelector('[data-pill]');
  if (pill) pill.textContent = mmss(ms);
  document.title = root.classList.contains('mini') ? `${mmss(ms)} · Plannings` : document.title.replace(/^\d\d:\d\d · /, '');
  if (ms <= 0 && !s.pausedAt) {
    if (s.mode === 'work') finishWork(s.dur);
    else { buzz([200, 100, 200]); setState(null); stop(); document.title = 'Gestion des plannings'; root?.remove(); root = null; toast('Fin de la pause : on s’y remet ?'); }
  }
}

function buzz(p = [300, 150, 300, 150, 300]) {
  try { navigator.vibrate?.(p); } catch { /* */ }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18, 0.36].forEach((d, i) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = [660, 880, 990][i]; g.gain.setValueAtTime(0.0001, ctx.currentTime + d); g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + d + 0.16); o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + d); o.stop(ctx.currentTime + d + 0.18); });
  } catch { /* */ }
}

/** Enregistre le temps passé et passe à l'écran de fin. */
function finishWork(minutes) {
  const s = state(), t = db.tasks[s.taskId];
  const m = Math.max(1, Math.round(minutes));
  let subTitle = '';
  if (t) {
    t.subtasks = t.subtasks || [];
    const sub = s.subId && t.subtasks.find((x) => x.id === s.subId);
    if (sub) { sub.spent = (Number(sub.spent) || 0) + m; subTitle = sub.title; }
    else t.subtasks.push({ id: uid(), title: `Séance de concentration du ${new Date().toLocaleDateString('fr-FR')}`, done: true, spent: m, doneAt: Date.now() });
    if (t.status === 'todo') t.status = 'doing';
    putTask(t);
  }
  const st = stats(), k = toDateStr(new Date());
  st.total++; st.minutes += m; st.days[k] = (st.days[k] || 0) + 1;
  const newBadges = BADGES.filter((b) => !st.badges.includes(b.id) && b.test(st));
  st.badges.push(...newBadges.map((b) => b.id));
  local.set('focusStats', st);
  setState({ ...s, mode: 'done', logged: m, subTitle, newBadges: newBadges.map(({ label, ico }) => ({ label, ico })), cheer: CHEERS[Math.floor(Math.random() * CHEERS.length)] });
  buzz(); stop(); document.title = 'Gestion des plannings';
  if (root) { root.classList.remove('mini'); render(); }
}

function bind() {
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-fsub]')) { const s = state(); s.subId = e.target.value; setState(s); }
  });
  root.addEventListener('click', async (e) => {
    const s = state(); if (!s) return;
    const t = db.tasks[s.taskId];
    const q = (sel) => e.target.closest(sel);
    if (q('[data-fmin]')) { root.classList.add('mini'); root.innerHTML = `<button class="focus-pill ${s.mode === 'break' ? 'brk' : ''}" data-fopen>${icon('flame', 16)}<b data-pill>${mmss(remainingMs(s))}</b></button>`; return; }
    if (q('[data-fopen]')) { root.classList.remove('mini'); render(); return; }
    if (q('[data-fpause]')) {
      if (s.pausedAt) { s.pausedTotal += Date.now() - s.pausedAt; s.pausedAt = null; } else s.pausedAt = Date.now();
      setState(s); render(); return;
    }
    if (q('[data-fplus]')) { s.dur += 5; setState(s); update(); root.querySelector('.focus-time small').textContent = `sur ${fmtDuration(s.dur)}`; return; }
    if (q('[data-fend]')) { const done = (s.dur * MIN - remainingMs(s)) / MIN; finishWork(Math.max(1, done)); return; }
    if (q('[data-fquit]')) { setState(null); render(); toast('Séance abandonnée, rien n’a été enregistré.'); return; }
    if (q('[data-fbreak]')) { setState({ ...s, mode: 'break', start: Date.now(), dur: db.settings.breakMin || 5, pausedTotal: 0, pausedAt: null }); render(); run(); return; }
    if (q('[data-fskip]')) { setState(null); render(); if (t) startFocus(t); return; }
    if (q('[data-fagain]')) { setState(null); if (t) startFocus(t); return; }
    if (q('[data-fdone]')) {
      setState(null); render();
      if (t) { const { toggleDone } = await import('./list.js'); toggleDone(t); }
      return;
    }
    if (q('[data-fclose]')) {
      setState(null); render();
      if (t && t.estimate && spentOf(t) >= t.estimate && t.status !== 'done') { const { askOverrun } = await import('./editor.js'); askOverrun(t.id); }
    }
  });
}

/** Au démarrage : reprend une séance en cours (après rechargement). */
export function resumeFocus() {
  const s = state();
  if (!s) return;
  if (s.mode === 'done') { setState(null); return; }
  if (!db.tasks[s.taskId]) { setState(null); return; }
  open();
  if (remainingMs(s) > 0) { root.classList.add('mini'); root.innerHTML = `<button class="focus-pill ${s.mode === 'break' ? 'brk' : ''}" data-fopen>${icon('flame', 16)}<b data-pill>${mmss(remainingMs(s))}</b></button>`; }
}

/** Statistiques de concentration (pour la revue de la semaine). */
export function focusStats() { const s = stats(); return { ...s, streak: streak(s), badgesAll: BADGES.map((b) => ({ ...b, got: s.badges.includes(b.id) })) }; }
