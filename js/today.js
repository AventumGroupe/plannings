// Onglet « Ma journée » : énergie du moment, la tâche à faire maintenant,
// le déroulé de la journée (rendez-vous Outlook + tâches) et une proposition de journée en un clic.

import { db, tasks, putTask, save, local, outlookEvents, ownAbsentOn, rhEvents, score, category, catInfo, ENERGY, remainingOf, progressOf, needsDecision, isDeferred, effUrgency, quickWin, uiScore, emScore, DECISIONS } from './store.js';
import { proposeSlot } from './sched.js';
import { toDecideCount } from './decision.js';
import { waitingHtml, recordNudge } from './delegation.js';
import { scoreBadges } from './ui.js';
import { isConnected as msConnected } from './outlook.js';
import { ghConfigured } from './github.js';
import { tStart, tEnd, setSpan, busyOn, propagate, analyze } from './sched.js';
import { sessionOf } from './advice.js';
import { reviewDue } from './review.js';
import { openTaskEditor } from './editor.js';
import { slider, bindSliders, info, toast, ring, openDialog } from './ui.js';
import { esc, icon, fmt, cap, parse, startOfDay, addDays, addMinutes, roundUp, toDateStr, fmtDuration, MIN } from './util.js';

const todayStr = () => toDateStr(new Date());
let skip = 0; // « Autre idée » : on passe à la suivante

/** Énergie du moment (saisie du jour, sinon estimation selon l'heure). */
export function energyNow() {
  const e = local.get('energyNow', null);
  if (e && e.date === todayStr()) return e.v;
  const h = new Date().getHours();
  return h < db.settings.morningEnd ? 3 : h < 15 ? 2 : 3;
}
const setEnergyNow = (v) => local.set('energyNow', { date: todayStr(), v });

const isLaterSession = (t) => /\(séance (?:[2-9]|\d{2,})\/\d+\)$/.test(t.title);

/** Tâches classées pour « maintenant » selon l'énergie du moment. */
export function nowCandidates(e = energyNow()) {
  const now = new Date(), end = addDays(startOfDay(now), 1);
  const an = analyze();
  return tasks().filter((t) => t.status !== 'done' && !t.delegate && !isLaterSession(t) && !needsDecision(t) && !isDeferred(t) && !['plustard', 'reporter'].includes(t.decision?.key)
    && (!t.start || (tStart(t) < end && (!t.allDay || tStart(t) <= now))))
    .map((t) => {
      let s = score(t) * 2;
      if (t.start && !t.allDay && tStart(t) <= now && tEnd(t) > now) s += 100;          // prévue maintenant
      else if (t.start && !t.allDay && tStart(t) > now) s -= 12;                        // prévue plus tard dans la journée
      if (an[t.id]?.late) s += 6;
      if (t.due && t.due <= todayStr()) s += 8;
      if (e >= 3 && t.energy <= 2) s += 8;                                              // en forme : attaquer le difficile
      if (e <= 2 && t.energy >= 3) s += 8;                                              // fatigué : du dynamisant
      if (e <= 2 && t.energy <= 2) s -= 6;
      if (e <= 2 && (remainingOf(t) || t.estimate || 60) <= 15) s += 3;                 // ou du rapide
      if (t.status === 'doing') s += 4;
      return { t, s };
    })
    .sort((a, b) => b.s - a.s).map((x) => x.t);
}

function whyNow(t, e) {
  const now = new Date();
  if (t.start && !t.allDay && tStart(t) <= now && tEnd(t) > now) return 'Prévue maintenant dans votre planning.';
  if (e >= 3 && t.energy <= 2) return 'Vous êtes en forme : c’est le bon moment pour une tâche plombante.';
  if (e <= 2 && t.energy >= 3) return 'Énergie basse : une tâche dynamisante pour relancer la machine.';
  if (e <= 2 && (t.estimate || 60) <= 15) return 'Énergie basse : une tâche rapide, vite réglée.';
  return 'La plus prioritaire pour l’instant.';
}

/** Blocs de la journée : rendez-vous Outlook et tâches à heure fixe. */
function dayBlocks(day = new Date()) {
  const ds = startOfDay(day), de = addDays(ds, 1);
  const out = [];
  for (const t of tasks()) {
    if (!t.start || t.allDay) continue;
    const s = tStart(t), e = tEnd(t);
    if (s < de && e > ds) out.push({ kind: 'task', s, e, t });
  }
  for (const ev of outlookEvents()) {
    if (ev.isAllDay) continue;
    const s = parse(ev.start), e = parse(ev.end);
    if (s < de && e > ds) out.push({ kind: 'event', s, e, ev });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Créneaux libres restants aujourd'hui (≥ 15 min). */
function freeGaps(day = new Date()) {
  const S = db.settings, now = new Date();
  let x = startOfDay(day); x.setHours(S.dayStart, 0, 0, 0);
  const lim = startOfDay(day); lim.setHours(S.dayEnd, 0, 0, 0);
  if (x < now) x = roundUp(now, 5);
  const gaps = [];
  for (const [s, e] of busyOn(day)) {
    if (e <= x) continue;
    if (s > x) gaps.push([x, s < lim ? s : lim]);
    if (e > x) x = e;
    if (x >= lim) break;
  }
  if (x < lim) gaps.push([x, lim]);
  return gaps.filter(([s, e]) => (e - s) / MIN >= 15);
}

/** Proposition de journée : remplit les créneaux libres, plombantes le matin, dynamisantes ensuite. */
export function proposeDay() {
  const S = db.settings, brk = S.breakMin ?? 5;
  const pool = tasks().filter((t) => t.status !== 'done' && !t.start && !t.delegate && !t.automate && !isLaterSession(t) && !needsDecision(t) && !isDeferred(t) && ['prioriser', 'planifier', 'expedier', 'decouper', 'regrouper'].includes(t.decision?.key))
    .sort((a, b) => score(b) - score(a));
  const used = new Set(), out = [];
  let plombMin = 0, lastPlomb = false;
  for (const [gs, ge] of freeGaps()) {
    let x = new Date(gs);
    while (true) {
      const left = (ge - x) / MIN;
      if (left < 15) break;
      const morning = x.getHours() < S.morningEnd;
      const fits = (t) => !used.has(t.id) && Math.min(remainingOf(t) || t.estimate || 60, sessionOf(t)) <= left;
      const plombOk = (t) => t.energy <= 2 && !lastPlomb && plombMin + Math.min(remainingOf(t) || 60, sessionOf(t)) <= 150;
      const pick = (morning ? pool.find((t) => fits(t) && plombOk(t)) : null)
        || pool.find((t) => fits(t) && t.energy >= 3)
        || pool.find((t) => fits(t) && plombOk(t));
      if (!pick) break;
      const total = remainingOf(pick) || pick.estimate || 60;
      const dur = Math.max(15, Math.min(total, sessionOf(pick)));
      const s = new Date(x), e = addMinutes(s, dur);
      out.push({ t: pick, s, e, partial: dur < total });
      used.add(pick.id);
      if (pick.energy <= 2) { plombMin += dur; lastPlomb = true; } else lastPlomb = false;
      x = addMinutes(e, brk);
    }
  }
  return out;
}

function stats() {
  const blocks = dayBlocks();
  const planned = blocks.reduce((m, b) => m + (b.e - b.s) / MIN, 0);
  const free = freeGaps().reduce((m, [s, e]) => m + (e - s) / MIN, 0);
  const ds = startOfDay(new Date()).getTime();
  const doneToday = tasks().filter((t) => t.status === 'done' && t.doneAt >= ds).length;
  const todays = blocks.filter((b) => b.kind === 'task').map((b) => b.t);
  const dueToday = tasks().filter((t) => t.status !== 'done' && !t.delegate && (t.due === todayStr() || (t.allDay && t.start && t.start.slice(0, 10) <= todayStr() && tEnd(t) > new Date())));
  const pct = todays.length ? todays.filter((t) => t.status === 'done').length / todays.length : 0;
  return { planned, free, doneToday, pct, dueToday };
}

function timelineHtml() {
  const S = db.settings, now = new Date();
  const ds = startOfDay(now), de = addDays(ds, 1);
  // Ramène chaque élément à la journée (une tâche commencée la veille démarre à 0 h).
  const all = dayBlocks().map((b) => ({ ...b, s: b.s < ds ? ds : b.s, e: b.e > de ? de : b.e }));
  // Les tâches longues (plus de 3 h, ou commencées un autre jour) vont dans le bandeau « Sur la journée ».
  const long = (b) => b.kind === 'task' && (b.e - b.s > 3 * 60 * MIN || b.t.start.slice(0, 10) !== toDateStr(now));
  const blocks = all.filter((b) => !long(b));
  const spans = all.filter(long);
  // Groupes d'éléments qui se chevauchent : affichés côte à côte.
  const groups = [];
  for (const b of blocks.sort((a, b2) => a.s - b2.s || b2.e - a.e)) {
    const g = groups[groups.length - 1];
    if (g && b.s < g.e) { g.items.push(b); if (b.e > g.e) g.e = b.e; } else groups.push({ s: b.s, e: b.e, items: [b] });
  }
  const rows = [
    ...groups.map((g) => ({ kind: 'group', ...g })),
    ...freeGaps().map(([s2, e2]) => ({ kind: 'free', s: s2, e: e2 })),
  ].sort((a, b) => a.s - b.s);
  const hm = (d) => fmt.time.format(d);
  const card = (b, multi) => {
    const own = multi ? `<small class="tl-own">${hm(b.s)} – ${hm(b.e)}</small>` : '';
    if (b.kind === 'event') {
      return `<div class="tl-card tl-ev" title="${esc(b.ev.subject || '')}">${own}<b>${esc(b.ev.subject || 'Rendez-vous')}</b><small>${b.ev.rh ? 'Plateforme RH' : 'Outlook'}${b.ev.location && !b.ev.rh ? ' · ' + esc(b.ev.location) : ''}</small></div>`;
    }
    const t = b.t, cur = b.s <= now && b.e > now;
    return `<div class="tl-card tl-task e${t.energy} ${t.status === 'done' ? 'done' : ''} ${cur ? 'cur' : ''}">
      <button class="tl-main" data-open-id="${t.id}">${own}<b>${t.status === 'done' ? '✓ ' : ''}${esc(t.title)}</b><small>${esc(ENERGY[t.energy].label)} · ${esc(catInfo(category(t)).label)}</small></button>
      ${t.status !== 'done' ? `<button class="icon-btn xs" data-focus="${t.id}" title="Lancer le minuteur" aria-label="Lancer le minuteur">${icon('play', 16)}</button>` : ''}</div>`;
  };
  let nowShown = false;
  const nowLine = () => { nowShown = true; return `<li class="tl-now"><span>${hm(now)}</span><i></i></li>`; };
  const html = rows.map((r) => {
    const pre = !nowShown && r.s >= now ? nowLine() : '';
    const time = `<span class="tl-time">${hm(r.s)}<small>${hm(r.e)}</small></span>`;
    if (r.kind === 'free') return `${pre}<li class="tl tl-free">${time}<div class="tl-cards"><div class="tl-card tl-gap">Libre · ${fmtDuration(Math.round((r.e - r.s) / MIN))}</div></div></li>`;
    const multi = r.items.length > 1;
    return `${pre}<li class="tl">${time}<div class="tl-cards ${multi ? 'multi' : ''}">${r.items.map((b) => card(b, multi)).join('')}</div></li>`;
  }).join('');
  const startH = new Date(now); startH.setHours(S.dayStart, 0, 0, 0);
  const endH = new Date(now); endH.setHours(S.dayEnd, 0, 0, 0);
  const tail = !nowShown && now >= startH && now < endH ? nowLine() : '';
  const spanHtml = spans.length ? `<div class="tl-spans"><small>Sur la journée</small>${spans.map((b2) => `<button class="chip tl-span e${b2.t.energy} ${b2.t.status === 'done' ? 'done' : ''}" data-open-id="${b2.t.id}" title="${esc(b2.t.title)}">${b2.t.status === 'done' ? '✓ ' : ''}${esc(b2.t.title)}<small>jusqu’à ${hm(new Date(Math.min(tEnd(b2.t), de)))}</small></button>`).join('')}</div>` : '';
  return spanHtml + (html || tail ? `<ol class="timeline">${html}${tail}</ol>` : `<p class="muted">Rien d’autre de prévu aujourd’hui.</p>`);
}

const sc = { uiScore, emScore, effUrgency };
function jrow(t, { place = false } = {}) {
  return `<li class="jr-row e${t.energy}">
    <button class="chk" data-jdone="${t.id}" aria-label="Terminer"></button>
    <button class="jr-t" data-open-id="${t.id}"><b>${esc(t.title)}</b><small>${t.due ? `échéance ${fmt.dateShort.format(new Date(t.due + 'T00:00'))} · ` : ''}${fmtDuration(remainingOf(t) || t.estimate || 60)}${t.decision?.key ? ' · ' + esc(DECISIONS[t.decision.key]?.label || '') : ''}</small></button>
    <span class="jr-sc">${scoreBadges(t, sc)}</span>
    ${place ? `<button class="btn sm" data-place="${t.id}">${icon('calendar', 14)} Placer</button>` : ''}
    <button class="icon-btn xs" data-focus="${t.id}" title="Lancer le minuteur" aria-label="Lancer le minuteur">${icon('play', 16)}</button>
  </li>`;
}
/** Urgentes aujourd'hui, et tâches décidées mais pas encore planifiées. */
function blocksHtml() {
  const today = todayStr();
  const open = tasks().filter((t) => t.status !== 'done' && !t.delegate && !isDeferred(t));
  const urgent = open.filter((t) => effUrgency(t) >= 5 || (t.due && t.due <= today) || quickWin(t) || (t.start && t.start.slice(0, 10) < today && !t.allDay))
    .sort((a, b) => score(b) - score(a)).slice(0, 8);
  const ids = new Set(urgent.map((t) => t.id));
  const unplanned = open.filter((t) => !t.start && !ids.has(t.id) && !needsDecision(t) && ['prioriser', 'planifier', 'expedier', 'decouper', 'regrouper'].includes(t.decision?.key))
    .sort((a, b) => score(b) - score(a)).slice(0, 10);
  return `${urgent.length ? `<section class="card jr-block urgent"><header><h3>${icon('alert', 18)} Urgent aujourd’hui</h3><span class="count">${urgent.length}</span>${info('', 'Échéance aujourd’hui ou dépassée, urgence maximale (y compris relevée par l’échéance), ou tâche urgente de moins de 15 minutes.')}</header><ul>${urgent.map((t) => jrow(t, { place: !t.start })).join('')}</ul></section>` : ''}
    ${unplanned.length ? `<section class="card jr-block"><header><h3>${icon('calendar', 18)} Décidées, pas encore planifiées</h3><span class="count">${unplanned.length}</span><span class="spacer"></span><button class="btn sm" data-propose>${icon('bulb', 14)} Proposer ma journée</button></header><ul>${unplanned.map((t) => jrow(t, { place: true })).join('')}</ul></section>` : ''}`;
}

export function renderToday(el) {
  const e = energyNow();
  const cands = nowCandidates(e);
  if (skip >= cands.length) skip = 0;
  const t = cands[skip];
  const st = stats();
  const now = new Date();
  el.innerHTML = `
    <section class="view today-view">
      <header class="today-head">
        <div><h2>${cap(fmt.dayLong ? fmt.dayLong.format(now) : now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
          <small>${fmtDuration(Math.round(st.planned))} prévues · ${fmtDuration(Math.round(st.free))} libres${st.doneToday ? ` · ${st.doneToday} faite${st.doneToday > 1 ? 's' : ''} aujourd’hui` : ''}</small></div>
        ${ring(st.pct, 56, 'lg')}
      </header>
      ${ownAbsentOn(todayStr()) ? `<div class="card review-banner">${icon('sun', 20)}<div><b>${esc(rhEvents().find((x) => x.own && x.debut <= todayStr() && x.fin >= todayStr())?.titre || 'Absence')} aujourd’hui</b><span>Rien n’est proposé pour cette journée. Profitez-en !</span></div></div>` : ''}
      ${reviewDue() ? `<a class="card review-banner" href="#journee/revue">${icon('check', 20)}<div><b>C’est l’heure de la revue de la semaine</b><span>15 minutes pour faire le bilan et préparer la semaine.</span></div><span class="btn primary sm">Commencer</span></a>` : ''}

      <div class="card energy-now">
        ${slider('enow', { label: 'Mon énergie maintenant', values: [1, 2, 3, 4], labels: ['Épuisé', 'Fatigué', 'En forme', 'Au top'], value: e, kind: 'energy', ticks: 'labels' })}
        ${info('', 'Indiquez comment vous vous sentez : la tâche proposée s’adapte. En forme, on attaque le plus difficile ; fatigué, on choisit du dynamisant ou du rapide.')}
      </div>

      ${toDecideCount() ? `<a class="card review-banner decide-banner" href="#decision">${icon('bulb', 20)}<div><b>${toDecideCount()} tâche${toDecideCount() > 1 ? 's' : ''} à trancher</b><span>Tant qu’elles ne sont pas décidées, elles ne sont ni planifiées ni proposées.</span></div><span class="btn primary sm">Trancher</span></a>` : ''}
      ${!msConnected() && !ghConfigured() ? `<a class="card sync-banner" href="#reglages/sync">${icon('sync', 20)}<div><b>Cet appareil n’est pas synchronisé</b><span>Connectez-le une fois pour retrouver les mêmes tâches partout.</span></div><span class="btn primary sm">Connecter</span></a>` : ''}
      ${t ? `<section class="card now-card e${t.energy}">
        <header><span class="now-tag">${icon('flame', 16)} Maintenant</span><small>${esc(whyNow(t, e))}</small></header>
        <div class="now-main">
          ${ring(progressOf(t), 48)}
          <button class="link now-title" data-open-id="${t.id}"><b>${esc(t.title)}</b>
            <small>${esc(ENERGY[t.energy].label)} · ${fmtDuration(Math.min(remainingOf(t) || t.estimate || 60, sessionOf(t)))}${(remainingOf(t) || 0) > sessionOf(t) ? ` (séance sur ${fmtDuration(remainingOf(t))})` : ''}</small></button>
        </div>
        <div class="now-acts">
          <button class="btn primary" data-focus="${t.id}">${icon('play', 18)} C’est parti</button>
          ${cands.length > 1 ? `<button class="btn ghost" data-skip>Autre idée</button>` : ''}
        </div>
      </section>` : `<div class="card now-card now-empty"><p>${toDecideCount() ? 'Tranchez vos tâches : la tâche à faire maintenant sera proposée ici.' : 'Rien à faire pour l’instant. Profitez-en !'}</p></div>`}

      ${blocksHtml()}
      <section class="card day-card">
        <header class="row"><h3>Mon agenda du jour</h3><span class="spacer"></span>
          <button class="btn sm" data-propose>${icon('bulb', 16)} Proposer ma journée</button>
          <a class="btn sm ghost" href="#journee/revue" title="Revue de la semaine">${icon('check', 16)}<span class="hide-sm">Revue</span></a>
          ${info('', 'Remplit les créneaux libres restants avec vos tâches non planifiées : plombantes le matin (jamais deux d’affilée, 2 h 30 au plus), dynamisantes ensuite, en séances avec une pause. Vous validez avant.')}
        </header>
        ${st.dueToday.length ? `<div class="due-today"><small>À rendre ou en cours aujourd’hui :</small>${st.dueToday.map((x) => `<button class="chip" data-open-id="${x.id}">${esc(x.title)}</button>`).join('')}</div>` : ''}
        ${timelineHtml()}
      </section>
      ${waitingHtml(local.get('journeeWait', true))}
    </section>`;
  bind(el);
}

function bind(el) {
  const root = el.querySelector('.today-view');
  bindSliders(root, (name, v, final) => { if (name === 'enow' && final) { setEnergyNow(v); skip = 0; renderToday(el); } });
  root.addEventListener('click', async (ev) => {
    const o = ev.target.closest('[data-open-id]');
    if (o) { openTaskEditor(o.dataset.openId); return; }
    if (ev.target.closest('[data-skip]')) { skip++; renderToday(el); return; }
    const f = ev.target.closest('[data-focus]');
    if (f) { const m = await import('./focus.js'); m.startFocus(db.tasks[f.dataset.focus]); return; }
    if (ev.target.closest('[data-propose]')) { openProposal(el); return; }
    const dn = ev.target.closest('[data-jdone]');
    if (dn) { const m = await import('./list.js'); m.toggleDone(db.tasks[dn.dataset.jdone]); return; }
    const pl = ev.target.closest('[data-place]');
    if (pl) {
      const t = db.tasks[pl.dataset.place];
      const slot = t && proposeSlot(t, { morning: t.energy <= 2, days: 10 });
      if (!slot) { toast('Aucun créneau libre trouvé dans les 10 prochains jours.'); return; }
      t.allDay = false; setSpan(t, slot, new Date(slot.getTime() + Math.min(t.estimate || 60, 240) * MIN)); putTask(t, { silent: true }); propagate([t.id]); save('today');
      toast(`Placée ${cap(fmt.dayShort.format(slot))} à ${fmt.time.format(slot)}.`); return;
    }
    if (ev.target.closest('[data-toggle-wait]')) { local.set('journeeWait', !local.get('journeeWait', true)); renderToday(el); return; }
    const nu = ev.target.closest('[data-nudge]');
    if (nu) { const t = db.tasks[nu.dataset.nudge]; if (t) { recordNudge(t); toast('Relance notée. Prochain point dans 2 jours ouvrés.'); } return; }
    const rc = ev.target.closest('[data-received]');
    if (rc) { const m = await import('./list.js'); m.toggleDone(db.tasks[rc.dataset.received]); }
  });
}

function openProposal(el) {
  const list = proposeDay();
  if (!list.length) { toast('Aucun créneau libre ou aucune tâche à placer aujourd’hui.'); return; }
  const { el: d, close } = openDialog({
    title: 'Proposition pour aujourd’hui',
    body: `<p class="hint">Décochez ce qui ne vous convient pas.</p>
      <ul class="prop-list">${list.map((p, i) => `<li class="e${p.t.energy}"><label><input type="checkbox" data-pi="${i}" checked>
        <span class="tl-time">${fmt.time.format(p.s)}<small>${fmt.time.format(p.e)}</small></span>
        <span><b>${esc(p.t.title)}</b><small>${esc(ENERGY[p.t.energy].label)}${p.partial ? ' · une séance' : ''}</small></span></label></li>`).join('')}</ul>`,
    footer: `<span class="spacer"></span><button type="button" class="btn ghost" data-close>Annuler</button><button type="button" class="btn primary" data-ok>Valider</button>`,
  });
  d.querySelector('[data-ok]').addEventListener('click', () => {
    let n = 0;
    d.querySelectorAll('[data-pi]').forEach((c) => {
      if (!c.checked) return;
      const p = list[Number(c.dataset.pi)];
      p.t.allDay = false; setSpan(p.t, p.s, p.e); putTask(p.t, { silent: true }); propagate([p.t.id]); n++;
    });
    save('today'); close(); renderToday(el);
    toast(`${n} tâche${n > 1 ? 's' : ''} placée${n > 1 ? 's' : ''} dans votre journée.`);
  });
}
