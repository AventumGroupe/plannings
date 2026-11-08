// Fiche d'une tâche : critères, planification, dépendances, ressources, sous-tâches, récurrence.

import {
  db, tasks, projects, resources, people, newTask, putTask, removeTask, save, newProject, putProject,
  newResource, putResource, STATUS, ENERGY, RES_TYPES, category, CATEGORIES, catInfo, isLeader,
} from './store.js';
import { tStart, tEnd, setSpan, shiftTo, requiredStart, propagate, succsOf, completeTask, proposeSlot, RECUR } from './sched.js';
import { openDialog, confirmDialog, toast, slider, bindSliders, info, LV, EN } from './ui.js';
import { esc, icon, uid, parse, toLocal, toDateStr, addMinutes, fmt, cap, fmtDuration, MIN } from './util.js';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480];
const REMINDERS = [[null, 'Aucun'], [0, 'À l’heure'], [5, '5 min avant'], [15, '15 min avant'], [30, '30 min avant'], [60, '1 h avant'], [120, '2 h avant'], [1440, 'La veille']];
const WEEKDAYS = [[1, 'L'], [2, 'M'], [3, 'M'], [4, 'J'], [5, 'V'], [6, 'S'], [0, 'D']];

function successorMap() {
  const m = new Map();
  for (const t of tasks()) for (const p of t.preds || []) {
    if (!m.has(p.id)) m.set(p.id, []);
    m.get(p.id).push(t.id);
  }
  return m;
}

/** Ancêtres et descendants de la tâche en cours d'édition (pour interdire les boucles). */
function closure(id, predIds, succIds) {
  const sm = successorMap();
  const desc = new Set();
  const st = [...succIds];
  while (st.length) {
    const x = st.pop();
    if (x === id || desc.has(x)) continue;
    desc.add(x);
    (sm.get(x) || []).forEach((y) => st.push(y));
  }
  const anc = new Set();
  const st2 = [...predIds];
  while (st2.length) {
    const x = st2.pop();
    if (x === id || anc.has(x)) continue;
    anc.add(x);
    (db.tasks[x]?.preds || []).forEach((p) => st2.push(p.id));
  }
  return { desc, anc };
}

/**
 * Remplace temporairement une liste déroulante par un champ « nom + ✓ »
 * (les fenêtres prompt() du navigateur sont bloquées dans certains contextes).
 */
function inlineNew(select, placeholder, onOk, done) {
  const row = document.createElement('div');
  row.className = 'inline-new';
  row.innerHTML = `<input type="text" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off">
    <button type="button" class="btn primary sm" data-ok aria-label="Créer">${icon('check', 16)}</button>
    <button type="button" class="icon-btn xs" data-no aria-label="Annuler">${icon('close', 14)}</button>`;
  select.hidden = true;
  select.after(row);
  const inp = row.querySelector('input');
  inp.focus();
  const close = () => { row.remove(); select.hidden = false; done?.(); };
  const ok = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } onOk(v); close(); };
  row.querySelector('[data-ok]').addEventListener('click', (e) => { e.stopPropagation(); ok(); });
  row.querySelector('[data-no]').addEventListener('click', (e) => { e.stopPropagation(); close(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ok(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
}

export function openTaskEditor(idOrPreset = null) {
  const existing = typeof idOrPreset === 'string' ? db.tasks[idOrPreset] : null;
  const isNew = !existing;
  const d = existing ? structuredClone(existing) : newTask(idOrPreset || {});
  const wasDone = existing?.status === 'done';
  const origSuccs = existing ? succsOf(d.id).map((t) => t.id) : [];
  let succIds = [...origSuccs];

  const taskTitle = (id) => db.tasks[id]?.title || '(sans titre)';
  const optTask = (t) => `<option value="${t.id}">${esc(t.title || '(sans titre)')}${t.projectId && db.projects[t.projectId] ? ` — ${esc(db.projects[t.projectId].name)}` : ''}</option>`;

  function planningHtml() {
    const sVal = d.start ? (d.allDay ? d.start.slice(0, 10) : d.start) : '';
    const eVal = d.end ? (d.allDay ? d.end.slice(0, 10) : d.end) : '';
    const type = d.allDay ? 'date' : 'datetime-local';
    const durs = DURATIONS.includes(d.estimate) ? DURATIONS : [...DURATIONS, d.estimate].sort((a, b) => a - b);
    return `
      <div class="row wrap gap">
        <label class="switch sm"><input type="checkbox" data-f="allDay" ${d.allDay ? 'checked' : ''}><span></span> Journées</label>
        <span class="spacer"></span>
        <button type="button" class="btn ghost sm" data-act="propose" title="Proposer un créneau libre">${icon('bulb', 16)} Proposer</button>
        ${d.start ? `<button type="button" class="icon-btn xs" data-act="unplan" title="Retirer du planning" aria-label="Retirer du planning">${icon('close', 14)}</button>` : ''}
      </div>
      <div class="grid2">
        <label class="field"><span>Début</span><input type="${type}" data-f="start" value="${esc(sVal)}"></label>
        <label class="field"><span>Fin</span><input type="${type}" data-f="end" value="${esc(eVal)}"></label>
      </div>
      ${slider('estimate', { label: 'Durée estimée', values: durs, labels: durs.map(fmtDuration), value: d.estimate, ticks: false })}`;
  }

  function depsHtml() {
    const { desc, anc } = closure(d.id, d.preds.map((p) => p.id), succIds);
    const others = tasks().filter((t) => t.id !== d.id).sort((a, b) => (a.title || '').localeCompare(b.title || '', 'fr'));
    const predOpts = others.filter((t) => !d.preds.some((p) => p.id === t.id) && !desc.has(t.id) && !succIds.includes(t.id));
    const succOpts = others.filter((t) => !succIds.includes(t.id) && !anc.has(t.id) && !d.preds.some((p) => p.id === t.id));
    return `
      <div class="deps">
        <div>
          <h4>Prédécesseurs</h4>
          <ul class="pill-list">${d.preds.map((p) => `
            <li class="pill">${esc(taskTitle(p.id))}
              <label class="lag" title="Délai après la fin, en jours">+<input type="number" min="0" max="365" value="${p.lag || 0}" data-lag="${p.id}"> j</label>
              <button type="button" class="x" data-rmpred="${p.id}" aria-label="Retirer">${icon('close', 14)}</button></li>`).join('') || '<li class="muted">Aucun</li>'}
          </ul>
          ${predOpts.length ? `<select data-addpred><option value="">＋ Ajouter un prédécesseur…</option>${predOpts.map(optTask).join('')}</select>` : ''}
        </div>
        <div>
          <h4>Successeurs</h4>
          <ul class="pill-list">${succIds.map((id) => `
            <li class="pill">${esc(taskTitle(id))}<button type="button" class="x" data-rmsucc="${id}" aria-label="Retirer">${icon('close', 14)}</button></li>`).join('') || '<li class="muted">Aucun</li>'}
          </ul>
          ${succOpts.length ? `<select data-addsucc><option value="">＋ Ajouter un successeur…</option>${succOpts.map(optTask).join('')}</select>` : ''}
        </div>
      </div>`;
  }

  function resHtml() {
    const assigned = new Set(d.assign.map((a) => a.id));
    const groups = Object.entries(RES_TYPES).map(([type, T]) => {
      const list = resources().filter((r) => r.type === type && !assigned.has(r.id));
      return `<optgroup label="${T.plural}">${list.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}
        <option value="__new:${type}">＋ ${type === 'personne' ? 'Nouvelle personne' : type === 'salle' ? 'Nouvelle salle' : type === 'lieu' ? 'Nouveau lieu' : type === 'budget' ? 'Nouveau budget' : 'Nouveau matériel'}…</option></optgroup>`;
    }).join('');
    return `
      <ul class="pill-list">${d.assign.map((a) => {
        const r = db.resources[a.id];
        if (!r) return '';
        const unit = RES_TYPES[r.type].unit;
        return `<li class="pill t-${r.type}"><span class="pill-type">${RES_TYPES[r.type].label}</span> ${esc(r.name)}
          ${r.type !== 'salle' && r.type !== 'lieu' ? `<label class="lag" title="Quantité">${unit === '€' ? '' : ''}<input type="number" min="0" step="any" value="${a.qty ?? ''}" placeholder="${r.type === 'budget' ? 'montant' : r.type === 'personne' ? 'heures' : 'qté'}" data-qty="${a.id}"> ${unit}</label>` : ''}
          <button type="button" class="x" data-rmres="${a.id}" aria-label="Retirer">${icon('close', 14)}</button></li>`;
      }).join('') || '<li class="muted">Aucune ressource</li>'}</ul>
      <select data-addres><option value="">＋ Affecter une ressource…</option>${groups}</select>`;
  }

  function subHtml() {
    const done = d.subtasks.filter((s) => s.done).length;
    return `
      ${d.subtasks.length ? `<div class="progress" title="${done}/${d.subtasks.length}"><i style="width:${(done / d.subtasks.length) * 100}%"></i></div>` : ''}
      <ul class="subtasks">${d.subtasks.map((s) => `
        <li><input type="checkbox" data-subdone="${s.id}" ${s.done ? 'checked' : ''} aria-label="Fait">
          <input type="text" value="${esc(s.title)}" data-subtitle="${s.id}" aria-label="Sous-tâche">
          <button type="button" class="x" data-rmsub="${s.id}" aria-label="Supprimer">${icon('close', 14)}</button></li>`).join('')}
      </ul>
      <div class="row gap"><input type="text" data-newsub placeholder="Nouvelle sous-tâche"><button type="button" class="btn ghost sm" data-act="addsub">${icon('plus', 16)}</button></div>`;
  }

  function recurHtml() {
    const r = d.recur || {};
    const freqs = ['', ...Object.keys(RECUR)];
    const flabels = ['Aucune', 'Chaque jour', 'Chaque semaine', 'Chaque mois', 'Chaque année'];
    const unit = { daily: 'jour', weekly: 'semaine', monthly: 'mois', yearly: 'an' }[r.freq] || '';
    const ivs = Array.from({ length: 12 }, (_, i) => i + 1);
    return `
      ${slider('recurFreq', { label: 'Répétition', values: freqs, labels: flabels, value: r.freq || '', ticks: false })}
      ${r.freq ? slider('recurInterval', { label: 'Tous les', values: ivs, labels: ivs.map((n) => `${n} ${unit}${n > 1 && unit !== 'mois' ? 's' : ''}`), value: r.interval || 1, ticks: false }) : ''}
      ${r.freq === 'weekly' ? `<div class="weekdays">${WEEKDAYS.map(([v, l]) => `<button type="button" class="wd${(r.days || []).includes(v) ? ' on' : ''}" data-wd="${v}">${l}</button>`).join('')}</div>` : ''}
      ${r.freq ? `<label class="field"><span>Jusqu’au</span><input type="date" value="${esc(r.until || '')}" data-recur="until"></label>` : ''}`;
  }

  function bodyHtml() {
    const remIdx = REMINDERS.map((r) => r[0]);
    const st = Object.keys(STATUS);
    const nSub = d.subtasks.length, nDep = d.preds.length + succIds.length, nRes = d.assign.length;
    const sec = (key, ico, title, count, inner, infoKey, open) => `
      <details class="block" ${open ? 'open' : ''}>
        <summary>${icon(ico, 18)} <span>${title}</span>${count ? `<span class="count">${count}</span>` : ''}${infoKey ? info(infoKey) : ''}<span class="caret">${icon('chevR', 14)}</span></summary>
        <div data-part="${key}">${inner}</div>
      </details>`;
    return `
      <label class="field big"><input type="text" data-f="title" value="${esc(d.title)}" placeholder="Que faut-il faire ?" required autocomplete="off" aria-label="Tâche"></label>
      <div class="crit">
        ${slider('urgency', { label: 'Urgence', ...LV, value: d.urgency, kind: 'heat' })}
        ${slider('importance', { label: 'Importance', ...LV, value: d.importance, kind: 'heat' })}
        ${slider('energy', { label: 'Énergie', ...EN, value: d.energy, kind: 'energy', infoKey: 'energie' })}
        ${slider('status', { label: 'Statut', values: st, labels: st.map((k) => STATUS[k]), value: d.status, ticks: 'labels', kind: 'status' })}
      </div>
      <div class="cat-live c-${category(d)}" data-cat-live><i class="grp-dot"></i><b>${catInfo(category(d)).label}</b><span>${catInfo(category(d)).hint}</span></div>
      <div class="grid2">
        <label class="field"><span>Projet</span>
          <select data-f="projectId"><option value="">Sans projet</option>${projects().map((p) => `<option value="${p.id}" ${d.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          <option value="__new">＋ Nouveau projet…</option></select></label>
        <label class="field"><span>Échéance</span><input type="date" data-f="due" value="${esc(d.due || '')}"></label>
      </div>
      ${sec('planning', 'calendar', 'Planification', d.start ? 1 : 0, planningHtml(), 'planif', true)}
      <details class="block" ${d.delegate || d.reminder != null ? '' : ''}>
        <summary>${icon('bell', 18)} <span>${isLeader() ? 'Rappel et délégation' : 'Rappel'}</span><span class="caret">${icon('chevR', 14)}</span></summary>
        ${slider('reminder', { label: 'Rappel', values: remIdx, labels: REMINDERS.map((r) => r[1]), value: d.reminder, ticks: false })}
        <label class="field" ${isLeader() ? '' : 'hidden'}><span>Déléguée à</span><select data-f="delegate"><option value="">Moi</option>${people().map((p) => `<option value="${p.id}" ${d.delegate === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      </details>
      ${sec('deps', 'link', 'Dépendances', nDep, depsHtml(), 'dependances', nDep > 0)}
      ${sec('res', 'people', 'Ressources', nRes, resHtml(), 'ressources', nRes > 0)}
      ${sec('sub', 'check', 'Sous-tâches', nSub, subHtml(), '', nSub > 0)}
      ${sec('recur', 'repeat', 'Récurrence', d.recur ? 1 : 0, recurHtml(), 'recurrence', !!d.recur)}
      <details class="block" ${d.notes ? 'open' : ''}>
        <summary>${icon('pdf', 18)} <span>Notes</span><span class="caret">${icon('chevR', 14)}</span></summary>
        <textarea data-f="notes" rows="3" aria-label="Notes">${esc(d.notes)}</textarea>
      </details>
      <div class="row wrap gap-sm foot-badges">
        ${existing?.slips ? `<span class="badge warn">${icon('alert', 13)} Reportée ×${existing.slips}</span>` : ''}
        ${existing?.outlook?.id ? `<span class="badge muted">${icon('sync', 13)} Outlook</span>` : ''}
      </div>`;
  }

  const footer = `
    ${isNew ? '' : `<button type="button" class="btn ghost danger-text" data-act="delete">${icon('trash', 16)}<span class="hide-sm">Supprimer</span></button>
    <button type="button" class="btn ghost" data-act="dup">${icon('copy', 16)}<span class="hide-sm">Dupliquer</span></button>`}
    <span class="spacer"></span>
    <button type="button" class="btn ghost" data-close>Annuler</button>
    <button type="button" class="btn primary" data-act="save">${isNew ? 'Créer la tâche' : 'Enregistrer'}</button>`;

  const { el, close } = openDialog({ title: isNew ? 'Nouvelle tâche' : 'Modifier la tâche', body: bodyHtml(), footer, wide: true });
  const body = el.querySelector('.sheet-body');
  const part = (name, html) => { body.querySelector(`[data-part="${name}"]`).innerHTML = html; };
  if (isNew) setTimeout(() => body.querySelector('[data-f="title"]').focus(), 50);

  function setStart(v) {
    if (!v) { d.start = null; d.end = null; return; }
    if (d.allDay) {
      d.start = v + 'T00:00';
      if (!d.end || d.end < d.start) d.end = d.start;
    } else {
      const old = d.start && d.end ? parse(d.end) - parse(d.start) : (d.estimate || 60) * MIN;
      d.start = v;
      d.end = toLocal(new Date(parse(v).getTime() + old));
    }
  }

  bindSliders(body, (name, v, final) => {
    if (name === 'urgency' || name === 'importance' || name === 'energy') {
      d[name] = Number(v);
      const c = category(d), box = body.querySelector('[data-cat-live]');
      box.className = `cat-live c-${c}`;
      box.innerHTML = `<i class="grp-dot"></i><b>${catInfo(c).label}</b><span>${catInfo(c).hint}</span>`;
    }
    else if (name === 'status') d.status = v;
    else if (name === 'reminder') d.reminder = v;
    else if (name === 'estimate') {
      d.estimate = Number(v);
      if (d.start && !d.allDay) {
        d.end = toLocal(addMinutes(parse(d.start), d.estimate));
        const e = body.querySelector('[data-f="end"]'); if (e) e.value = d.end;
      }
    } else if (name === 'recurFreq') {
      d.recur = v ? { ...(d.recur || {}), freq: v, interval: d.recur?.interval || 1, days: d.recur?.days || [] } : null;
      if (final || !v || !body.querySelector('[data-sld="recurInterval"]')) part('recur', recurHtml());
    } else if (name === 'recurInterval' && d.recur) d.recur.interval = Number(v);
  });

  body.addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (f === 'title' || f === 'notes') d[f] = e.target.value;
    if (e.target.dataset.subtitle) {
      const s = d.subtasks.find((x) => x.id === e.target.dataset.subtitle);
      if (s) s.title = e.target.value;
    }
    if (e.target.dataset.lag) {
      const p = d.preds.find((x) => x.id === e.target.dataset.lag);
      if (p) p.lag = Math.max(0, Number(e.target.value) || 0);
    }
    if (e.target.dataset.qty) {
      const a = d.assign.find((x) => x.id === e.target.dataset.qty);
      if (a) a.qty = e.target.value === '' ? null : Number(e.target.value);
    }
  });

  body.addEventListener('change', (e) => {
    const t = e.target;
    const f = t.dataset.f;
    if (f === 'allDay') {
      const s = d.start ? parse(d.start) : null;
      const en = d.start ? tEnd(d) : null;
      d.allDay = t.checked;
      if (s) {
        if (d.allDay) setSpan(d, s, en);
        else { const x = new Date(s); x.setHours(9, 0, 0, 0); setSpan(d, x, addMinutes(x, d.estimate || 60)); }
      }
      part('planning', planningHtml());
    } else if (f === 'start') {
      setStart(t.value);
      part('planning', planningHtml());
    } else if (f === 'end') {
      if (!t.value) { d.end = d.start; }
      else d.end = d.allDay ? t.value + 'T00:00' : t.value;
      if (d.start && d.end < d.start) d.end = d.start;
      if (!d.allDay && d.start) d.estimate = Math.max(15, Math.round((parse(d.end) - parse(d.start)) / MIN));
      part('planning', planningHtml());
    } else if (f === 'due') d.due = t.value || null;
    else if (f === 'delegate') d.delegate = t.value || null;
    else if (f === 'projectId') {
      if (t.value === '__new') {
        const refill = () => { t.innerHTML = `<option value="">Sans projet</option>${projects().map((p) => `<option value="${p.id}" ${d.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">＋ Nouveau projet…</option>`; };
        inlineNew(t, 'Nom du nouveau projet', (name) => { const p = newProject({ name }); putProject(p); d.projectId = p.id; toast(`Projet « ${name} » créé.`); }, refill);
      } else d.projectId = t.value || null;
    } else if (t.matches('[data-addpred]') && t.value) {
      d.preds.push({ id: t.value, lag: 0 }); part('deps', depsHtml());
    } else if (t.matches('[data-addsucc]') && t.value) {
      succIds.push(t.value); part('deps', depsHtml());
    } else if (t.matches('[data-addres]') && t.value) {
      if (t.value.startsWith('__new:')) {
        const type = t.value.slice(6);
        inlineNew(t, `Nom (${RES_TYPES[type].label.toLowerCase()})`, (name) => { const r = newResource({ name, type }); putResource(r); d.assign.push({ id: r.id, qty: null }); }, () => part('res', resHtml()));
        return;
      } else d.assign.push({ id: t.value, qty: null });
      part('res', resHtml());
    } else if (t.dataset.subdone) {
      const s = d.subtasks.find((x) => x.id === t.dataset.subdone);
      if (s) s.done = t.checked;
      part('sub', subHtml());
    } else if (t.dataset.recur) {
      const k = t.dataset.recur;
      if (d.recur) d.recur[k] = t.value || null;
      part('recur', recurHtml());
    }
  });

  const addSub = () => {
    const inp = body.querySelector('[data-newsub]');
    const v = inp.value.trim();
    if (!v) return;
    d.subtasks.push({ id: uid(), title: v, done: false });
    part('sub', subHtml());
    body.querySelector('[data-newsub]').focus();
  };
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-newsub]')) { e.preventDefault(); addSub(); }
    if (e.key === 'Enter' && e.target.dataset.f === 'title') { e.preventDefault(); }
  });

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.rmpred) { d.preds = d.preds.filter((p) => p.id !== b.dataset.rmpred); part('deps', depsHtml()); }
    else if (b.dataset.rmsucc) { succIds = succIds.filter((x) => x !== b.dataset.rmsucc); part('deps', depsHtml()); }
    else if (b.dataset.rmres) { d.assign = d.assign.filter((a) => a.id !== b.dataset.rmres); part('res', resHtml()); }
    else if (b.dataset.rmsub) { d.subtasks = d.subtasks.filter((s) => s.id !== b.dataset.rmsub); part('sub', subHtml()); }
    else if (b.dataset.wd) {
      const v = Number(b.dataset.wd);
      const days = new Set(d.recur.days || []);
      days.has(v) ? days.delete(v) : days.add(v);
      d.recur.days = [...days];
      part('recur', recurHtml());
    }
    const act = b.dataset.act;
    if (act === 'addsub') addSub();
    if (act === 'propose') {
      const slot = proposeSlot(d, { morning: d.energy <= 2 });
      if (!slot) { toast('Aucun créneau libre trouvé sur les 10 prochains jours ouvrés.'); return; }
      d.allDay = false;
      setSpan(d, slot, addMinutes(slot, d.estimate || 60));
      part('planning', planningHtml());
      toast(d.energy <= 2 ? `Créneau du matin proposé : ${cap(fmt.dayShort.format(slot))} ${fmt.time.format(slot)}` : `Créneau proposé : ${cap(fmt.dayShort.format(slot))} ${fmt.time.format(slot)}`);
    }
    if (act === 'unplan') { d.start = null; d.end = null; part('planning', planningHtml()); }
    if (act === 'delete') {
      if (await confirmDialog(`Supprimer « ${d.title || 'cette tâche'} » ?`)) {
        removeTask(d.id); close(); toast('Tâche supprimée');
      }
    }
    if (act === 'dup') {
      const c = newTask({ ...structuredClone(d), id: uid(), title: `${d.title} (copie)`, outlook: null, status: 'todo', doneAt: null, slips: 0, createdAt: Date.now() });
      putTask(c); close(); toast('Tâche dupliquée'); openTaskEditor(c.id);
    }
    if (act === 'save') {
      d.title = d.title.trim();
      if (!d.title) { body.querySelector('[data-f="title"]').focus(); toast('Donnez un titre à la tâche.'); return; }
      commit();
      close();
    }
  });

  function commit() {
    // Successeurs (stockés sur les autres tâches)
    for (const id of origSuccs) if (!succIds.includes(id)) {
      const s = db.tasks[id]; if (s) { s.preds = s.preds.filter((p) => p.id !== d.id); putTask(s, { silent: true }); }
    }
    const newly = [];
    for (const id of succIds) if (!origSuccs.includes(id)) {
      const s = db.tasks[id]; if (s) { s.preds.push({ id: d.id, lag: 0 }); putTask(s, { silent: true }); newly.push(id); }
    }
    // Contrainte des prédécesseurs
    let note = '';
    db.tasks[d.id] = d; // nécessaire pour le calcul
    if (d.start) {
      const req = requiredStart(d);
      if (req && tStart(d) < req) { shiftTo(d, req); note = ` Décalée après ses prédécesseurs : ${cap(fmt.dayShort.format(req))}.`; }
    }
    let next = null;
    if (d.status === 'done' && !wasDone) next = completeTask(d);
    else { if (d.status !== 'done') d.doneAt = null; putTask(d, { silent: true }); }
    const moved = propagate([d.id, ...d.preds.map((p) => p.id)]);
    save('task');
    let msg = isNew ? 'Tâche créée.' : 'Tâche enregistrée.';
    msg += note;
    if (moved.size) msg += ` ${moved.size} successeur${moved.size > 1 ? 's' : ''} décalé${moved.size > 1 ? 's' : ''}.`;
    if (next) msg += ' Prochaine occurrence créée.';
    toast(msg);
  }
}
