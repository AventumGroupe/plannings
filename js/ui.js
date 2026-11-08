// Composants d'interface partagés : fenêtres, notifications, sélecteurs, pastilles.

import { esc, icon, fmt, cap, parse, sameDay, addDays } from './util.js';
import { db, ENERGY, LEVELS, RES_TYPES } from './store.js';

// ---------- Messages éphémères ----------
export function toast(msg, { action, timeout = 3800, tone = '' } = {}) {
  let host = document.getElementById('toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const t = document.createElement('div');
  t.className = `toast ${tone}`;
  t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="btn ghost sm">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { action.run(); t.remove(); };
  host.appendChild(t);
  setTimeout(() => t.classList.add('out'), timeout);
  setTimeout(() => t.remove(), timeout + 400);
}

// ---------- Fenêtres ----------
export function openDialog({ title, body, footer = '', onMount, wide = false, onClose }) {
  const d = document.createElement('dialog');
  d.className = `sheet${wide ? ' wide' : ''}`;
  d.innerHTML = `
    <form method="dialog" class="sheet-inner" novalidate>
      <header class="sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Fermer">${icon('close')}</button>
      </header>
      <div class="sheet-body">${body}</div>
      ${footer ? `<footer class="sheet-foot">${footer}</footer>` : ''}
    </form>`;
  document.body.appendChild(d);
  const close = () => { d.close(); };
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  d.addEventListener('click', (e) => {
    if (e.target === d) close();
    if (e.target.closest('[data-close]')) close();
  });
  d.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
  d.showModal();
  onMount?.(d, close);
  return { el: d, close };
}

export function confirmDialog(text, { ok = 'Supprimer', danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const { el, close } = openDialog({
      title: 'Confirmation',
      body: `<p>${esc(text)}</p>`,
      footer: `<button type="button" class="btn ghost" data-close>Annuler</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    el.querySelector('[data-ok]').onclick = () => { done = true; resolve(true); close(); };
  });
}

// ---------- Sélecteur segmenté ----------
export function seg(name, options, value, extra = '') {
  return `<div class="seg ${extra}" role="radiogroup" data-seg="${name}">${options.map((o) => `
    <button type="button" role="radio" class="seg-opt${String(o.v) === String(value) ? ' on' : ''}" data-v="${o.v}"
      aria-checked="${String(o.v) === String(value)}" title="${esc(o.title || o.sub || '')}" ${o.style ? `style="${o.style}"` : ''}>
      <b>${esc(o.label)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}
    </button>`).join('')}</div>`;
}
/** Branche les sélecteurs segmentés : onPick(name, value). */
export function bindSeg(root, onPick) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-opt');
    if (!b) return;
    const g = b.closest('[data-seg]');
    g.querySelectorAll('.seg-opt').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
    onPick(g.dataset.seg, b.dataset.v);
  });
}

export const levelOptions = (short = false) =>
  [1, 2, 3, 4, 5].map((v) => ({ v, label: String(v), sub: short ? '' : LEVELS[v], title: LEVELS[v] }));
export const energyOptions = (short = false) =>
  [1, 2, 3, 4].map((v) => ({ v, label: short ? String(v) : ENERGY[v].label, sub: short ? '' : String(v), title: `${ENERGY[v].label} — ${ENERGY[v].hint}`, style: `--c: var(--e${v})` }));

// ---------- Pastilles ----------
export const energyChip = (e, withLabel = true) =>
  `<span class="chip energy e${e}" title="Énergie : ${ENERGY[e].label}">${icon('sun', 13)}${withLabel ? ENERGY[e].label : e}</span>`;

export const levelChip = (kind, n) =>
  `<span class="lvl lvl${n}" title="${kind === 'U' ? 'Urgence' : 'Importance'} : ${n}/5 (${LEVELS[n]})"><i>${kind}</i>${n}</span>`;

export function projectChip(p) {
  if (!p) return '';
  return `<span class="chip project" style="--pc:${esc(p.color)}"><i></i>${esc(p.name)}</span>`;
}

export function resourceChip(r, qty) {
  if (!r) return '';
  const u = RES_TYPES[r.type]?.unit || '';
  return `<span class="chip res t-${r.type}" title="${esc(RES_TYPES[r.type]?.label || '')}">${esc(r.name)}${qty ? ` · ${esc(qty)}${u ? ' ' + u : ''}` : ''}</span>`;
}

export function whenLabel(t) {
  if (!t.start) return '';
  const s = parse(t.start);
  const today = new Date();
  const dayTxt = sameDay(s, today) ? 'Aujourd’hui' : sameDay(s, addDays(today, 1)) ? 'Demain' : cap(fmt.dayShort.format(s));
  if (t.allDay) {
    const e = parse(t.end || t.start);
    return sameDay(s, e) ? dayTxt : `${dayTxt} → ${fmt.dateShort.format(e)}`;
  }
  return `${dayTxt} ${fmt.time.format(s)}`;
}

export function dueLabel(t) {
  if (!t.due) return '';
  const d = parse(t.due);
  const n = Math.round((d - new Date(new Date().toDateString())) / 864e5);
  if (n < 0) return `Échue depuis ${-n} j`;
  if (n === 0) return 'Échéance aujourd’hui';
  if (n === 1) return 'Échéance demain';
  return `Échéance ${fmt.dateShort.format(d)}`;
}

export const resName = (id) => db.resources[id]?.name || '';

// ---------- Bulles d'information (bouton « i ») ----------
export const INFO = {
  criteres: `<b>Urgence</b> 1→5 · <b>Importance</b> 1→5 · <b>Énergie</b> 1 plombant → 4 dynamisant.<br><br>Urgent et important + dynamisant : <b>priorité</b> ; + plombant : <b>déléguer ou automatiser</b>.<br>Urgent seulement : <b>laisser de côté</b>.<br>Important seulement + dynamisant : <b>à planifier</b> ; + plombant : <b>planifier avec un collaborateur</b>.<br><br>« Urgent » ou « important » = 4 ou 5.`,
  energie: `<b>1 Plombant</b> : vide l’énergie, à faire le matin ou à déléguer.<br><b>2 Fatigant</b> : demande un effort.<br><b>3 Stimulant</b> : plutôt agréable.<br><b>4 Dynamisant</b> : recharge les batteries.`,
  propositions: `L’application ne planifie jamais seule : elle propose. Les tâches plombantes vont plutôt le matin ou sont à déléguer. « ✕ » masque une proposition pendant 7 jours.`,
  matrice: `Urgent et important : <b>faire</b>. Important : <b>planifier</b>. Urgent : <b>déléguer</b>. Ni l’un ni l’autre : <b>plus tard</b>.`,
  dependances: `Lien <b>fin → début</b> : un successeur commence après la fin de ses prédécesseurs (+ délai en jours). Si une tâche prend du retard, ses successeurs sont décalés automatiquement.`,
  ressources: `Personnes (heures), salles, lieux, budgets (montant) et matériel (quantité). Les personnes servent aussi à la délégation.`,
  recurrence: `Quand la tâche est cochée « faite », la suivante est créée automatiquement.`,
  planif: `Activez « Journées » pour une tâche sur un ou plusieurs jours entiers (idéal pour le Gantt). « Proposer » cherche un créneau libre, le matin si la tâche est plombante.`,
  calendrier: `Glissez une tâche du panneau vers un créneau (appui long sur téléphone). Étirez le bas d’un rendez-vous pour changer sa durée. Le matin est teinté : idéal pour les tâches plombantes. Hachuré = rendez-vous Outlook. Clic sur un créneau vide = nouvelle tâche.`,
  gantt: `<b>Rouge</b> : finira après son échéance.<br><b>Contour orange</b> : chemin critique, aucune marge.<br><b>Trait rouge</b> : échéance du projet.<br><br>Glissez une barre pour la déplacer, son bord droit pour la durée, le rond pour créer un lien. Les successeurs suivent en cascade.`,
  retards: `Une tâche non terminée dont la fin est passée est reportée au prochain créneau ; ses successeurs suivent. Celles qui dépassent leur échéance passent en rouge.`,
  outlook: `Tout passe par votre compte Microsoft 365 (Exchange) :<br>• tâches <b>avec une heure précise</b> → rendez-vous dans l’<b>agenda Outlook</b> (avec rappel) ;<br>• <b>autres tâches</b> → liste « Plannings » de <b>Microsoft To Do</b> / Tâches Outlook ;<br>• le téléphone et l’ordinateur partagent ainsi les mêmes données.<br>Ce que vous modifiez dans Outlook ou To Do (titre, date, statut) revient dans l’application.`,
  rappels: `Application ouverte : rappels et résumé du matin. Application fermée : les rappels des rendez-vous Outlook synchronisés prennent le relais.`,
  sauvegarde: `L’import fusionne le fichier avec vos données (la version la plus récente de chaque élément gagne).`,
  installer: `Android (Chrome) : menu ⋮ → « Installer l’application ». Ordinateur (Chrome / Edge) : icône d’installation dans la barre d’adresse. Fonctionne ensuite hors connexion.`,
  profil: `<b>Dirigeant</b> : les tâches plombantes peuvent être déléguées ou automatisées.<br><b>Collaborateur</b> : pas de délégation ; l’application cherche des moments propices : le matin (les plus plombantes en tout début de journée), jamais deux tâches plombantes d’affilée, 2 h 30 de plombant au plus par jour, des séances courtes, puis une tâche dynamisante pour récupérer.`,
  projet: `Une tâche qui finirait après l’échéance du projet passe en rouge dans le Gantt.`,
};

export const info = (key, text = '') =>
  `<button type="button" class="info" ${key ? `data-info="${key}"` : ''} ${text ? `data-info-text="${esc(text)}"` : ''} aria-label="Plus d’informations">i</button>`;

let pop = null;
function closeInfo() { pop?.remove(); pop = null; }
document.addEventListener('click', (e) => {
  const b = e.target.closest('.info');
  if (!b) { if (pop && !e.target.closest('.info-pop')) closeInfo(); return; }
  e.preventDefault(); e.stopPropagation();
  const same = pop && pop._for === b;
  closeInfo();
  if (same) return;
  pop = document.createElement('div');
  pop.className = 'info-pop';
  pop.setAttribute('role', 'tooltip');
  pop.innerHTML = b.dataset.info ? INFO[b.dataset.info] || '' : esc(b.dataset.infoText || '');
  pop._for = b;
  (b.closest('dialog') || document.body).appendChild(pop);
  const r = b.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 24);
  pop.style.width = `${w}px`;
  const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
  pop.style.left = `${left}px`;
  const below = r.bottom + 8 + pop.offsetHeight < window.innerHeight;
  pop.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - 8 - pop.offsetHeight)}px`;
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInfo(); });
window.addEventListener('scroll', closeInfo, true);

// ---------- Curseurs ----------
/**
 * Curseur à crans. values : valeurs réelles ; labels : libellés affichés.
 * kind : 'heat' (gris → rouge), 'energy' (violet → vert), 'plain'.
 */
export function slider(name, { label = '', values, labels, value, kind = 'plain', ticks = true, infoKey = '', compact = false }) {
  let idx = values.findIndex((v) => String(v) === String(value));
  if (idx < 0) idx = 0;
  const n = values.length;
  const pct = n > 1 ? (idx / (n - 1)) * 100 : 0;
  const showTicks = ticks && n <= 7;
  return `
    <div class="sld k-${kind} ${compact ? 'compact' : ''}" data-sld="${name}" data-values='${esc(JSON.stringify(values))}' data-labels='${esc(JSON.stringify(labels))}'
      style="--p:${pct}%;--i:${idx}" data-idx="${idx}">
      ${label || infoKey ? `<div class="sld-top"><span class="sld-name">${esc(label)}${infoKey ? info(infoKey) : ''}</span><output>${esc(labels[idx])}</output></div>` : ''}
      <input type="range" min="0" max="${n - 1}" step="1" value="${idx}" aria-label="${esc(label || name)}" aria-valuetext="${esc(labels[idx])}">
      ${showTicks ? `<div class="sld-ticks">${values.map((v, i) => `<span class="${i === idx ? 'on' : ''}" data-tick="${i}">${esc(String(ticks === 'labels' ? labels[i] : v))}</span>`).join('')}</div>` : ''}
    </div>`;
}

/** Branche les curseurs : onInput(name, value, final). */
export function bindSliders(root, onInput) {
  const update = (wrap, idx, final) => {
    const values = JSON.parse(wrap.dataset.values);
    const labels = JSON.parse(wrap.dataset.labels);
    const n = values.length;
    wrap.style.setProperty('--p', `${n > 1 ? (idx / (n - 1)) * 100 : 0}%`);
    wrap.style.setProperty('--i', idx);
    wrap.dataset.idx = idx;
    const out = wrap.querySelector('output');
    if (out) out.textContent = labels[idx];
    const inp = wrap.querySelector('input');
    inp.setAttribute('aria-valuetext', labels[idx]);
    wrap.querySelectorAll('[data-tick]').forEach((t) => t.classList.toggle('on', Number(t.dataset.tick) === idx));
    onInput(wrap.dataset.sld, values[idx], final);
  };
  root.addEventListener('input', (e) => {
    const wrap = e.target.closest('[data-sld]');
    if (wrap && e.target.type === 'range') update(wrap, Number(e.target.value), false);
  });
  root.addEventListener('change', (e) => {
    const wrap = e.target.closest('[data-sld]');
    if (wrap && e.target.type === 'range') update(wrap, Number(e.target.value), true);
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tick]');
    if (!t) return;
    const wrap = t.closest('[data-sld]');
    const inp = wrap.querySelector('input');
    inp.value = t.dataset.tick;
    update(wrap, Number(t.dataset.tick), true);
  });
}

export const LV = { values: [1, 2, 3, 4, 5], labels: ['1 · Pas du tout', '2 · Peu', '3 · Moyen', '4 · Assez', '5 · Très'] };
export const EN = { values: [1, 2, 3, 4], labels: ['1 · Plombant', '2 · Fatigant', '3 · Stimulant', '4 · Dynamisant'] };
