// Onglet « Matrice » : urgence (horizontal) × importance (vertical), un panneau par énergie.
// On glisse une tâche pour changer son urgence, son importance ou son énergie.
// Chaque zone rappelle, dans une bulle, la décision à prendre selon le profil.

import { db, tasks, projects, putTask, local, setSettings, category, catInfo, isLeader, ENERGY, score, progressOf, emScore } from './store.js';
import { openTaskEditor } from './editor.js';
import { enableDrag, makeGhost, dropTarget } from './drag.js';
import { slider, bindSliders, info, toast } from './ui.js';
import { esc, icon, fmtDuration } from './util.js';
import { adviceHtml, runAdvice } from './advice.js';
import { openDialog } from './ui.js';

const M = Object.assign({ project: '', done: false }, local.get('matrix', {}));
const persist = () => local.set('matrix', M);

/** Décision à prendre par zone : texte de la situation, selon le profil (v3). */
const DECISIONS = new Proxy({}, { get: () => new Proxy({}, { get: (_, k) => catInfo(k).hint }) });

// Zones : [catégorie dynamisante, catégorie plombante, colonnes (urgence), lignes (importance haut -> bas)]
const ZONES = [
  { key: 'ui', dyn: 'prioriser', plomb: 'urg_lourd', u: [4, 5], i: [4, 5] },
  { key: 'i', dyn: 'planifier', plomb: 'imp_lourd', u: [1, 3], i: [4, 5] },
  { key: 'u', dyn: 'expedier', plomb: 'urg_second', u: [4, 5], i: [1, 3] },
  { key: 'r', dyn: 'plustard', plomb: 'abandon', u: [1, 3], i: [1, 3] },
];
const col = (u) => u + 1;          // colonne 1 = axe
const row = (i) => 6 - i;          // importance 5 en haut (ligne 1)

function panelHtml(kind, list) {
  const plomb = kind === 'plomb';
  const prof = isLeader() ? 'dirigeant' : 'collaborateur';
  const zones = ZONES.map((z) => {
    const cat = plomb ? z.plomb : z.dyn;
    const c = catInfo(cat);
    const n = list.filter((t) => category(t) === cat).length;
    const gc = `${col(z.u[0])} / ${col(z.u[1]) + 1}`;
    return `<div class="mx-zone c-${cat}" style="grid-column:${gc};grid-row:${row(z.i[1])} / ${row(z.i[0]) + 1}"></div>
      <div class="mx-zlabel c-${cat}" style="grid-column:${gc};grid-row:${row(z.i[0])}"><b>${esc(c.label)}</b>${n ? `<span class="count">${n}</span>` : ''}${info('', `${c.label} — ${DECISIONS[prof][cat]}`)}</div>`;
  }).join('');
  const cells = [];
  for (let i = 5; i >= 1; i--) {
    for (let u = 1; u <= 5; u++) {
      const here = list.filter((t) => t.urgency === u && t.importance === i).sort((a, b) => score(b) - score(a));
      cells.push(`<div class="mx-cell" data-cell data-u="${u}" data-i="${i}" data-panel="${kind}" style="grid-column:${col(u)};grid-row:${row(i)}">
        ${here.map((t) => { const dm = t.estimate || 60; const sz = dm <= 15 ? 's' : dm <= 60 ? 'm' : 'l'; return `<button data-drag-ok style="--pr:${Math.round(progressOf(t) * 100)}%" class="mx-dot sz-${sz} e${t.energy} ${t.status === 'done' ? 'done' : ''} ${t.delegate ? 'deleg' : ''} ${t.automate ? 'auto' : ''}" data-mx-task="${t.id}" title="${esc(t.title)} · U${t.urgency} I${t.importance} · ${ENERGY[t.energy].label} · ${fmtDuration(dm)}">
          <i></i><span>${esc(t.title)}</span><em>${Math.round(progressOf(t) * 100) ? Math.round(progressOf(t) * 100) + ' %' : esc(fmtDuration(dm).replace(' min', '′'))}</em></button>`; }).join('')}
      </div>`);
    }
  }
  const yAxis = [5, 4, 3, 2, 1].map((i) => `<span class="mx-ax y" style="grid-column:1;grid-row:${row(i)}">${i}</span>`).join('');
  const xAxis = [1, 2, 3, 4, 5].map((u) => `<span class="mx-ax x" style="grid-column:${col(u)};grid-row:6">${u}</span>`).join('');
  return `
    <section class="mx-panel ${kind}">
      <header class="mx-head">
        <i class="mx-swatch ${kind}"></i>
        <h3>${plomb ? 'Énergie × motivation basse' : 'Énergie × motivation haute'}</h3><small>${plomb ? 'score < 9' : 'score ≥ 9'}</small>
        <span class="count">${list.length}</span>
      </header>
      <div class="mx-grid">
        ${zones}${cells.join('')}${yAxis}${xAxis}
        <span class="mx-axname y">Importance ↑</span>
        <span class="mx-axname x">Urgence →</span>
      </div>
    </section>`;
}

export function renderMatrix(el) {
  const all = tasks().filter((t) => (M.done || t.status !== 'done') && (!M.project || (M.project === '_none' ? !t.projectId : t.projectId === M.project)));
  const dyn = all.filter((t) => emScore(t) >= 9);
  const plomb = all.filter((t) => emScore(t) < 9);
  el.innerHTML = `
    <section class="view mx-view">
      <div class="mx-toolbar">
        <h2>Matrice</h2>${info('', 'Urgence en horizontal, importance en vertical, un panneau par énergie ; la taille de la pastille indique la durée. Glissez une tâche pour la repositionner. Touchez-la pour voir « Que faire ? » : préconisations détaillées et actions. Les bulles « i » des zones rappellent la décision selon votre profil.')}
        <span class="spacer"></span>
        ${slider('mxrole', { values: ['dirigeant', 'collaborateur'], labels: ['Dirigeant', 'Collaborateur'], value: db.settings.role || 'dirigeant', ticks: 'labels', compact: true })}
        <select data-mx="project" aria-label="Projet">
          <option value="">Tous les projets</option><option value="_none" ${M.project === '_none' ? 'selected' : ''}>Sans projet</option>
          ${projects().map((p) => `<option value="${p.id}" ${M.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <label class="switch sm"><input type="checkbox" data-mx="done" ${M.done ? 'checked' : ''}><span></span> Faites</label>
      </div>
      <div class="mx-panels">${panelHtml('dyn', dyn)}${panelHtml('plomb', plomb)}</div>
      ${all.length ? '' : `<div class="empty"><p>Aucune tâche à positionner. Touchez ＋ pour en créer une.</p></div>`}
    </section>`;
  bind(el);
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
    if (d) openAdvice(d.dataset.mxTask);
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
      const before = category(t);
      t.urgency = Number(cell.dataset.u);
      t.importance = Number(cell.dataset.i);
      // Changer de panneau : la motivation est ajustée pour franchir le seuil de 9
      if (cell.dataset.panel === 'plomb' && emScore(t) >= 9) t.motivation = Math.max(1, Math.floor(8 / t.energy));
      if (cell.dataset.panel === 'dyn' && emScore(t) < 9) { t.motivation = Math.min(4, Math.ceil(9 / t.energy)); if (t.energy * t.motivation < 9) t.energy = Math.min(4, Math.ceil(9 / t.motivation)); }
      putTask(t);
      const after = category(t);
      if (after !== before) toast(`« ${t.title} » → ${catInfo(after).label}`);
    },
  });
}

/** Fenêtre « Que faire ? » d'une tâche : préconisations et actions. */
export function openAdvice(id) {
  const t = db.tasks[id];
  if (!t) return;
  const { el, close } = openDialog({
    title: t.title,
    body: adviceHtml(t),
    footer: `<span class="spacer"></span><button type="button" class="btn ghost" data-close>Fermer</button><button type="button" class="btn primary" data-open>Ouvrir la fiche</button>`,
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-adv]');
    if (b) { const msg = runAdvice(db.tasks[id], b.dataset.adv); close(); if (msg) toast(msg); return; }
    if (e.target.closest('[data-open]')) { close(); openTaskEditor(id); }
  });
}
