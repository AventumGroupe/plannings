// Onglet « Liste » : toutes les tâches tranchées, en tableau groupé par décision (façon Monday).
// Sur téléphone, chaque ligne devient une carte. Les tâches à trancher sont dans l'onglet Décision.

import {
  db, tasks, projects, putTask, removeTask, save, local, score, uiScore, emScore, effUrgency, category, catInfo,
  DECISIONS, needsDecision, isDeferred, abandons, spentOf, progressOf, ENERGY,
} from './store.js';
import { completeTask, propagate, analyze } from './sched.js';
import { openTaskEditor } from './editor.js';
import { info, toast, ring, scoreBadges, openDialog } from './ui.js';
import { esc, icon, fmt, cap, toDateStr, fmtDuration } from './util.js';
import { toDecideCount } from './decision.js';
import { notifyDone, SHARE_LABEL } from './team.js';

const F = Object.assign({ q: '', project: '', status: 'open', closed: { reporter: true, plustard: true } }, local.get('listV3', {}));
const persist = () => local.set('listV3', F);

const GROUPS = ['prioriser', 'expedier', 'planifier', 'decouper', 'deleguer', 'manager', 'valider', 'aide', 'negocier', 'automatiser', 'regrouper', 'plustard', 'reporter'];
const GROUP_COLOR = { prioriser: 'var(--danger)', expedier: 'var(--warn)', planifier: 'var(--accent)', decouper: '#7a5fd1', deleguer: '#d9792b', manager: '#d9792b', valider: '#d9792b', aide: '#2a9bb5', negocier: '#c8a52a', automatiser: '#2fa37a', regrouper: '#2a9bb5', plustard: 'var(--muted)', reporter: 'var(--muted)', done: 'var(--ok)' };
const STATUS_PILL = { todo: ['À faire', 'st-todo'], doing: ['En cours', 'st-doing'], done: ['Fait', 'st-done'] };
const sc = { uiScore, emScore, effUrgency };

function filtered() {
  const q = F.q.trim().toLowerCase();
  return tasks().filter((t) => {
    if (needsDecision(t)) return false;
    if (F.status === 'open' && t.status === 'done') return false;
    if (F.status === 'done' && t.status !== 'done') return false;
    if (F.project === '_none' && t.projectId) return false;
    if (F.project && F.project !== '_none' && t.projectId !== F.project) return false;
    if (q && !`${t.title} ${t.notes}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function rowHtml(t, an) {
  const p = t.projectId && db.projects[t.projectId];
  const [stl, stc] = STATUS_PILL[t.status] || STATUS_PILL.todo;
  const dec = t.decision?.key;
  const who = t.delegate && db.resources[t.delegate] ? db.resources[t.delegate].name : 'Moi';
  const late = an[t.id]?.late || (t.due && t.due < toDateStr(new Date()) && t.status !== 'done');
  const due = t.due ? fmt.dateShort.format(new Date(t.due + 'T00:00')) : '—';
  const sp = spentOf(t);
  return `<div class="lt-row ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}" style="--gc:${GROUP_COLOR[dec] || 'var(--line)'}">
    <span class="lt-c lt-check"><button class="chk ${t.status === 'done' ? 'on' : ''}" data-check aria-label="Terminer">${t.status === 'done' ? icon('check', 14) : ''}</button></span>
    <button class="lt-c lt-title" data-open><b>${esc(t.title)}</b>${t.subtasks?.length ? `<small>${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length} étapes</small>` : ''}${t.mail ? '<small>✉ mail</small>' : ''}${(t.slips || 0) >= 3 ? `<small class="danger-text">repoussée ×${t.slips}</small>` : ''}${t.shared ? `<small class="share-st st-${t.shared.status}">${t.shared.role === 'a' ? `de ${esc(t.shared.from)}` : `→ ${esc(t.shared.to)}`} · ${SHARE_LABEL[t.shared.status] || ''}${t.shared.motif && t.shared.status === 'refusee' ? ' : ' + esc(t.shared.motif) : ''}</small>` : ''}</button>
    <span class="lt-c lt-status"><button class="pill ${stc}" data-status title="Changer le statut">${stl}</button></span>
    <span class="lt-c lt-scores">${scoreBadges(t, sc)}</span>
    <span class="lt-c lt-dec"><button class="pill dec" style="--pc:${GROUP_COLOR[dec] || 'var(--muted)'}" data-dec title="Changer la décision">${esc(DECISIONS[dec]?.label || '—')}</button></span>
    <span class="lt-c lt-proj">${p ? `<span class="chip project" style="--pc:${esc(p.color)}"><i></i>${esc(p.name)}</span>` : '<span class="muted">—</span>'}</span>
    <span class="lt-c lt-due ${late ? 'late' : ''}">${due}${t.start ? `<small>${cap(fmt.dayShort.format(new Date(t.start)))}</small>` : ''}</span>
    <span class="lt-c lt-who">${t.delegate ? `<span class="avatar sm">${esc(who.slice(0, 1).toUpperCase())}</span>` : ''}${esc(who)}</span>
    <span class="lt-c lt-load">${ring(progressOf(t), 30)}<small>${sp ? fmtDuration(sp) + ' / ' : ''}${fmtDuration(t.estimate || 60)}</small></span>
  </div>`;
}

export function renderList(el) {
  const an = analyze();
  const list = filtered().sort((a, b) => score(b) - score(a));
  const groups = new Map();
  for (const t of list) {
    const k = t.status === 'done' ? 'done' : isDeferred(t) ? 'reporter' : (GROUPS.includes(t.decision?.key) ? t.decision.key : 'plustard');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const nDecide = toDecideCount();
  const ab = abandons();
  el.innerHTML = `<section class="view lt-view">
    <header class="lt-top"><h2>Liste</h2>
      <label class="search">${icon('search', 16)}<input type="search" placeholder="Rechercher" value="${esc(F.q)}" data-f="q"></label>
      <select data-f="project" aria-label="Projet"><option value="">Tous les projets</option><option value="_none" ${F.project === '_none' ? 'selected' : ''}>Sans projet</option>${projects().map((p) => `<option value="${p.id}" ${F.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <select data-f="status" aria-label="Statut"><option value="open" ${F.status === 'open' ? 'selected' : ''}>À faire</option><option value="all" ${F.status === 'all' ? 'selected' : ''}>Toutes</option><option value="done" ${F.status === 'done' ? 'selected' : ''}>Faites</option></select>
    </header>
    ${nDecide ? `<a class="card lt-banner" href="#decision">${icon('bulb', 18)}<span><b>${nDecide} tâche${nDecide > 1 ? 's' : ''} à trancher</b> : elles n’apparaissent ici qu’une fois décidées.</span><span class="btn primary sm">Trancher</span></a>` : ''}
    <div class="lt-table">
      <div class="lt-head"><span></span><span>Tâche</span><span>Statut</span><span>Scores ${info('criteres')}</span><span>Décision</span><span>Projet</span><span>Échéance</span><span>Responsable</span><span>Charge</span></div>
      ${[...GROUPS, 'done'].filter((k) => groups.has(k)).map((k) => {
        const items = groups.get(k), closed = F.closed[k];
        const label = k === 'done' ? 'Faites' : k === 'reporter' ? 'Reportées (masquées jusqu’à leur date)' : DECISIONS[k].label;
        return `<section class="lt-group" style="--gc:${GROUP_COLOR[k]}">
          <header class="lt-ghead" data-grp="${k}"><span class="caret ${closed ? '' : 'open'}">${icon('chevR', 14)}</span><b>${esc(label)}</b><span class="count">${items.length}</span>
            <small>${fmtDuration(items.reduce((m, t) => m + Math.max(0, (t.estimate || 60) - spentOf(t)), 0))} restantes</small></header>
          ${closed ? '' : items.map((t) => rowHtml(t, an)).join('')}
        </section>`;
      }).join('') || `<div class="empty"><p>${tasks().length ? 'Aucune tâche pour ces filtres.' : 'Aucune tâche. Touchez ＋ pour en créer une.'}</p></div>`}
    </div>
    ${ab.length ? `<button class="link lt-journal" data-journal>${icon('trash', 14)} Journal des renoncements (${ab.length})</button>` : ''}
  </section>`;
  bind(el);
}

function bind(el) {
  const root = el.querySelector('.lt-view');
  root.querySelectorAll('[data-f]').forEach((i) => i.addEventListener(i.type === 'search' ? 'input' : 'change', () => {
    F[i.dataset.f] = i.value; persist();
    if (i.type === 'search') { clearTimeout(i._t); i._t = setTimeout(() => { renderList(el); const s = el.querySelector('input[type="search"]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 200); }
    else renderList(el);
  }));
  root.addEventListener('click', (e) => {
    const q = (s) => e.target.closest(s);
    const g = q('[data-grp]'); if (g && !q('.info')) { F.closed[g.dataset.grp] = !F.closed[g.dataset.grp]; persist(); renderList(el); return; }
    if (q('[data-journal]')) { openJournal(); return; }
    const row = q('.lt-row'); if (!row) return;
    const t = db.tasks[row.dataset.id]; if (!t) return;
    if (q('[data-check]')) { toggleDone(t); return; }
    if (q('[data-status]')) { const nx = { todo: 'doing', doing: 'done', done: 'todo' }[t.status] || 'todo'; if (nx === 'done') { toggleDone(t); return; } t.status = nx; t.doneAt = null; putTask(t); return; }
    if (q('[data-dec]')) { decisionMenu(t, q('[data-dec]')); return; }
    if (q('[data-open]')) openTaskEditor(t.id);
  });
}

/** Petit menu : changer la décision ou renvoyer la tâche dans l'onglet Décision. */
function decisionMenu(t, anchor) {
  const { el, close } = openDialog({
    title: 'Décision',
    body: `<p class="muted">« ${esc(t.title)} » — ${esc(catInfo(category(t)).label)}</p>
      <div class="dec-menu">${Object.keys(DECISIONS).filter((k) => !['abandon', 'refuser', 'deleguer', 'reporter', 'negocier', 'decouper'].includes(k)).map((k) => `<button class="chip ${t.decision?.key === k ? 'on' : ''}" data-k="${k}">${esc(DECISIONS[k].label)}</button>`).join('')}</div>
      <button class="btn" data-back>${icon('bulb', 16)} Trancher de nouveau (onglet Décision)</button>`,
  });
  el.addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]');
    if (k) { t.decision = { key: k.dataset.k, at: Date.now() }; if (k.dataset.k === 'automatiser') t.automate = true; putTask(t); close(); return; }
    if (e.target.closest('[data-back]')) { t.decision = null; putTask(t); close(); location.hash = '#decision'; }
  });
}

function openJournal() {
  const ab = abandons();
  openDialog({
    title: 'Journal des renoncements', wide: true,
    body: `<p class="hint">Les tâches abandonnées ou refusées, pour le bilan.</p>
      <ul class="journal">${ab.map((a) => `<li><span><b>${esc(a.title)}</b><small>${fmt.date.format(new Date(a.at))}${a.project ? ' · ' + esc(a.project) : ''} · Eisenhower ${a.ui}/25 · énergie ${a.em}/16</small>${a.reason ? `<em>${esc(a.reason)}</em>` : ''}</span></li>`).join('')}</ul>`,
  });
}

export function toggleDone(t) {
  const real = t;
  if (t.status === 'done') { real.status = 'todo'; real.doneAt = null; putTask(real); return; }
  const prev = t.status;
  const next = completeTask(real);
  notifyDone(real);
  propagate([real.id]);
  save('task');
  toast(next ? 'Bravo ! Prochaine occurrence créée.' : 'Bravo, tâche terminée !', {
    action: { label: 'Annuler', run: () => { real.status = prev; real.doneAt = null; real.recurSpawned = false; putTask(real, { silent: true }); if (next) removeTask(next.id); else save('task'); } },
  });
}
