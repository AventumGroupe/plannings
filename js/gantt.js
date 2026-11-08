// Vue Gantt : projets, barres, dépendances fin -> début, chemin critique,
// décalage en cascade, vue compacte pour téléphone, export PDF.

import { db, tasks, projects, putTask, save, local, RES_TYPES } from './store.js';
import { tStart, tEnd, setSpan, shiftTo, propagate, requiredStart, analyze, wouldCycle } from './sched.js';
import { openTaskEditor } from './editor.js';
import { openProjectEditor } from './resources.js';
import { enableDrag, makeGhost, dropTarget, autoScroll } from './drag.js';
import { toast, slider, bindSliders, info } from './ui.js';
import { esc, icon, parse, toDateStr, addDays, startOfDay, startOfWeek, sameDay, daysBetween, fmt, cap, isMobile, isoWeek, DAY, MIN } from './util.js';

const ROW = 34;
const ZOOMS = { day: { dayW: 34, label: 'Jours' }, week: { dayW: 13, label: 'Semaines' }, month: { dayW: 4, label: 'Mois' } };

const G = Object.assign({ project: '', zoom: 'day', showDone: true, critical: true, collapsed: {}, mobileMode: 'compact' }, local.get('gantt', {}));
const persist = () => local.set('gantt', G);

// ---------- Données ----------
function groups() {
  const an = analyze();
  const all = tasks().filter((t) => G.showDone || t.status !== 'done');
  const ps = projects().filter((p) => !G.project || G.project === p.id);
  const out = [];
  const byStart = (a, b) => (a.start || '9999').localeCompare(b.start || '9999') || (a.title || '').localeCompare(b.title || '', 'fr');
  for (const p of ps) {
    const list = all.filter((t) => t.projectId === p.id).sort(byStart);
    out.push({ p, planned: list.filter((t) => t.start), unplanned: list.filter((t) => !t.start) });
  }
  if (!G.project || G.project === '_none') {
    // Sans projet : seulement les tâches liées par des dépendances ou sur plusieurs jours
    const linked = new Set();
    for (const t of all) if (t.preds.length) { linked.add(t.id); t.preds.forEach((x) => linked.add(x.id)); }
    const list = all.filter((t) => !t.projectId && t.start && (linked.has(t.id) || t.allDay || tEnd(t) - tStart(t) >= DAY)).sort(byStart);
    if (list.length) out.push({ p: null, planned: list, unplanned: [] });
  }
  return { groups: out, an };
}

function rangeFor(gs) {
  let min = startOfDay(new Date()), max = addDays(min, 21);
  for (const g of gs) {
    for (const t of g.planned) { const s = tStart(t), e = tEnd(t); if (s < min) min = startOfDay(s); if (e > max) max = e; }
    if (g.p?.deadline) { const d = addDays(parse(g.p.deadline), 1); if (d > max) max = d; }
  }
  const from = startOfWeek(addDays(min, -2));
  const to = addDays(startOfWeek(addDays(max, 7)), 7);
  return [from, to];
}

function buildRows(gs) {
  const rows = [];
  for (const g of gs) {
    const key = g.p ? g.p.id : '_none';
    const s = g.planned.length ? new Date(Math.min(...g.planned.map((t) => tStart(t)))) : null;
    const e = g.planned.length ? new Date(Math.max(...g.planned.map((t) => tEnd(t)))) : null;
    const done = g.planned.concat(g.unplanned).filter((t) => t.status === 'done').length;
    const total = g.planned.length + g.unplanned.length;
    rows.push({ type: 'project', key, p: g.p, s, e, progress: total ? done / total : 0, total });
    if (G.collapsed[key]) continue;
    for (const t of g.planned) rows.push({ type: 'task', t });
    for (const t of g.unplanned) rows.push({ type: 'unplanned', t });
  }
  return rows;
}

const progressOf = (t) => t.status === 'done' ? 1 : t.subtasks.length ? t.subtasks.filter((s) => s.done).length / t.subtasks.length : t.status === 'doing' ? 0.3 : 0;

// ---------- Rendu complet (ordinateur, impression) ----------
function ganttHtml(rows, an, from, to, { dayW, nameW, print = false }) {
  const days = daysBetween(from, to);
  const W = days * dayW;
  const H = rows.length * ROW;
  const xOf = (d) => ((d - from) / DAY) * dayW;
  const today = new Date();
  const zoom = dayW >= 24 ? 'day' : dayW >= 9 ? 'week' : 'month';

  // Échelle
  const top = [], bottom = [];
  if (zoom === 'month') {
    for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
      const a = new Date(Math.max(from, new Date(y, 0, 1))), b = new Date(Math.min(to, new Date(y + 1, 0, 1)));
      if (b > a) top.push(`<span style="left:${xOf(a)}px;width:${xOf(b) - xOf(a)}px">${y}</span>`);
    }
    for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d < to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const a = d < from ? from : d, b = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      bottom.push(`<span style="left:${xOf(a)}px;width:${xOf(b > to ? to : b) - xOf(a)}px">${cap(fmt.monthShort.format(d))}</span>`);
    }
  } else {
    for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d < to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const a = d < from ? from : d, b = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      top.push(`<span style="left:${xOf(a)}px;width:${xOf(b > to ? to : b) - xOf(a)}px">${cap(fmt.month.format(d))}</span>`);
    }
    if (zoom === 'day') {
      for (let i = 0; i < days; i++) {
        const d = addDays(from, i);
        bottom.push(`<span class="${sameDay(d, today) ? 'today' : ''} ${d.getDay() % 6 === 0 ? 'we' : ''}" style="left:${i * dayW}px;width:${dayW}px"><small>${fmt.weekday.format(d).charAt(0).toUpperCase()}</small>${d.getDate()}</span>`);
      }
    } else {
      for (let i = 0; i < days; i += 7) {
        const d = addDays(from, i);
        bottom.push(`<span style="left:${i * dayW}px;width:${7 * dayW}px">S${isoWeek(d)}</span>`);
      }
    }
  }

  // Fond : week-ends
  const shades = [];
  if (zoom === 'day') for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    if (!db.settings.workDays.includes(d.getDay())) shades.push(`<i class="g-we" style="left:${i * dayW}px;width:${dayW}px"></i>`);
  }

  // Noms + barres
  const pos = {}; // id -> {x1, x2, y}
  const names = [], bars = [];
  rows.forEach((r, i) => {
    const y = i * ROW;
    if (r.type === 'project') {
      const p = r.p;
      const late = p?.deadline && r.e && r.e > addDays(parse(p.deadline), 1);
      names.push(`<div class="g-name g-proj" style="top:${y}px" data-toggle="${r.key}">
        <span class="caret ${G.collapsed[r.key] ? '' : 'open'}">${icon('chevR', 14)}</span>
        <i class="dot" style="background:${p?.color || 'var(--muted)'}"></i>
        <b>${esc(p ? p.name : 'Sans projet')}</b><small>${r.total} t.</small>
        ${p && !print ? `<button class="icon-btn xs" data-editproj="${p.id}" title="Modifier le projet">${icon('settings', 14)}</button>` : ''}</div>`);
      if (r.s) {
        const x1 = xOf(r.s), x2 = xOf(r.e);
        bars.push(`<div class="g-sum ${late ? 'late' : ''}" style="top:${y + 12}px;left:${x1}px;width:${Math.max(4, x2 - x1)}px;--pc:${p?.color || 'var(--muted)'}"><i style="width:${r.progress * 100}%"></i></div>`);
      }
      if (p?.deadline) {
        const x = xOf(addDays(parse(p.deadline), 1));
        bars.push(`<div class="g-deadline" style="top:${y}px;left:${x}px;height:${ROW}px" title="Échéance du projet : ${fmt.date.format(parse(p.deadline))}"><span>${icon('alert', 12)}</span></div>`);
      }
      return;
    }
    const t = r.t, a = an[t.id] || {};
    const p = db.projects[t.projectId];
    const del = t.delegate && db.resources[t.delegate];
    names.push(`<div class="g-name ${t.status === 'done' ? 'done' : ''} ${a.late ? 'late' : ''}" style="top:${y}px" data-open-task="${t.id}" title="${esc(t.title)}">
      <i class="edot e${t.energy}"></i><span class="nm">${esc(t.title)}</span>
      ${r.type === 'unplanned' ? '<small class="muted">non planifiée</small>' : del ? `<small>${esc(del.name)}</small>` : ''}</div>`);
    if (r.type === 'unplanned') {
      if (!print) bars.push(`<div class="g-plan-row" style="top:${y}px;height:${ROW}px" data-plan-row="${t.id}" title="Cliquez sur un jour pour planifier « ${esc(t.title)} »"></div>`);
      return;
    }
    const s = tStart(t), e = tEnd(t);
    const x1 = xOf(s), x2 = Math.max(xOf(e), x1 + 6);
    pos[t.id] = { x1, x2, y: y + ROW / 2 };
    const res = t.assign.map((x) => db.resources[x.id]?.name).filter(Boolean);
    const label = [del?.name, ...res].filter(Boolean).slice(0, 3).join(', ');
    const cls = [`e${t.energy}`, t.status === 'done' ? 'done' : '', a.late ? 'late' : '', G.critical && a.critical && !a.late ? 'critical' : ''].join(' ');
    bars.push(`<div class="g-bar ${cls}" style="top:${y + 7}px;left:${x1}px;width:${x2 - x1}px;--pc:${p?.color || 'var(--accent)'}"
        data-bar="${t.id}" title="${esc(t.title)} · ${fmt.dateShort.format(s)} → ${fmt.dateShort.format(new Date(e - 1))}${a.late ? ' · CRITIQUE : dépasse l’échéance' : ''}">
        <i class="g-prog" style="width:${progressOf(t) * 100}%"></i>
        ${x2 - x1 > 60 ? `<span class="g-lbl">${esc(t.title)}</span>` : ''}
        ${print ? '' : '<span class="g-rs" data-resize></span><span class="g-link" data-link title="Glisser vers une autre tâche pour créer un lien"></span>'}
      </div>
      ${label ? `<span class="g-res" style="top:${y + 9}px;left:${x2 + 8}px">${esc(label)}</span>` : ''}`);
  });

  // Flèches de dépendance
  const arrows = [];
  for (const r of rows) {
    if (r.type !== 'task') continue;
    const b = pos[r.t.id];
    for (const link of r.t.preds) {
      const a = pos[link.id];
      if (!a || !b) continue;
      const x1 = a.x2, y1 = a.y, x2 = b.x1, y2 = b.y;
      const late = (an[r.t.id]?.late) ? 'late' : '';
      const d = x2 - 10 >= x1
        ? `M${x1},${y1} H${x1 + 6} V${y2} H${x2 - 2}`
        : `M${x1},${y1} H${x1 + 6} V${y1 + (y2 > y1 ? ROW / 2 : -ROW / 2)} H${x2 - 10} V${y2} H${x2 - 2}`;
      arrows.push(`<path class="${late}" d="${d}" marker-end="url(#arr)"/>`);
    }
  }
  const todayX = xOf(today);

  return `
    <div class="g-inner" style="width:${nameW + W}px;--namew:${nameW}px;--row:${ROW}px">
      <div class="g-head">
        <div class="g-corner">Tâches</div>
        <div class="g-scale" style="width:${W}px"><div class="g-top">${top.join('')}</div><div class="g-bottom">${bottom.join('')}</div></div>
      </div>
      <div class="g-body" style="height:${Math.max(H, ROW)}px">
        <div class="g-names" style="height:${Math.max(H, ROW)}px">${names.join('')}</div>
        <div class="g-timeline" style="width:${W}px;height:${Math.max(H, ROW)}px;--dayw:${dayW}px">
          ${shades.join('')}
          ${rows.map((r, i) => r.type === 'project' ? `<i class="g-band" style="top:${i * ROW}px"></i>` : '').join('')}
          ${todayX >= 0 && todayX <= W ? `<i class="g-today" style="left:${todayX}px"></i>` : ''}
          <svg class="g-arrows" width="${W}" height="${Math.max(H, ROW)}"><defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>${arrows.join('')}</svg>
          ${bars.join('')}
        </div>
      </div>
    </div>`;
}

// ---------- Vue compacte (téléphone) ----------
function compactHtml(gs, an) {
  if (!gs.length) return '';
  const today = new Date();
  return gs.map((g) => {
    const list = g.planned;
    const key = g.p ? g.p.id : '_none';
    const s = list.length ? new Date(Math.min(...list.map((t) => tStart(t)))) : null;
    let e = list.length ? new Date(Math.max(...list.map((t) => tEnd(t)))) : null;
    if (g.p?.deadline && e) { const dl = addDays(parse(g.p.deadline), 1); if (dl > e) e = dl; }
    const span = s && e ? e - s : 1;
    const pct = (d) => Math.max(0, Math.min(100, ((d - s) / span) * 100));
    const lateN = list.filter((t) => an[t.id]?.late).length;
    const collapsed = G.collapsed[key];
    return `
      <section class="cg card">
        <header class="cg-head" data-toggle="${key}">
          <i class="dot" style="background:${g.p?.color || 'var(--muted)'}"></i>
          <div><b>${esc(g.p ? g.p.name : 'Sans projet')}</b>
            <small>${s ? `${fmt.dateShort.format(s)} → ${fmt.dateShort.format(new Date(e - 1))}` : 'Rien de planifié'}${g.p?.deadline ? ` · échéance ${fmt.dateShort.format(parse(g.p.deadline))}` : ''}</small></div>
          ${lateN ? `<span class="badge danger">${lateN} critique${lateN > 1 ? 's' : ''}</span>` : ''}
          <span class="caret ${collapsed ? '' : 'open'}">${icon('chevR', 16)}</span>
        </header>
        ${collapsed ? '' : `<ol class="cg-list">${list.map((t) => {
          const a = an[t.id] || {};
          const ts = tStart(t), te = tEnd(t);
          const preds = t.preds.map((x) => db.tasks[x.id]?.title).filter(Boolean);
          const del = t.delegate && db.resources[t.delegate];
          return `<li class="cg-task ${a.late ? 'late' : ''} ${G.critical && a.critical && !a.late ? 'critical' : ''} ${t.status === 'done' ? 'done' : ''}" data-open-task="${t.id}">
            <div class="cg-top"><i class="edot e${t.energy}"></i><b>${esc(t.title)}</b>
              <span class="cg-dates">${fmt.dateShort.format(ts)}${sameDay(ts, new Date(te - 1)) ? '' : ` → ${fmt.dateShort.format(new Date(te - 1))}`}</span></div>
            <div class="cg-track"><i class="cg-bar" style="left:${pct(ts)}%;width:${Math.max(2, pct(te) - pct(ts))}%;--pc:${g.p?.color || 'var(--accent)'}"><b style="width:${progressOf(t) * 100}%"></b></i>
              ${s && today >= s && today <= e ? `<i class="cg-now" style="left:${pct(today)}%"></i>` : ''}</div>
            ${preds.length || del || a.late ? `<div class="cg-info">
              ${a.late ? `<span class="danger-text">${icon('alert', 13)} Dépasse l’échéance</span>` : a.critical && G.critical ? '<span class="warn-text">Chemin critique</span>' : ''}
              ${preds.length ? `<span>${icon('link', 13)} après ${esc(preds.join(', '))}</span>` : ''}
              ${del ? `<span>${icon('user', 13)} ${esc(del.name)}</span>` : ''}</div>` : ''}
          </li>`;
        }).join('')}
        ${g.unplanned.length ? `<li class="cg-unplanned muted sm">${g.unplanned.length} tâche${g.unplanned.length > 1 ? 's' : ''} non planifiée${g.unplanned.length > 1 ? 's' : ''} : ${g.unplanned.map((t) => `<button class="link" data-open-task="${t.id}">${esc(t.title)}</button>`).join(', ')}</li>` : ''}
        </ol>`}
      </section>`;
  }).join('');
}

// ---------- Vue ----------
export function renderGantt(el) {
  const { groups: gs, an } = groups();
  const [from, to] = rangeFor(gs);
  const rows = buildRows(gs);
  const mobile = isMobile();
  const compact = mobile && G.mobileMode === 'compact';
  const nameW = mobile ? 130 : 260;
  const dayW = ZOOMS[G.zoom].dayW;
  const lateCount = Object.entries(an).filter(([id, a]) => a.late && (!G.project || db.tasks[id]?.projectId === G.project)).length;
  const empty = !gs.some((g) => g.planned.length || g.unplanned.length);

  el.innerHTML = `
    <section class="view gantt-view">
      <div class="g-toolbar">
        <select data-g="project" aria-label="Projet">
          <option value="">Tous les projets</option>
          ${projects().map((p) => `<option value="${p.id}" ${G.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          <option value="_none" ${G.project === '_none' ? 'selected' : ''}>Sans projet</option>
        </select>
        ${mobile ? `<label class="switch sm"><input type="checkbox" data-full ${!compact ? 'checked' : ''}><span></span> Gantt complet</label>` : ''}
        ${compact ? '' : slider('zoom', { values: Object.keys(ZOOMS), labels: Object.values(ZOOMS).map((z) => z.label), value: G.zoom, ticks: 'labels', compact: true })}
        <label class="switch sm" title="Chemin critique"><input type="checkbox" data-g="critical" ${G.critical ? 'checked' : ''}><span></span> Critique</label>
        <label class="switch sm"><input type="checkbox" data-g="showDone" ${G.showDone ? 'checked' : ''}><span></span> Faites</label>
        ${info('gantt')}
        <span class="spacer"></span>
        ${lateCount ? `<span class="badge danger" title="Tâches qui finiront après leur échéance">${icon('alert', 13)} ${lateCount}</span>` : ''}
        ${compact ? '' : `<button class="icon-btn" data-today title="Aujourd’hui" aria-label="Aujourd’hui">${icon('calendar', 18)}</button>`}
        <button class="icon-btn" data-newproj title="Nouveau projet" aria-label="Nouveau projet">${icon('plus', 18)}</button>
        <button class="icon-btn" data-pdf title="Export PDF" aria-label="Export PDF">${icon('pdf', 18)}</button>
      </div>
      ${empty ? `<div class="empty"><h3>Aucun projet planifié</h3>
        <button class="btn primary" data-newproj>${icon('plus', 16)} Créer un projet</button></div>`
        : compact ? `<div class="cg-wrap">${compactHtml(gs, an)}</div>`
        : `<div class="gantt-scroll">${ganttHtml(rows, an, from, to, { dayW, nameW })}</div>`}
    </section>`;

  bind(el, { from, dayW, nameW });
  if (!compact && !empty) {
    const sc = el.querySelector('.gantt-scroll');
    const saved = local.get('ganttScroll');
    sc.scrollLeft = saved && saved.zoom === G.zoom && saved.from === toDateStr(from) ? saved.x : Math.max(0, ((new Date() - from) / DAY) * dayW - 120);
    if (saved) sc.scrollTop = saved.y || 0;
    sc.addEventListener('scroll', () => local.set('ganttScroll', { x: sc.scrollLeft, y: sc.scrollTop, zoom: G.zoom, from: toDateStr(from) }), { passive: true });
  }
}

function bind(el, { from, dayW }) {
  const root = el.querySelector('.gantt-view');
  bindSliders(root, (name, v) => { if (name === 'zoom' && v !== G.zoom) { G.zoom = v; persist(); renderGantt(el); } });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-full]')) { G.mobileMode = e.target.checked ? 'full' : 'compact'; persist(); renderGantt(el); return; }
    const k = e.target.dataset.g;
    if (!k) return;
    G[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    persist(); renderGantt(el);
  });
  root.addEventListener('click', (e) => {
    const z = e.target.closest('[data-zoom]');
    if (z) { G.zoom = z.dataset.zoom; persist(); renderGantt(el); return; }
    const mm = e.target.closest('[data-mm]');
    if (mm) { G.mobileMode = mm.dataset.mm; persist(); renderGantt(el); return; }
    if (e.target.closest('[data-pdf]')) { exportPdf(); return; }
    if (e.target.closest('[data-newproj]')) { openProjectEditor(); return; }
    const ep = e.target.closest('[data-editproj]');
    if (ep) { openProjectEditor(ep.dataset.editproj); return; }
    if (e.target.closest('[data-today]')) {
      const sc = root.querySelector('.gantt-scroll');
      sc.scrollTo({ left: Math.max(0, ((new Date() - from) / DAY) * dayW - 120), behavior: 'smooth' });
      return;
    }
    const tg = e.target.closest('[data-toggle]');
    if (tg) { G.collapsed[tg.dataset.toggle] = !G.collapsed[tg.dataset.toggle]; persist(); renderGantt(el); return; }
    const pr = e.target.closest('[data-plan-row]');
    if (pr) {
      const t = db.tasks[pr.dataset.planRow];
      const r = pr.getBoundingClientRect();
      const day = addDays(from, Math.floor((e.clientX - r.left) / dayW));
      t.allDay = true;
      const n = Math.max(1, Math.ceil((t.estimate || 60) / (8 * 60)));
      setSpan(t, day, addDays(day, n));
      commit([t]);
      return;
    }
    const bar = e.target.closest('[data-bar]');
    if (bar) { openTaskEditor(bar.dataset.bar); return; }
    const open = e.target.closest('[data-open-task]');
    if (open) openTaskEditor(open.dataset.openTask);
  });

  const scroller = root.querySelector('.gantt-scroll');
  if (!scroller) return;
  let ghost = null, line = null, hl = null;
  enableDrag(root, {
    selector: '[data-bar]',
    onStart(st) {
      const t = db.tasks[st.el.dataset.bar];
      if (!t) return false;
      const mode = st.target.closest('[data-link]') ? 'link' : st.target.closest('[data-resize]') ? 'resize' : 'move';
      st.el.classList.add('dragging-bar');
      if (mode === 'link') {
        line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'g-linkline');
        root.querySelector('.g-arrows').appendChild(line);
        ghost = makeGhost('Relier à…', 'sm');
      }
      return { t, mode, left: parseFloat(st.el.style.left), width: parseFloat(st.el.style.width) };
    },
    onMove(st) {
      const d = st.data;
      autoScroll(scroller, st.x, st.y, 50, 16);
      const dx = st.x - st.x0;
      if (d.mode === 'move') {
        d.days = Math.round(dx / dayW);
        st.el.style.left = `${d.left + d.days * dayW}px`;
      } else if (d.mode === 'resize') {
        d.days = Math.round(dx / dayW);
        st.el.style.width = `${Math.max(dayW, d.width + d.days * dayW)}px`;
      } else {
        ghost.move(st.x, st.y);
        const tl = root.querySelector('.g-timeline').getBoundingClientRect();
        line.setAttribute('x1', d.left + d.width); line.setAttribute('y1', parseFloat(st.el.style.top) + 10);
        line.setAttribute('x2', st.x - tl.left); line.setAttribute('y2', st.y - tl.top);
        const target = dropTarget(st.x, st.y, '[data-bar], [data-open-task]');
        if (hl && hl !== target) { hl.classList.remove('drop-hl'); hl = null; }
        if (target && (target.dataset.bar || target.dataset.openTask) !== d.t.id) { hl = target; hl.classList.add('drop-hl'); }
        d.target = hl ? (hl.dataset.bar || hl.dataset.openTask) : null;
      }
    },
    onEnd(st, cancelled) {
      const d = st.data;
      ghost?.remove(); ghost = null; line?.remove(); line = null; hl?.classList.remove('drop-hl'); hl = null;
      if (cancelled) { renderGantt(el); return; }
      const t = d.t;
      if (d.mode === 'move' && d.days) {
        shiftTo(t, addDays(tStart(t), d.days));
        commit([t]);
      } else if (d.mode === 'resize' && d.days) {
        const s = tStart(t);
        const days = Math.max(1, Math.round((tEnd(t) - s) / DAY) + d.days);
        t.allDay = true;
        setSpan(t, s, addDays(startOfDay(s), days));
        commit([t]);
      } else if (d.mode === 'link' && d.target) {
        const succ = db.tasks[d.target];
        if (!succ) return;
        if (succ.preds.some((p) => p.id === t.id)) { toast('Ce lien existe déjà.'); return; }
        if (wouldCycle(succ.id, t.id)) { toast('Impossible : ce lien créerait une boucle.'); return; }
        succ.preds.push({ id: t.id, lag: 0 });
        putTask(succ, { silent: true });
        toast(`« ${succ.title} » commence désormais après « ${t.title} ».`);
        commit([t, succ]);
      } else renderGantt(el);
    },
  });
}

function commit(list) {
  let extra = '';
  for (const t of list) {
    const req = t.start && requiredStart(t);
    if (req && tStart(t) < req) { shiftTo(t, req); extra = ' Placée après la fin de ses prédécesseurs.'; }
    putTask(t, { silent: true });
  }
  const moved = propagate(list.map((t) => t.id));
  save('gantt');
  if (moved.size || extra) toast(`${moved.size ? `${moved.size} successeur${moved.size > 1 ? 's' : ''} décalé${moved.size > 1 ? 's' : ''} en cascade.` : ''}${extra}`);
}

// ---------- Export PDF (via l'impression du navigateur) ----------
export function exportPdf() {
  const { groups: gs, an } = groups();
  if (!gs.some((g) => g.planned.length)) { toast('Rien à exporter : aucune tâche planifiée.'); return; }
  const saved = G.collapsed;
  G.collapsed = {};
  const rows = buildRows(gs);
  G.collapsed = saved;
  const [from, to] = rangeFor(gs);
  const days = daysBetween(from, to);
  const nameW = 210;
  const dayW = Math.max(2, Math.min(34, (1060 - nameW) / days));
  const title = G.project && db.projects[G.project] ? db.projects[G.project].name : G.project === '_none' ? 'Sans projet' : 'Tous les projets';
  let area = document.getElementById('print-area');
  if (!area) { area = document.createElement('div'); area.id = 'print-area'; document.body.appendChild(area); }
  const lateN = Object.values(an).filter((a) => a.late).length;
  area.innerHTML = `
    <header class="print-head">
      <div><h1>Gantt — ${esc(title)}</h1><p>Gestion des plannings · édité le ${fmt.date.format(new Date())} · du ${fmt.date.format(from)} au ${fmt.date.format(addDays(to, -1))}</p></div>
      <div class="g-legend"><span><i class="lg late"></i>Critique (${lateN})</span><span><i class="lg critical"></i>Chemin critique</span><span><i class="lg dl"></i>Échéance</span></div>
    </header>
    <div class="print-gantt">${ganttHtml(rows, an, from, to, { dayW, nameW, print: true })}</div>
    ${resourcesSummary(gs)}`;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 100);
  toast('Choisissez « Enregistrer au format PDF » comme imprimante.');
}

function resourcesSummary(gs) {
  const use = {};
  for (const g of gs) for (const t of g.planned.concat(g.unplanned)) {
    for (const a of t.assign) {
      const r = db.resources[a.id]; if (!r) continue;
      use[r.id] = use[r.id] || { r, n: 0, qty: 0 };
      use[r.id].n++; use[r.id].qty += Number(a.qty) || 0;
    }
  }
  const list = Object.values(use);
  if (!list.length) return '';
  return `<section class="print-res"><h2>Ressources mobilisées</h2><table><thead><tr><th>Ressource</th><th>Type</th><th>Tâches</th><th>Quantité</th></tr></thead><tbody>
    ${list.map((u) => `<tr><td>${esc(u.r.name)}</td><td>${RES_TYPES[u.r.type].label}</td><td>${u.n}</td><td>${u.qty ? `${u.qty.toLocaleString('fr-FR')} ${RES_TYPES[u.r.type].unit}` : '—'}${u.r.type === 'budget' && u.r.capacity ? ` / ${Number(u.r.capacity).toLocaleString('fr-FR')} €` : ''}</td></tr>`).join('')}
  </tbody></table></section>`;
}
