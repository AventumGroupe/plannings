// Vue calendrier : jour / semaine / mois, glisser-déposer, événements Outlook.

import { db, tasks, putTask, save, local, outlookEvents, score, ENERGY } from './store.js';
import { tStart, tEnd, setSpan, propagate, requiredStart, findFreeSlot, analyze } from './sched.js';
import { openTaskEditor } from './editor.js';
import { enableDrag, makeGhost, dropTarget, autoScroll } from './drag.js';
import { toast, energyChip, levelChip, slider, bindSliders, info } from './ui.js';
import {
  esc, icon, parse, toLocal, toDateStr, addDays, addMinutes, startOfDay, startOfWeek, startOfMonth,
  sameDay, daysBetween, fmt, cap, isMobile, MIN, isoWeek,
} from './util.js';

const HPX = 52; // hauteur d'une heure en pixels
const SNAP = 15;
const VIEWS = { jour: 'day', semaine: 'week', mois: 'month' };
const VIEW_NAMES = { day: 'jour', week: 'semaine', month: 'mois' };

let state = { view: null, date: new Date(), tray: false };
let hooks = { sync: null, connected: () => false };
export function setCalendarHooks(h) { hooks = { ...hooks, ...h }; }

export function calendarRoute(parts) {
  const v = VIEWS[parts[0]];
  if (v) state.view = v;
  if (parts[1]) { const d = parse(parts[1]); if (d && !isNaN(d)) state.date = d; }
}

function go(view, date) {
  state.view = view; state.date = date;
  const h = `#calendrier/${VIEW_NAMES[view]}/${toDateStr(date)}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

function rangeOf() {
  const d = state.date;
  if (state.view === 'day') return [startOfDay(d), addDays(startOfDay(d), 1)];
  if (state.view === 'week') { const s = startOfWeek(d); return [s, addDays(s, 7)]; }
  const s = startOfWeek(startOfMonth(d));
  return [s, addDays(s, 42)];
}

function titleOf() {
  const d = state.date;
  if (state.view === 'day') return cap(fmt.dayLong.format(d));
  if (state.view === 'week') {
    const s = startOfWeek(d), e = addDays(s, 6);
    return `Semaine ${isoWeek(s)} · ${fmt.dateShort.format(s)} – ${fmt.dateShort.format(e)}`;
  }
  return cap(fmt.month.format(d));
}

// ---------- Données affichées ----------
function itemsIn(from, to) {
  const out = [];
  for (const t of tasks()) {
    if (!t.start) continue;
    const s = tStart(t), e = tEnd(t);
    if (s < to && e > from) out.push({ kind: 'task', t, s, e, allDay: t.allDay || daysBetween(s, new Date(e - 1)) > 0 });
  }
  for (const ev of outlookEvents()) {
    const s = parse(ev.start), e = parse(ev.end);
    if (s < to && e > from) out.push({ kind: 'ext', ev, s, e, allDay: ev.isAllDay || daysBetween(s, new Date(e - 1)) > 0 });
  }
  return out;
}

/** Répartit les éléments qui se chevauchent en colonnes. */
function layoutLanes(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let group = [], groupEnd = 0;
  const flush = () => {
    const lanes = [];
    for (const it of group) {
      let i = lanes.findIndex((end) => end <= it.s);
      if (i < 0) { i = lanes.length; lanes.push(0); }
      lanes[i] = it.e; it.lane = i;
    }
    group.forEach((it) => (it.lanes = lanes.length));
    group = [];
  };
  for (const it of items) {
    if (group.length && it.s >= groupEnd) flush();
    group.push(it);
    groupEnd = Math.max(groupEnd, it.e);
  }
  flush();
  return items;
}

// ---------- Rendu ----------
export function renderCalendar(el) {
  if (!state.view) state.view = isMobile() ? 'day' : 'week';
  const an = analyze();
  const unplanned = tasks().filter((t) => !t.start && t.status !== 'done').sort((a, b) => score(b) - score(a));
  const connected = hooks.connected();

  el.innerHTML = `
    <section class="view cal-view ${state.tray ? 'tray-open' : ''}">
      <div class="cal-toolbar">
        <div class="row gap-sm">
          <button class="icon-btn" data-nav="-1" aria-label="Précédent">${icon('chevL')}</button>
          <button class="btn ghost sm" data-nav="0">Aujourd’hui</button>
          <button class="icon-btn" data-nav="1" aria-label="Suivant">${icon('chevR')}</button>
        </div>
        <h2 class="cal-title">${esc(titleOf())}</h2>
        ${slider('calview', { values: ['day', 'week', 'month'], labels: ['Jour', 'Semaine', 'Mois'], value: state.view, ticks: 'labels', compact: true })}
        ${info('calendrier')}
        <button class="icon-btn sync-btn ${connected ? 'on' : ''}" data-sync title="${connected ? 'Synchroniser avec Outlook' : 'Connecter Outlook (réglages)'}" aria-label="Outlook">${icon('sync', 18)}</button>
      </div>
      <div class="cal-body">
        <aside class="tray" aria-label="Tâches à planifier">
          <button class="tray-head" data-tray>
            <b>À planifier</b><span class="count">${unplanned.length}</span><span class="spacer"></span>
            <span class="muted sm show-sm">${state.tray ? 'Fermer' : 'Ouvrir'}</span>
          </button>
          <ul class="tray-list">${unplanned.map((t) => `
            <li class="tray-item e${t.energy}" data-drag-task="${t.id}" data-open-task="${t.id}">
              <span class="grip">${icon('grip', 14)}</span>
              <div><b>${esc(t.title)}</b><div class="tr-meta">${levelChip('U', t.urgency)}${levelChip('I', t.importance)}${energyChip(t.energy)}</div></div>
            </li>`).join('') || '<li class="muted sm">Tout est planifié 👍</li>'}</ul>
        </aside>
        <div class="cal-main">${state.view === 'month' ? monthHtml(an) : gridHtml(an)}</div>
      </div>
    </section>`;

  bind(el);
  if (state.view !== 'month') {
    const sc = el.querySelector('.tg-scroll');
    const saved = local.get('calScroll');
    const now = new Date();
    const target = saved ?? Math.max(0, (now.getHours() - db.settings.dayStart - 1) * HPX);
    sc.scrollTop = target;
    sc.addEventListener('scroll', () => local.set('calScroll', sc.scrollTop), { passive: true });
  }
}

function gridHtml(an) {
  const S = db.settings;
  const [from, to] = rangeOf();
  const n = daysBetween(from, to);
  const days = Array.from({ length: n }, (_, i) => addDays(from, i));
  const items = itemsIn(from, to);
  const hours = S.dayEnd - S.dayStart;
  const today = new Date();

  const allDayCells = days.map((d) => {
    const de = addDays(d, 1);
    const list = items.filter((it) => it.allDay && it.s < de && it.e > d);
    return `<div class="tg-ad-cell" data-allday="${toDateStr(d)}">${list.map((it) => chipHtml(it, an)).join('')}</div>`;
  }).join('');

  const cols = days.map((d) => {
    const de = addDays(d, 1);
    const list = layoutLanes(items.filter((it) => !it.allDay && it.s < de && it.e > d).map((it) => ({ ...it })));
    const evs = list.map((it) => {
      const s = it.s < d ? d : it.s, e = it.e > de ? de : it.e;
      let top = ((s.getHours() + s.getMinutes() / 60) - S.dayStart) * HPX;
      let bottom = ((e.getHours() + e.getMinutes() / 60 || 24) - S.dayStart) * HPX;
      const clipped = top < 0 || bottom > hours * HPX;
      top = Math.max(0, Math.min(top, hours * HPX - 18));
      bottom = Math.min(hours * HPX, Math.max(bottom, top + 18));
      const w = 100 / it.lanes;
      const style = `top:${top}px;height:${Math.max(18, bottom - top - 2)}px;left:calc(${it.lane * w}% + 2px);width:calc(${w}% - 4px)`;
      const time = `${fmt.time.format(it.s)} – ${fmt.time.format(it.e)}`;
      if (it.kind === 'ext') {
        return `<div class="ev ext ${it.ev.showAs === 'free' ? 'free' : ''}" style="${style}" data-ext="${esc(it.ev.id)}" title="${esc(it.ev.subject)} · ${time} (Outlook)">
          <b>${esc(it.ev.subject || '(sans titre)')}</b><small>${time}${it.ev.location ? ' · ' + esc(it.ev.location) : ''}</small></div>`;
      }
      const t = it.t, a = an[t.id] || {};
      const p = db.projects[t.projectId];
      return `<div class="ev task e${t.energy} ${t.status === 'done' ? 'done' : ''} ${a.late ? 'late' : ''} ${clipped ? 'clipped' : ''}" style="${style};--pc:${p?.color || 'transparent'}"
          data-drag-task="${t.id}" data-open-task="${t.id}" title="${esc(t.title)} · ${time} · ${ENERGY[t.energy].label}">
          <b>${t.status === 'done' ? '✓ ' : ''}${esc(t.title)}</b><small>${time}</small>
          <span class="rs" data-resize aria-hidden="true"></span></div>`;
    }).join('');
    const isToday = sameDay(d, today);
    const nowLine = isToday && today.getHours() >= S.dayStart && today.getHours() < S.dayEnd
      ? `<div class="now-line" style="top:${((today.getHours() + today.getMinutes() / 60) - S.dayStart) * HPX}px"></div>` : '';
    const wk = !S.workDays.includes(d.getDay());
    return `<div class="tg-col ${isToday ? 'today' : ''} ${wk ? 'weekend' : ''}" data-col="${toDateStr(d)}">
      <div class="morning" style="height:${Math.max(0, S.morningEnd - S.dayStart) * HPX}px" title="Matin : énergie haute"></div>
      ${evs}${nowLine}</div>`;
  }).join('');

  return `
    <div class="tg" style="--cols:${n};--hpx:${HPX}px">
      <div class="tg-head">
        <div class="tg-gutter"></div>
        ${days.map((d) => `<button class="tg-day ${sameDay(d, today) ? 'today' : ''}" data-goday="${toDateStr(d)}"><span>${cap(fmt.weekday.format(d))}</span><b>${d.getDate()}</b></button>`).join('')}
      </div>
      <div class="tg-allday"><div class="tg-gutter sm">Journée</div>${allDayCells}</div>
      <div class="tg-scroll">
        <div class="tg-grid" style="height:${hours * HPX}px">
          <div class="tg-hours">${Array.from({ length: hours }, (_, i) => `<span style="top:${i * HPX}px">${S.dayStart + i} h</span>`).join('')}</div>
          ${cols}
        </div>
      </div>
    </div>`;
}

function chipHtml(it, an) {
  if (it.kind === 'ext') return `<div class="chip-ev ext" title="${esc(it.ev.subject)} (Outlook)">${esc(it.ev.subject || '(sans titre)')}</div>`;
  const t = it.t, a = an[t.id] || {};
  const p = db.projects[t.projectId];
  const time = t.allDay ? '' : `<small>${fmt.time.format(it.s)}</small> `;
  return `<div class="chip-ev e${t.energy} ${t.status === 'done' ? 'done' : ''} ${a.late ? 'late' : ''}" style="--pc:${p?.color || 'transparent'}"
    data-drag-task="${t.id}" data-open-task="${t.id}" title="${esc(t.title)}">${time}${esc(t.title)}</div>`;
}

function monthHtml(an) {
  const [from, to] = rangeOf();
  const items = itemsIn(from, to);
  const today = new Date();
  const month = state.date.getMonth();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(from, i), de = addDays(d, 1);
    const list = items.filter((it) => it.s < de && it.e > d).sort((a, b) => (b.allDay - a.allDay) || a.s - b.s);
    const max = isMobile() ? 2 : 4;
    cells.push(`<div class="m-cell ${d.getMonth() !== month ? 'other' : ''} ${sameDay(d, today) ? 'today' : ''}" data-day="${toDateStr(d)}">
      <button class="m-num" data-goday="${toDateStr(d)}">${d.getDate()}</button>
      ${list.slice(0, max).map((it) => chipHtml(it, an)).join('')}
      ${list.length > max ? `<button class="m-more" data-goday="${toDateStr(d)}">+${list.length - max}</button>` : ''}
    </div>`);
  }
  const heads = Array.from({ length: 7 }, (_, i) => `<div class="m-head">${cap(fmt.weekday.format(addDays(from, i)))}</div>`).join('');
  return `<div class="month">${heads}${cells.join('')}</div>`;
}

// ---------- Interactions ----------
function bind(el) {
  const root = el.querySelector('.cal-view');
  bindSliders(root, (name, v, final) => { if (name === 'calview' && v !== state.view) { go(v, state.date); renderCalendar(el); } });
  root.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const k = Number(nav.dataset.nav);
      const d = state.date;
      const nd = k === 0 ? new Date() : state.view === 'day' ? addDays(d, k) : state.view === 'week' ? addDays(d, 7 * k) : new Date(d.getFullYear(), d.getMonth() + k, 1);
      go(state.view, nd); renderCalendar(el); return;
    }
    const v = e.target.closest('[data-view]');
    if (v) { go(v.dataset.view, state.date); renderCalendar(el); return; }
    const gd = e.target.closest('[data-goday]');
    if (gd) { go('day', parse(gd.dataset.goday)); renderCalendar(el); return; }
    if (e.target.closest('[data-tray]')) { state.tray = !state.tray; root.classList.toggle('tray-open', state.tray); return; }
    if (e.target.closest('[data-sync]')) {
      if (hooks.connected()) hooks.sync?.(true); else location.hash = '#reglages';
      return;
    }
    const ext = e.target.closest('[data-ext]');
    if (ext) {
      const ev = outlookEvents().find((x) => x.id === ext.dataset.ext);
      if (ev) toast(`${ev.subject || 'Événement'} — ${fmt.time.format(parse(ev.start))} à ${fmt.time.format(parse(ev.end))} (Outlook, lecture seule)`);
      return;
    }
    const open = e.target.closest('[data-open-task]');
    if (open) { openTaskEditor(open.dataset.openTask); return; }
    // Clic sur un créneau vide : nouvelle tâche
    const col = e.target.closest('[data-col]');
    if (col && e.target.closest('.tg-col, .morning')) {
      const start = pointToTime(col, e.clientY, 0, 30);
      openTaskEditor({ start: toLocal(start), end: toLocal(addMinutes(start, 60)), estimate: 60, energy: start.getHours() < db.settings.morningEnd ? 2 : 3 });
      return;
    }
    const ad = e.target.closest('[data-allday]');
    if (ad && e.target === ad) openTaskEditor({ allDay: true, start: ad.dataset.allday + 'T00:00', end: ad.dataset.allday + 'T00:00' });
  });

  const scroller = root.querySelector('.tg-scroll');
  let preview = null, ghost = null, hl = null;
  const clearUi = () => { preview?.remove(); preview = null; ghost?.remove(); ghost = null; hl?.classList.remove('drop-hl'); hl = null; };

  enableDrag(root, {
    selector: '[data-drag-task]',
    onStart(st) {
      const t = db.tasks[st.el.dataset.dragTask];
      if (!t) return false;
      const resize = !!st.target.closest('[data-resize]');
      let offsetMin = 0;
      if (st.el.classList.contains('ev') && !resize) {
        const r = st.el.getBoundingClientRect();
        offsetMin = Math.round(((st.y0 - r.top) / HPX) * 60 / SNAP) * SNAP;
      }
      st.el.classList.add('drag-src');
      if (st.el.closest('.tray') && isMobile()) root.classList.add('tray-peek');
      ghost = resize ? null : makeGhost(`<b>${esc(t.title)}</b>`, `e${t.energy}`);
      return { t, resize, offsetMin, dur: t.start && !t.allDay ? tEnd(t) - tStart(t) : (t.estimate || 60) * MIN };
    },
    onMove(st) {
      const { t, resize, offsetMin, dur } = st.data;
      ghost?.move(st.x, st.y);
      autoScroll(scroller, st.x, st.y);
      if (resize) {
        const col = st.el.closest('[data-col]');
        const end = pointToTime(col, st.y, 0, SNAP);
        const s = tStart(t);
        st.data.newEnd = end > s ? end : addMinutes(s, SNAP);
        st.el.style.height = `${Math.max(18, ((st.data.newEnd - s) / MIN / 60) * HPX - 2)}px`;
        return;
      }
      const target = dropTarget(st.x, st.y, '[data-col], [data-day], [data-allday]');
      if (hl && hl !== target) { hl.classList.remove('drop-hl'); hl = null; }
      preview?.remove(); preview = null;
      st.data.drop = null;
      if (!target) return;
      if (target.dataset.col) {
        const start = pointToTime(target, st.y, offsetMin, SNAP);
        st.data.drop = { kind: 'time', start };
        preview = document.createElement('div');
        preview.className = 'ev-preview';
        const S = db.settings;
        preview.style.top = `${((start.getHours() + start.getMinutes() / 60) - S.dayStart) * HPX}px`;
        preview.style.height = `${Math.max(18, (dur / MIN / 60) * HPX)}px`;
        preview.textContent = `${fmt.time.format(start)} – ${fmt.time.format(new Date(start.getTime() + dur))}`;
        target.appendChild(preview);
      } else {
        hl = target; hl.classList.add('drop-hl');
        st.data.drop = target.dataset.day ? { kind: 'day', day: parse(target.dataset.day) } : { kind: 'allday', day: parse(target.dataset.allday) };
      }
    },
    onEnd(st, cancelled) {
      const { t, resize, dur, drop, newEnd } = st.data;
      clearUi();
      st.el.classList.remove('drag-src');
      root.classList.remove('tray-peek');
      if (cancelled) { renderCalendar(el); return; }
      if (resize) {
        if (newEnd) { t.end = toLocal(newEnd); t.estimate = Math.round((newEnd - tStart(t)) / MIN); commit(t, el); }
        return;
      }
      if (!drop) return;
      if (drop.kind === 'time') {
        t.allDay = false;
        setSpan(t, drop.start, new Date(drop.start.getTime() + dur));
      } else if (drop.kind === 'allday') {
        const days = t.allDay ? Math.max(1, daysBetween(tStart(t), tEnd(t))) : 1;
        t.allDay = true;
        setSpan(t, drop.day, addDays(drop.day, days));
      } else {
        if (t.allDay) {
          const days = Math.max(1, daysBetween(tStart(t), tEnd(t)));
          setSpan(t, drop.day, addDays(drop.day, days));
        } else if (t.start) {
          const s = tStart(t), nd = new Date(drop.day);
          nd.setHours(s.getHours(), s.getMinutes(), 0, 0);
          setSpan(t, nd, new Date(nd.getTime() + dur));
        } else {
          const S = db.settings;
          const slot = findFreeSlot(drop.day, t.estimate || 60, S.dayStart, t.energy <= 2 ? S.morningEnd : S.dayEnd, t.id)
            || findFreeSlot(drop.day, t.estimate || 60, S.dayStart, S.dayEnd, t.id);
          if (slot) setSpan(t, slot, addMinutes(slot, t.estimate || 60));
          else { t.allDay = true; setSpan(t, drop.day, addDays(drop.day, 1)); }
        }
      }
      commit(t, el);
    },
  });
}

function pointToTime(col, clientY, offsetMin, snap) {
  const S = db.settings;
  const r = col.getBoundingClientRect();
  let min = ((clientY - r.top) / HPX) * 60 - offsetMin;
  min = Math.round(min / snap) * snap;
  min = Math.max(0, Math.min(min, (S.dayEnd - S.dayStart) * 60 - snap));
  const d = parse(col.dataset.col);
  d.setHours(S.dayStart, 0, 0, 0);
  return addMinutes(d, min);
}

function commit(t, el) {
  let msg = '';
  const req = requiredStart(t);
  if (req && tStart(t) < req) {
    const dur = tEnd(t) - tStart(t);
    setSpan(t, req, new Date(req.getTime() + dur));
    msg = `Placée après la fin de ses prédécesseurs (${cap(fmt.dayShort.format(req))} ${t.allDay ? '' : fmt.time.format(req)}).`;
  }
  putTask(t, { silent: true });
  const moved = propagate([t.id]);
  save('calendar');
  if (moved.size) msg += ` ${moved.size} successeur${moved.size > 1 ? 's' : ''} décalé${moved.size > 1 ? 's' : ''}.`;
  if (t.energy <= 2 && !t.allDay && tStart(t).getHours() >= db.settings.morningEnd) msg += ' Astuce : tâche plombante, le matin serait idéal.';
  if (msg.trim()) toast(msg.trim());
}
