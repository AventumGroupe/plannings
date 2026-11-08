// Onglet « Matrice » : urgence (horizontal) × importance (vertical), un panneau par énergie.
// On glisse une tâche pour changer son urgence, son importance ou son énergie.
// Chaque zone rappelle, dans une bulle, la décision à prendre selon le profil.

import { db, tasks, projects, putTask, local, setSettings, category, catInfo, isLeader, ENERGY, score } from './store.js';
import { openTaskEditor } from './editor.js';
import { enableDrag, makeGhost, dropTarget } from './drag.js';
import { slider, bindSliders, info, toast } from './ui.js';
import { esc, icon } from './util.js';

const M = Object.assign({ project: '', done: false }, local.get('matrix', {}));
const persist = () => local.set('matrix', M);

/** Décision à prendre par zone, selon le profil. */
const DECISIONS = {
  dirigeant: {
    priorite: 'Faire maintenant, soi-même. Bloquer un créneau aujourd’hui ou demain.',
    deleguer: 'Déléguer à un collaborateur ou automatiser. Garder seulement le contrôle du résultat et une date de retour.',
    planifier: 'Planifier dans l’agenda sur un créneau de bonne énergie. C’est ici que se construit l’avenir de l’entreprise.',
    collaborer: 'Planifier dans le temps et confier à un collaborateur, avec une échéance et un point d’étape.',
    cote: 'Laisser de côté : ne pas laisser l’urgence décider. À traiter en 5 minutes seulement si c’est vraiment rapide, sinon refuser ou reporter.',
    reste: 'Plus tard ou abandonner. Revoir une fois par semaine ce qui peut être supprimé.',
  },
  collaborateur: {
    priorite: 'Faire maintenant. Bloquer un créneau aujourd’hui ou demain.',
    deleguer: 'Au meilleur moment : tout début de matinée, en séance courte, puis enchaîner avec une tâche dynamisante. Prévenir son responsable si la charge est trop lourde.',
    planifier: 'Planifier dans l’agenda, de préférence quand l’énergie est haute.',
    collaborer: 'À planifier au calme : étaler en séances de 45 min sur plusieurs matinées, jamais deux tâches plombantes d’affilée.',
    cote: 'Laisser de côté. Si l’urgence est imposée, en parler à son responsable pour arbitrer.',
    reste: 'Plus tard. Revoir chaque semaine ce qui peut être abandonné.',
  },
};

// Zones : [catégorie dynamisante, catégorie plombante, colonnes (urgence), lignes (importance haut -> bas)]
const ZONES = [
  { key: 'ui', dyn: 'priorite', plomb: 'deleguer', u: [4, 5], i: [4, 5] },
  { key: 'i', dyn: 'planifier', plomb: 'collaborer', u: [1, 3], i: [4, 5] },
  { key: 'u', dyn: 'cote', plomb: 'cote', u: [4, 5], i: [1, 3] },
  { key: 'r', dyn: 'reste', plomb: 'reste', u: [1, 3], i: [1, 3] },
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
        ${here.map((t) => `<button data-drag-ok class="mx-dot e${t.energy} ${t.status === 'done' ? 'done' : ''} ${t.delegate ? 'deleg' : ''}" data-mx-task="${t.id}" title="${esc(t.title)} · U${t.urgency} I${t.importance} · ${ENERGY[t.energy].label}">
          <i></i><span>${esc(t.title)}</span></button>`).join('')}
      </div>`);
    }
  }
  const yAxis = [5, 4, 3, 2, 1].map((i) => `<span class="mx-ax y" style="grid-column:1;grid-row:${row(i)}">${i}</span>`).join('');
  const xAxis = [1, 2, 3, 4, 5].map((u) => `<span class="mx-ax x" style="grid-column:${col(u)};grid-row:6">${u}</span>`).join('');
  return `
    <section class="mx-panel ${kind}">
      <header class="mx-head">
        <i class="mx-swatch ${kind}"></i>
        <h3>${plomb ? 'Plombantes' : 'Dynamisantes'}</h3><small>${plomb ? 'énergie 1 – 2' : 'énergie 3 – 4'}</small>
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
  const dyn = all.filter((t) => t.energy >= 3);
  const plomb = all.filter((t) => t.energy <= 2);
  el.innerHTML = `
    <section class="view mx-view">
      <div class="mx-toolbar">
        <h2>Matrice</h2>${info('', 'Urgence en horizontal, importance en vertical, un panneau par énergie. Glissez une tâche pour la repositionner : son urgence, son importance (et son énergie si vous changez de panneau) sont mises à jour. Touchez-la pour ouvrir sa fiche. Les bulles « i » rappellent la décision à prendre selon votre profil.')}
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
      const before = category(t);
      t.urgency = Number(cell.dataset.u);
      t.importance = Number(cell.dataset.i);
      if (cell.dataset.panel === 'plomb' && t.energy >= 3) t.energy = 2;
      if (cell.dataset.panel === 'dyn' && t.energy <= 2) t.energy = 3;
      putTask(t);
      const after = category(t);
      if (after !== before) toast(`« ${t.title} » → ${catInfo(after).label}`);
    },
  });
}
