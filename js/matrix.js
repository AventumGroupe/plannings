// Onglet « Matrice » : Eisenhower (urgent × important) en 4 quadrants de même taille,
// chacun coupé en deux selon le score énergie × motivation (haut ≥ 9 / bas) : les 8 situations.
// On glisse une tâche d'une case à l'autre pour la repositionner ; on la touche pour ouvrir sa fiche.

import {
  db, tasks, projects, putTask, local, setSettings, category, catInfo, isLeader, score, progressOf,
  uiScore, emScore, effUrgency, isUrgent, isImportant, DECISIONS, decisionsFor, needsDecision,
} from './store.js';
import { openTaskEditor } from './editor.js';
import { enableDrag, makeGhost, dropTarget } from './drag.js';
import { slider, bindSliders, info, toast, scoreBadges } from './ui.js';
import { esc, icon, fmtDuration } from './util.js';

const M = Object.assign({ project: '', done: false }, local.get('matrix', {}));
const persist = () => local.set('matrix', M);
const sc = { uiScore, emScore, effUrgency };

// Colonnes : urgent | pas urgent ; lignes : important | pas important ; demi-case : énergie × motivation haute | basse
const QUADS = [
  { u: true, i: true, title: 'Urgent et important', cells: ['prioriser', 'urg_lourd'] },
  { u: false, i: true, title: 'Important, pas urgent', cells: ['planifier', 'imp_lourd'] },
  { u: true, i: false, title: 'Urgent, pas important', cells: ['expedier', 'urg_second'] },
  { u: false, i: false, title: 'Ni urgent ni important', cells: ['plustard', 'abandon'] },
];

function card(t) {
  const dec = t.decision?.key;
  return `<button data-drag-ok class="mx-card e${t.energy} ${t.status === 'done' ? 'done' : ''}" data-mx-task="${t.id}" style="--pr:${Math.round(progressOf(t) * 100)}%">
    <b>${esc(t.title)}</b>
    <span class="mx-card-meta">${scoreBadges(t, sc)}${needsDecision(t) ? '<span class="badge warn">à trancher</span>' : dec ? `<span class="badge muted">${esc(DECISIONS[dec]?.label || '')}</span>` : ''}${t.delegate ? '<span class="badge accent">confiée</span>' : ''}</span>
    <i class="mx-prog"></i>
  </button>`;
}

function cellHtml(q, key, high, list) {
  const ci = catInfo(key);
  const here = list.filter((t) => category(t) === key).sort((a, b) => score(b) - score(a));
  const reco = DECISIONS[decisionsFor({ urgency: q.u ? 5 : 1, importance: q.i ? 5 : 1, energy: high ? 4 : 1, motivation: high ? 4 : 1, estimate: 60 })[0]];
  return `<div class="mx-cell c-${key}" data-cell data-u="${q.u ? 1 : 0}" data-i="${q.i ? 1 : 0}" data-em="${high ? 1 : 0}">
    <header><span class="mx-em">${high ? '⚡ haute' : '⚡ basse'}</span><b>${esc(ci.label)}</b><span class="count">${here.length}</span>${info('', `${ci.label} — ${ci.hint} Décision recommandée : ${reco?.label || ''}.`)}</header>
    <div class="mx-cards">${here.map(card).join('') || '<p class="mx-empty">—</p>'}</div>
  </div>`;
}

export function renderMatrix(el) {
  const all = tasks().filter((t) => (M.done || t.status !== 'done') && (!M.project || (M.project === '_none' ? !t.projectId : t.projectId === M.project)));
  el.innerHTML = `
    <section class="view mx-view v3">
      <div class="mx-toolbar">
        <h2>Matrice</h2>${info('', 'Colonnes : urgent / pas urgent. Lignes : important / pas important (seuil : 4 sur 5 ; l’urgence monte seule à l’approche de l’échéance). Chaque quadrant est coupé en deux selon votre score énergie × motivation (haut à partir de 9 sur 16). Glissez une tâche pour la repositionner, touchez-la pour ouvrir sa fiche.')}
        <span class="spacer"></span>
        ${slider('mxrole', { values: ['dirigeant', 'collaborateur'], labels: ['Dirigeant', 'Salarié'], value: db.settings.role || 'dirigeant', ticks: 'labels', compact: true })}
        <select data-mx="project" aria-label="Projet">
          <option value="">Tous les projets</option><option value="_none" ${M.project === '_none' ? 'selected' : ''}>Sans projet</option>
          ${projects().map((p) => `<option value="${p.id}" ${M.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <label class="switch sm"><input type="checkbox" data-mx="done" ${M.done ? 'checked' : ''}><span></span> Faites</label>
      </div>
      <div class="mx2">
        <span class="mx2-corner"></span>
        <div class="mx2-colh urgent">${icon('alert', 16)} Urgent</div>
        <div class="mx2-colh">Pas urgent</div>
        <div class="mx2-rowh important"><span>Important</span></div>
        ${QUADS.slice(0, 2).map((q) => `<section class="mx-quad"><h3>${esc(q.title)}</h3><div class="mx-halves">${cellHtml(q, q.cells[0], true, all)}${cellHtml(q, q.cells[1], false, all)}</div></section>`).join('')}
        <div class="mx2-rowh"><span>Pas important</span></div>
        ${QUADS.slice(2).map((q) => `<section class="mx-quad"><h3>${esc(q.title)}</h3><div class="mx-halves">${cellHtml(q, q.cells[0], true, all)}${cellHtml(q, q.cells[1], false, all)}</div></section>`).join('')}
      </div>
      ${all.length ? '' : `<div class="empty"><p>Aucune tâche à positionner. Touchez ＋ pour en créer une.</p></div>`}
    </section>`;
  bind(el);
}

/** Repositionne une tâche dans la case visée (urgent ? important ? énergie × motivation haute ?). */
function moveTo(t, u, i, high) {
  const before = category(t);
  if (u && !isUrgent(t)) t.urgency = 4;
  if (!u && isUrgent(t)) t.urgency = 3;
  if (i && !isImportant(t)) t.importance = 4;
  if (!i && isImportant(t)) t.importance = 3;
  const m = t.motivation || 2;
  if (high && t.energy * m < 9) { t.motivation = Math.min(4, Math.ceil(9 / t.energy)); if (t.energy * t.motivation < 9) t.energy = Math.min(4, Math.ceil(9 / t.motivation)); }
  if (!high && t.energy * m >= 9) t.motivation = Math.max(1, Math.floor(8 / t.energy));
  t.decision = null; // nouvelle situation : à trancher de nouveau
  putTask(t);
  const after = category(t);
  if (!u && isUrgent(t)) toast('L’échéance est proche : la tâche reste urgente.');
  else if (after !== before) toast(`« ${t.title} » → ${catInfo(after).label} (à trancher dans Décision)`);
}

function bind(el) {
  const root = el.querySelector('.mx-view');
  bindSliders(root, (name, v, final) => { if (name === 'mxrole' && final && v !== db.settings.role) setSettings({ role: v }); });
  root.addEventListener('change', (e) => {
    const k = e.target.dataset.mx;
    if (!k) return;
    M[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    persist(); renderMatrix(el);
  });
  root.addEventListener('click', (e) => {
    const d = e.target.closest('[data-mx-task]');
    if (d) openTaskEditor(d.dataset.mxTask);
  });
  let ghost = null, hl = null;
  enableDrag(root, {
    selector: '[data-mx-task]',
    onStart(st) {
      const t = db.tasks[st.el.dataset.mxTask];
      if (!t) return false;
      st.el.classList.add('drag-src');
      ghost = makeGhost(`<b>${esc(t.title)}</b>`, `e${t.energy}`);
      return { t };
    },
    onMove(st) {
      ghost?.move(st.x, st.y);
      const c = dropTarget(st.x, st.y, '[data-cell]');
      if (hl && hl !== c) { hl.classList.remove('drop-hl'); hl = null; }
      if (c) { hl = c; hl.classList.add('drop-hl'); }
      st.data.cell = c;
    },
    onEnd(st, cancelled) {
      ghost?.remove(); ghost = null; hl?.classList.remove('drop-hl'); hl = null;
      st.el.classList.remove('drag-src');
      const { t, cell } = st.data;
      if (cancelled || !cell) return;
      moveTo(t, cell.dataset.u === '1', cell.dataset.i === '1', cell.dataset.em === '1');
    },
  });
}
