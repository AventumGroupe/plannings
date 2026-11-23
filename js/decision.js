// Onglet « Décision » : la boîte des tâches à trancher, une à la fois.
// Deux scores (Eisenhower = urgence × importance ; énergie = énergie × motivation) donnent une
// recommandation selon le profil ; l'utilisateur tranche (ou choisit une autre décision).
// Tant qu'une tâche n'est pas tranchée, elle reste ici.

import {
  db, tasks, putTask, save, people, projects, ENERGY, MOTIVATION, LEVELS, catInfo, category, isLeader,
  uiScore, emScore, effUrgency, quickWin, DECISIONS, decisionsFor, needsDecision, decide, abandonTask, CHOICES, choiceKey, adviceKey,
} from './store.js';
import { proposeSlot, setSpan, propagate, splitTask, completeTask } from './sched.js';
import { delegateTo } from './delegation.js';
import { absenceOf } from './rh.js';
import { openTaskEditor } from './editor.js';
import { slider, bindSliders, info, toast, LV, EN, MO } from './ui.js';
import { esc, icon, fmt, cap, uid, toDateStr, addDays, MIN } from './util.js';
import { addWorkDays } from './templates.js';
import { assignable, teamOnline, shareTask } from './team.js';

let order = [];        // ordre de passage (« Passer » envoie la tâche en fin de file)
let pick = null;       // décision en cours de confirmation (qui demande une précision)
let decidedToday = 0;

/** File des tâches à trancher : d'abord celles revenues de « Reporter », puis par score. */
export function queue() {
  const list = tasks().filter(needsDecision);
  const ids = new Set(list.map((t) => t.id));
  order = order.filter((id) => ids.has(id));
  for (const t of list.sort((a, b) => (a.decision?.key === 'reporter' ? -1 : 0) - (b.decision?.key === 'reporter' ? -1 : 0) || uiScore(b) - uiScore(a) || emScore(b) - emScore(a))) {
    if (!order.includes(t.id)) order.push(t.id);
  }
  return order.map((id) => db.tasks[id]);
}
export const toDecideCount = () => tasks().filter(needsDecision).length;

function gauge(v, max, hi, label, title) {
  const pct = Math.round((v / max) * 100);
  return `<div class="dc-gauge ${v >= hi ? 'hi' : ''}" title="${esc(title)}"><div class="dc-g-top"><b>${v}</b><small>/${max}</small></div>
    <div class="dc-g-bar"><i style="width:${pct}%"></i><em style="left:${Math.round((hi / max) * 100)}%"></em></div><span>${label}</span></div>`;
}

/** Précision demandée par certaines décisions. */
function extraHtml(t, key) {
  const team = people();
  if (key === 'deleguer') {
    const online = teamOnline() ? assignable() : [];
    const offline = team.filter((p) => !online.some((m) => m.id === p.rhId));
    if (!online.length && !offline.length) return `<p class="hint">Reliez la plateforme RH (Réglages) pour confier en ligne à votre équipe, ou ajoutez une personne dans Ressources.</p>`;
    return `<label class="field"><span>À qui ?</span><select data-x="person">
      ${online.length ? `<optgroup label="En ligne : la personne reçoit la tâche et l’accepte">${online.map((m) => `<option value="rh:${m.id}">${esc(m.nom)}${absenceOf(m.nom) ? ' (absent)' : ''}</option>`).join('')}</optgroup>` : ''}
      ${offline.length ? `<optgroup label="Suivi seulement chez moi">${offline.map((p) => `<option value="${p.id}">${esc(p.name)}${absenceOf(p.name) ? ' (absent)' : ''}</option>`).join('')}</optgroup>` : ''}
    </select></label>${online.length ? '<p class="hint">En ligne : elle est proposée à la personne, qui l’accepte ou la refuse (avec un motif). Votre motivation n’est jamais transmise.</p>' : ''}`;
  }
  if (key === 'reporter') return `<label class="field"><span>À revoir le</span><input type="date" data-x="date" value="${toDateStr(addWorkDays(new Date(), 10))}"></label><p class="hint">La tâche disparaît jusqu’à cette date, puis revient ici.</p>`;
  if (key === 'abandon') return `<label class="field"><span>Pourquoi ? (pour le bilan)</span><input type="text" data-x="reason" placeholder="Plus d’actualité, pas prioritaire…"></label><p class="hint">La tâche est supprimée ; elle reste dans le journal des renoncements.</p>`;
  if (key === 'negocier') return `<label class="field"><span>Échéance à proposer</span><input type="date" data-x="date" value="${t.due ? toDateStr(addWorkDays(new Date(t.due + 'T00:00'), 5)) : toDateStr(addWorkDays(new Date(), 10))}"></label><p class="hint">${isLeader() ? 'À négocier avec le donneur d’ordre.' : 'À négocier avec votre manager ou votre dirigeant.'} La nouvelle échéance est notée ; la tâche reste à planifier.</p>`;
  if (key === 'decouper') return `<div class="dc-split">
      <label class="field"><span>Nombre de séances</span><input type="number" data-x="n" min="2" max="20" value="3"></label>
      <label class="field"><span>Espacées de</span><span class="row gap-sm"><input type="number" data-x="every" min="1" max="10" value="1" style="width:70px"><select data-x="unit"><option value="demi">demi-journée(s)</option><option value="jour" selected>jour(s)</option><option value="semaine">semaine(s)</option></select></span></label>
      <label class="field"><span>À partir du</span><input type="date" data-x="from" value="${toDateStr(new Date())}"></label>
    </div><p class="hint" data-split-preview>${splitPreview(t, 3, 1, 'jour', toDateStr(new Date()))}</p>`;
  if (key === 'aide') return `<label class="field"><span>Qui pourrait aider ?</span><input type="text" data-x="note" placeholder="${isLeader() ? 'Collègue, freelance, prestataire…' : 'Collègue, manager…'}"></label>`;
  if (key === 'refuser') return `<label class="field"><span>À qui la renvoyer ? (facultatif)</span><input type="text" data-x="note" placeholder="Demandeur"></label><p class="hint">La tâche est retirée et notée dans le journal des renoncements.</p>`;
  if (key === 'manager' || key === 'valider') return `<label class="field"><span>Note pour l’échange (facultatif)</span><input type="text" data-x="note" placeholder="Ce que je propose…"></label>`;
  return '';
}
const NEEDS_EXTRA = ['deleguer', 'reporter', 'abandon', 'negocier', 'decouper', 'aide', 'refuser'];

/** Aperçu du fractionnement : « 3 séances de 30 min : mer. 18, jeu. 19, ven. 20 ». */
function splitPreview(t, n, every, unit, from) {
  n = Math.max(2, Math.min(20, Number(n) || 2)); every = Math.max(1, Number(every) || 1);
  const total = t.estimate || 60, each = Math.max(5, Math.round(total / n / 5) * 5);
  const wd = db.settings.workDays, isWork = (d) => wd.includes(d.getDay());
  let d = new Date((from || toDateStr(new Date())) + 'T00:00'); while (!isWork(d)) d = addDays(d, 1);
  let half = 0; const out = [];
  for (let k = 0; k < Math.min(n, 6); k++) {
    out.push(fmt.dayShort.format(d) + (unit === 'demi' ? (half ? ' ap.-midi' : ' matin') : ''));
    if (unit === 'demi') { for (let i = 0; i < every; i++) { half = 1 - half; if (!half) { d = addDays(d, 1); while (!isWork(d)) d = addDays(d, 1); } } }
    else if (unit === 'semaine') { d = addDays(d, 7 * every); while (!isWork(d)) d = addDays(d, 1); }
    else { for (let i = 0; i < every; i++) { d = addDays(d, 1); while (!isWork(d)) d = addDays(d, 1); } }
  }
  return `${n} séances de ${fmtMin(each)} (${fmtMin(total)} au total) : ${out.join(', ')}${n > 6 ? '…' : ''}${/\.$/.test(out[out.length - 1] || '') && n <= 6 ? '' : '.'} Chaque matin, vous arbitrez dans « Ma journée ».`;
}
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + String(m % 60).padStart(2, '0') : ''}` : `${m} min`);

/** Applique une décision. Retourne un message. */
export function applyDecision(t, key, x = {}) {
  if (key === 'abandon') { abandonTask(t, x.reason || ''); return 'Abandonnée : notée dans le journal des renoncements.'; }
  if (key === 'refuser') { abandonTask(t, `Refusée / renvoyée${x.note ? ' à ' + x.note : ''}`); return 'Refusée : notée dans le journal des renoncements.'; }
  if (key === 'deleguer') {
    if (!x.person) return 'Choisissez la personne.';
    if (String(x.person).startsWith('rh:')) {
      const m = assignable().find((a) => String(a.id) === String(x.person).slice(3));
      if (!m) return 'Choisissez la personne.';
      return shareTask(t, m).then(() => `Proposée à ${m.nom} : en attente de son acceptation.`, (e) => `Envoi impossible : ${e.message}`);
    }
    delegateTo(t, x.person, { save: false });
    decide(t, 'deleguer');
    return `Confiée à ${db.resources[x.person]?.name}. Suivi dans « En attente de… ».`;
  }
  if (key === 'reporter') { decide(t, 'reporter', { reviewAt: x.date || toDateStr(addWorkDays(new Date(), 10)) }); return `Reportée : elle reviendra le ${fmt.dateShort.format(new Date((x.date || toDateStr(addWorkDays(new Date(), 10))) + 'T00:00'))}.`; }
  if (key === 'negocier') { if (x.date) t.due = x.date; decide(t, 'negocier', { proposedDue: x.date || null }); return 'Échéance à négocier : notée.'; }
  if (key === 'decouper') {
    const { ids, each } = splitTask(t, { n: Number(x.n) || 3, every: Number(x.every) || 1, unit: x.unit || 'jour', from: x.from ? new Date(x.from + 'T00:00') : new Date() });
    return `Fractionnée en ${ids.length} séances de ${fmtMin(each)}, posées sur leurs jours.`;
  }
  if (key === 'planifier' || key === 'prioriser') {
    decide(t, key);
    if (!t.start) {
      const slot = proposeSlot(t, { morning: t.energy <= 2, days: key === 'prioriser' ? 2 : 10 });
      if (slot) {
        t.allDay = false; setSpan(t, slot, new Date(slot.getTime() + Math.min(t.estimate || 60, 240) * MIN)); putTask(t, { silent: true }); propagate([t.id]); save('decision');
        return `${DECISIONS[key].label} : placée ${cap(fmt.dayShort.format(slot))} à ${fmt.time.format(slot)} (modifiable).`;
      }
    }
    return `${DECISIONS[key].label} : notée.`;
  }
  if (key === 'expedier') { if ((t.estimate || 60) > 15) t.estimate = 15; decide(t, 'expedier'); return 'À expédier en 15 minutes maximum.'; }
  decide(t, key, x.note ? { note: x.note } : {});
  return `${DECISIONS[key]?.label || 'Décision'} : notée.`;
}

function cardHtml(t, pos, total) {
  const c = category(t), ci = catInfo(c);
  const reco = adviceKey(t);
  const others = decisionsFor(t).map(choiceKey).filter((k, i, a) => k !== reco && a.indexOf(k) === i).slice(0, 2);
  const ui = uiScore(t), em = emScore(t), up = effUrgency(t) > t.urgency;
  const p = t.projectId && db.projects[t.projectId];
  return `<article class="dc-card c-${c}" data-dc="${t.id}">
    <header class="dc-head">
      <span class="dc-pos">${pos} / ${total}</span>
      ${t.decision?.key === 'reporter' ? '<span class="badge warn">Revenue de « Reporter »</span>' : ''}
      ${(t.slips || 0) >= 3 ? `<span class="badge danger">Repoussée ${t.slips} fois</span>` : ''}
      <span class="spacer"></span>
      <label class="dc-done"><input type="checkbox" data-dc-done> Déjà faite</label>
      <button class="icon-btn" data-dc-open title="Ouvrir la fiche" aria-label="Ouvrir la fiche">${icon('pdf', 18)}</button>
    </header>
    <input class="dc-title" data-dc-title value="${esc(t.title)}" aria-label="Titre">
    <div class="dc-meta">${p ? `<span class="chip project" style="--pc:${esc(p.color)}"><i></i>${esc(p.name)}</span>` : ''}${t.due ? `<span class="chip">Échéance ${fmt.dateShort.format(new Date(t.due + 'T00:00'))}</span>` : ''}<span class="chip">${icon('repeat', 13)} ${fmtMin(t.estimate || 60)}</span></div>
    <div class="dc-crit">
      ${slider('urgency', { label: 'Urgence', ...LV, value: t.urgency, kind: 'heat' })}
      ${slider('importance', { label: 'Importance', ...LV, value: t.importance, kind: 'heat' })}
      ${slider('energy', { label: 'Énergie de la tâche', ...EN, value: t.energy, kind: 'energy', infoKey: 'energie' })}
      ${t.motivation ? slider('motivation', { label: 'Ma motivation', ...MO, value: t.motivation, kind: 'energy', infoKey: 'motivation' })
        : `<div class="dc-moti"><span>Ma motivation ${info('motivation')}</span><div class="dc-moti-btns">${[1, 2, 3, 4].map((v) => `<button type="button" class="btn" data-moti="${v}"><b>${v}</b><small>${esc(MOTIVATION[v].short)}</small></button>`).join('')}</div></div>`}
    </div>
    ${t.motivation ? `
    <div class="dc-advice c-${c}">
      <span class="dc-sc" title="Eisenhower : urgence ${effUrgency(t)}${up ? ' (relevée par l’échéance)' : ''} × importance ${t.importance}"><b>${ui}</b>/25</span>
      <span class="dc-sc" title="Énergie ${t.energy} × motivation ${t.motivation}"><b>${em}</b>/16</span>
      <span class="dc-adv-txt"><b>Conseil : ${esc(DECISIONS[reco].label)}</b>${others.length ? ` <small>(ou ${others.map((k) => esc(DECISIONS[k].label.toLowerCase())).join(', ')})</small>` : ''}<small>${esc(ci.hint)}${quickWin(t) ? ' Urgente et courte : à faire tout de suite.' : ''}</small></span>
    </div>
    <h4 class="dc-choose">Votre décision</h4>
    <div class="dc-grid">${CHOICES.map((k) => `<button class="dc-chip ${k === reco ? 'reco dc-main' : ''}" data-dec="${k}">${icon(DECISIONS[k].icon, 16)}<span>${esc(DECISIONS[k].label)}</span>${k === reco ? '<em>conseillé</em>' : ''}</button>`).join('')}</div>
    ${pick ? `<div class="dc-extra"><h4>${esc(DECISIONS[pick].label)}</h4>${extraHtml(t, pick)}<div class="row gap-sm"><button class="btn primary" data-dec-ok>Valider</button><button class="btn ghost" data-dec-cancel>Annuler</button></div></div>` : ''}` : ''}
    <footer class="dc-foot"><button class="btn ghost sm" data-dc-skip>Passer pour l’instant</button></footer>
  </article>`;
}

export function renderDecision(el) {
  const q = queue();
  const t = q[0];
  el.innerHTML = `<section class="view dc-view">
    <header class="dc-top"><h2>Décision</h2>${info('criteres')}<span class="spacer"></span>
      ${q.length ? `<span class="badge ${q.length > 5 ? 'warn' : 'accent'}">${q.length} à trancher</span>` : ''}${decidedToday ? `<span class="badge muted">${decidedToday} tranchée(s)</span>` : ''}</header>
    ${t ? cardHtml(t, 1, q.length) : `<div class="card empty dc-empty">${icon('check', 32)}<h3>Tout est tranché</h3><p>Chaque tâche a sa décision. Retrouvez-les dans la Liste.</p><a class="btn primary" href="#liste">Ouvrir la liste</a></div>`}
    ${q.length > 1 ? `<div class="dc-next"><small>Ensuite :</small>${q.slice(1, 6).map((x) => `<button class="chip" data-dc-jump="${x.id}">${esc(x.title)}</button>`).join('')}${q.length > 6 ? `<small>+ ${q.length - 6}</small>` : ''}</div>` : ''}
  </section>`;
  if (t) bind(el, t);
}

function bind(el, t) {
  const root = el.querySelector('.dc-view');
  const rerender = () => { if (document.body.dataset.view === 'decision' && el.isConnected) renderDecision(el); };
  bindSliders(root, (name, v, final) => {
    if (!final) return;
    if (['urgency', 'importance', 'energy', 'motivation'].includes(name)) { t[name] = v; putTask(t, { silent: true }); save('decision-crit'); pick = null; rerender(); }
  });
  root.addEventListener('input', (e) => {
    if (!e.target.closest('.dc-split')) return;
    const v = (k) => root.querySelector(`[data-x="${k}"]`)?.value;
    const pv = root.querySelector('[data-split-preview]'); if (pv) pv.innerHTML = splitPreview(t, v('n'), v('every'), v('unit'), v('from'));
  });
  root.addEventListener('change', (e) => { if (e.target.closest('.dc-split')) e.target.dispatchEvent(new Event('input', { bubbles: true })); });
  root.querySelector('[data-dc-title]')?.addEventListener('change', (e) => { const v = e.target.value.trim(); if (v) { t.title = v; putTask(t); } });
  root.addEventListener('click', (e) => {
    const q = (s) => e.target.closest(s);
    if (q('[data-dc-done]')) { completeTask(t); save('decision-done'); done('Bravo, c’est fait : elle ne sera plus proposée.'); return; }
    const m = q('[data-moti]'); if (m) { t.motivation = Number(m.dataset.moti); putTask(t, { silent: true }); save('decision-crit'); rerender(); return; }
    if (q('[data-dc-open]')) { openTaskEditor(t.id); return; }
    if (q('[data-dc-skip]')) { order = order.filter((id) => id !== t.id).concat(t.id); pick = null; rerender(); return; }
    const j = q('[data-dc-jump]'); if (j) { order = [j.dataset.dcJump, ...order.filter((id) => id !== j.dataset.dcJump)]; pick = null; rerender(); return; }
    if (q('[data-dec-cancel]')) { pick = null; rerender(); return; }
    const d = q('[data-dec]');
    if (d) {
      const key = d.dataset.dec;
      if (NEEDS_EXTRA.includes(key)) { pick = key; rerender(); setTimeout(() => root.querySelector('[data-x]')?.focus(), 30); return; }
      done(applyDecision(t, key)); return;
    }
    if (q('[data-dec-ok]')) {
      const x = {};
      root.querySelectorAll('[data-x]').forEach((i) => { x[i.dataset.x] = i.value; });
      const res = applyDecision(t, pick, x);
      if (res === 'Choisissez la personne.') { toast(res); return; }
      if (res && typeof res.then === 'function') {
        q('[data-dec-ok]').disabled = true;
        res.then((msg) => { if (msg.startsWith('Envoi impossible')) { toast(msg, { tone: 'danger' }); q('[data-dec-ok]') && (q('[data-dec-ok]').disabled = false); } else done(msg); });
        return;
      }
      done(res);
    }
  });
  function done(msg) {
    pick = null; decidedToday++;
    const card = root.querySelector('.dc-card');
    card?.classList.add('dc-out');
    toast(msg);
    setTimeout(rerender, 180);
  }
}
