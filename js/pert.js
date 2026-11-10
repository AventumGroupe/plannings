// Diagramme PERT (réseau de tâches) : chaque tâche est une boîte avec début / fin au plus tôt,
// début / fin au plus tard et marge ; flèches = liens fin -> début ; chemin critique en rouge.

import { db, remainingOf, progressOf } from './store.js';
import { tStart, tEnd } from './sched.js';
import { esc, addDays, startOfDay, daysBetween, fmt, DAY } from './util.js';

const NW = 196, NH = 92, GX = 64, GY = 22, PAD = 30, CIRC = 22;

const durDays = (t) => (t.start ? Math.max(1, Math.round((tEnd(t) - tStart(t)) / DAY)) : Math.max(1, Math.ceil((remainingOf(t) || t.estimate || 60) / 240)));

/** Calcule le réseau d'un ensemble de tâches. */
function network(list) {
  const ids = new Set(list.map((t) => t.id));
  const preds = new Map(list.map((t) => [t.id, (t.preds || []).filter((p) => ids.has(p.id))]));
  const succs = new Map(list.map((t) => [t.id, []]));
  for (const t of list) for (const p of preds.get(t.id)) succs.get(p.id).push({ id: t.id, lag: p.lag || 0 });
  // ordre topologique
  const indeg = new Map(list.map((t) => [t.id, preds.get(t.id).length]));
  const q = list.filter((t) => !indeg.get(t.id)).map((t) => t.id);
  const order = [];
  while (q.length) { const id = q.shift(); order.push(id); for (const s of succs.get(id)) { indeg.set(s.id, indeg.get(s.id) - 1); if (!indeg.get(s.id)) q.push(s.id); } }
  const by = Object.fromEntries(list.map((t) => [t.id, t]));
  const origin = startOfDay(new Date(Math.min(...list.filter((t) => t.start).map((t) => tStart(t)), Date.now())));
  const N = {};
  for (const id of order) {
    const t = by[id], d = durDays(t);
    let es = t.start ? Math.max(0, daysBetween(origin, tStart(t))) : 0;
    let level = 0;
    for (const p of preds.get(id)) { es = Math.max(es, N[p.id].ef + (p.lag || 0)); level = Math.max(level, N[p.id].level + 1); }
    N[id] = { t, d, es, ef: es + d, level };
  }
  const end = Math.max(0, ...Object.values(N).map((n) => n.ef));
  for (const id of [...order].reverse()) {
    const n = N[id];
    let lf = end;
    for (const s of succs.get(id)) lf = Math.min(lf, N[s.id].ls - s.lag);
    n.lf = lf; n.ls = lf - n.d; n.slack = n.ls - n.es; n.critical = n.slack <= 0 && n.t.status !== 'done';
  }
  return { N, order, succs, preds, origin, end };
}

function svgFor(list, title, color) {
  const { N, order, succs, origin, end } = network(list);
  const cols = new Map();
  for (const id of order) { const n = N[id]; if (!cols.has(n.level)) cols.set(n.level, []); cols.get(n.level).push(n); }
  for (const c of cols.values()) c.sort((a, b) => a.es - b.es || a.t.title.localeCompare(b.t.title, 'fr'));
  const ncols = cols.size, nrows = Math.max(1, ...[...cols.values()].map((c) => c.length));
  const x0 = PAD + CIRC * 2 + GX / 2;
  const W = x0 + ncols * (NW + GX) + CIRC * 2 + PAD;
  const H = PAD * 2 + nrows * (NH + GY);
  for (const [lv, c] of cols) {
    const colH = c.length * (NH + GY) - GY;
    c.forEach((n, i) => { n.x = x0 + lv * (NW + GX); n.y = (H - colH) / 2 + i * (NH + GY); });
  }
  const dd = (k) => fmt.dateShort.format(addDays(origin, k));
  const sx = PAD + CIRC, sy = H / 2, ex = W - PAD - CIRC;
  const edges = [];
  const curve = (x1, y1, x2, y2, cls) => `<path class="pe ${cls}" d="M${x1},${y1} C${x1 + 36},${y1} ${x2 - 36},${y2} ${x2},${y2}" marker-end="url(#pa)"/>`;
  for (const id of order) {
    const n = N[id];
    if (!n.level) edges.push(curve(sx + CIRC, sy, n.x - 2, n.y + NH / 2, n.critical ? 'crit' : ''));
    if (!succs.get(id).length) edges.push(curve(n.x + NW, n.y + NH / 2, ex - CIRC - 2, sy, n.critical && n.ef === end ? 'crit' : ''));
    for (const s of succs.get(id)) {
      const m = N[s.id];
      edges.push(curve(n.x + NW, n.y + NH / 2, m.x - 2, m.y + NH / 2, n.critical && m.critical && n.ef + s.lag === m.es ? 'crit' : ''));
    }
  }
  const nodes = order.map((id) => {
    const n = N[id], t = n.t, pct = Math.round(progressOf(t) * 100);
    const cls = [n.critical ? 'crit' : '', t.status === 'done' ? 'done' : '', t.overrun ? 'late' : ''].join(' ');
    const name = t.title.length > 26 ? t.title.slice(0, 25) + '…' : t.title;
    return `<g class="pn ${cls}" data-open-task="${t.id}" transform="translate(${n.x},${n.y})">
      <title>${esc(t.title)} — durée ${n.d} j, marge ${n.slack} j</title>
      <rect width="${NW}" height="${NH}" rx="10" style="--pc:${color}"/>
      <rect class="pn-prog" x="1" y="${NH - 5}" width="${Math.max(0, (NW - 2) * pct / 100)}" height="4" rx="2"/>
      <line x1="0" y1="26" x2="${NW}" y2="26"/><line x1="0" y1="${NH - 26}" x2="${NW}" y2="${NH - 26}"/>
      <line x1="${NW / 3}" y1="0" x2="${NW / 3}" y2="26"/><line x1="${2 * NW / 3}" y1="0" x2="${2 * NW / 3}" y2="26"/>
      <line x1="${NW / 3}" y1="${NH - 26}" x2="${NW / 3}" y2="${NH}"/><line x1="${2 * NW / 3}" y1="${NH - 26}" x2="${2 * NW / 3}" y2="${NH}"/>
      <text class="pv" x="${NW / 6}" y="17">${dd(n.es)}</text>
      <text class="pv b" x="${NW / 2}" y="17">${n.d} j</text>
      <text class="pv" x="${5 * NW / 6}" y="17">${dd(n.ef - 1)}</text>
      <text class="pt" x="${NW / 2}" y="${NH / 2 + 5}">${t.status === 'done' ? '✓ ' : ''}${esc(name)}</text>
      <text class="pv" x="${NW / 6}" y="${NH - 9}">${dd(n.ls)}</text>
      <text class="pv b ${n.slack <= 0 ? 'z' : ''}" x="${NW / 2}" y="${NH - 9}">${n.slack <= 0 ? 'critique' : 'marge ' + n.slack + ' j'}</text>
      <text class="pv" x="${5 * NW / 6}" y="${NH - 9}">${dd(n.lf - 1)}</text>
    </g>`;
  }).join('');
  return `<section class="pert-net">
    <header><i class="dot" style="background:${color}"></i><b>${esc(title)}</b><small>${order.length} tâches · ${end} jours · fin au plus tôt ${end ? dd(end - 1) : '—'}</small></header>
    <div class="pert-scroll"><svg class="pert" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs><marker id="pa" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>
      ${edges.join('')}
      <g class="pc"><circle cx="${sx}" cy="${sy}" r="${CIRC}"/><text x="${sx}" y="${sy + 4}">Début</text></g>
      <g class="pc"><circle cx="${ex}" cy="${sy}" r="${CIRC}"/><text x="${ex}" y="${sy + 4}">Fin</text></g>
      ${nodes}
    </svg></div>
  </section>`;
}

/** groups : [{ p, planned, unplanned }] (ceux du Gantt) */
export function pertHtml(groups) {
  const nets = groups.map((g) => ({ list: g.planned.concat(g.unplanned), p: g.p })).filter((x) => x.list.length);
  if (!nets.length) return '<div class="empty"><p>Aucune tâche à afficher.</p></div>';
  return `<div class="pert-legend">
      <span><i class="lg late"></i>Chemin critique : aucun retard possible</span>
      <span>Boîte : en haut début au plus tôt · durée · fin au plus tôt ; en bas début au plus tard · marge · fin au plus tard</span>
    </div>
    ${nets.map((n) => svgFor(n.list, n.p ? n.p.name : 'Sans projet', n.p?.color || 'var(--accent)')).join('')}`;
}
