// Projets et ressources (personnes, salles, lieux, budgets, matériel).

import {
  db, tasks, projects, resources, newProject, putProject, removeProject, newResource, putResource, removeResource,
  RES_TYPES, PROJECT_COLORS,
} from './store.js';
import { analyze, tStart, tEnd } from './sched.js';
import { openDialog, confirmDialog, toast, slider, bindSliders, info } from './ui.js';
import { openTaskEditor } from './editor.js';
import { esc, icon, parse, fmt, addDays, toDateStr } from './util.js';
import { allTemplates, instantiate, saveAsTemplate, removeTemplate } from './templates.js';

export function openProjectEditor(id = null) {
  const existing = id ? db.projects[id] : null;
  const p = existing ? { ...existing } : newProject();
  const { el, close } = openDialog({
    title: existing ? 'Modifier le projet' : 'Nouveau projet',
    body: `
      <label class="field big"><span>Nom du projet</span><input type="text" data-k="name" value="${esc(p.name)}" placeholder="Ex. : Session de formation de décembre" autocomplete="off"></label>
      <div class="field"><span>Couleur</span><div class="colors">${PROJECT_COLORS.map((c) => `<button type="button" class="color ${p.color === c ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Couleur ${c}"></button>`).join('')}</div></div>
      <label class="field"><span>Échéance du projet ${info('projet')}</span><input type="date" data-k="deadline" value="${esc(p.deadline || '')}"></label>
      <label class="field"><span>Notes</span><textarea data-k="notes" rows="3">${esc(p.notes || '')}</textarea></label>`,
    footer: `${existing ? `<button type="button" class="btn ghost danger-text" data-del>${icon('trash', 16)}<span class="hide-sm">Supprimer</span></button><button type="button" class="btn ghost" data-tpl>${icon('copy', 16)} En faire un modèle</button>` : ''}<span class="spacer"></span>
      <button type="button" class="btn ghost" data-close>Annuler</button><button type="button" class="btn primary" data-save>Enregistrer</button>`,
  });
  setTimeout(() => el.querySelector('[data-k="name"]').focus(), 50);
  el.querySelector('[data-tpl]')?.addEventListener('click', () => {
    const tpl = saveAsTemplate(p.id, p.name);
    toast(tpl ? `Modèle « ${tpl.name} » enregistré (${tpl.steps.length} étapes).` : 'Ajoutez d’abord des tâches datées à ce projet.');
  });
  el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-color]');
    if (c) { p.color = c.dataset.color; el.querySelectorAll('.color').forEach((x) => x.classList.toggle('on', x === c)); }
    if (e.target.closest('[data-save]')) {
      el.querySelectorAll('[data-k]').forEach((i) => { p[i.dataset.k] = i.value.trim() || (i.dataset.k === 'name' ? '' : null); });
      if (!p.name) { toast('Donnez un nom au projet.'); return; }
      putProject(p); close(); toast('Projet enregistré.');
    }
    if (e.target.closest('[data-del]')) {
      const n = tasks().filter((t) => t.projectId === p.id).length;
      if (await confirmDialog(`Supprimer le projet « ${p.name} » ? ${n ? `Ses ${n} tâche(s) seront conservées, sans projet.` : ''}`)) { removeProject(p.id); close(); }
    }
  });
}

export function openResourceEditor(id = null, type = 'personne') {
  const existing = id ? db.resources[id] : null;
  const r = existing ? { ...existing } : newResource({ type });
  const body = () => `
    ${slider('rtype', { label: 'Type', values: Object.keys(RES_TYPES), labels: Object.values(RES_TYPES).map((T) => T.label), value: r.type, ticks: 'labels' })}
    <label class="field big"><span>Nom</span><input type="text" data-k="name" value="${esc(r.name)}" autocomplete="off" placeholder="${r.type === 'personne' ? 'Prénom Nom' : r.type === 'budget' ? 'Ex. : Budget formation 2026' : r.type === 'salle' ? 'Ex. : Salle Mistral' : r.type === 'lieu' ? 'Ex. : Lyon – Part-Dieu' : 'Ex. : Vidéoprojecteur'}"></label>
    ${r.type === 'personne' ? `<label class="field"><span>E-mail (facultatif)</span><input type="email" data-k="email" value="${esc(r.email || '')}"></label>` : ''}
    ${r.type === 'budget' ? `<label class="field"><span>Montant total (€)</span><input type="number" min="0" step="any" data-k="capacity" value="${r.capacity ?? ''}"></label>` : ''}
    ${r.type === 'materiel' ? `<label class="field"><span>Quantité disponible</span><input type="number" min="0" step="1" data-k="capacity" value="${r.capacity ?? ''}"></label>` : ''}
    <label class="field"><span>Notes</span><textarea data-k="notes" rows="2">${esc(r.notes || '')}</textarea></label>`;
  const { el, close } = openDialog({
    title: existing ? 'Modifier la ressource' : 'Nouvelle ressource',
    body: body(),
    footer: `${existing ? `<button type="button" class="btn ghost danger-text" data-del>${icon('trash', 16)} Supprimer</button>` : ''}<span class="spacer"></span>
      <button type="button" class="btn ghost" data-close>Annuler</button><button type="button" class="btn primary" data-save>Enregistrer</button>`,
  });
  const read = () => el.querySelectorAll('[data-k]').forEach((i) => {
    const k = i.dataset.k;
    r[k] = k === 'capacity' ? (i.value === '' ? null : Number(i.value)) : i.value.trim();
  });
  bindSliders(el, (name, v, final) => {
    if (name === 'rtype' && final && v !== r.type) { read(); r.type = v; el.querySelector('.sheet-body').innerHTML = body(); }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-save]')) {
      read();
      if (!r.name) { toast('Donnez un nom à la ressource.'); return; }
      putResource(r); close(); toast('Ressource enregistrée.');
    }
    if (e.target.closest('[data-del]')) {
      if (await confirmDialog(`Supprimer « ${r.name} » ? Elle sera retirée des tâches.`)) { removeResource(r.id); close(); }
    }
  });
}

export function renderResources(el) {
  const an = analyze();
  const all = tasks();
  const ps = projects();
  const rs = resources();

  const projHtml = ps.map((p) => {
    const list = all.filter((t) => t.projectId === p.id);
    const done = list.filter((t) => t.status === 'done').length;
    const late = list.filter((t) => an[t.id]?.late).length;
    const planned = list.filter((t) => t.start);
    const end = planned.length ? new Date(Math.max(...planned.map((t) => tEnd(t)))) : null;
    return `<li class="card res-card" data-proj="${p.id}">
      <div class="row gap"><i class="dot lg" style="background:${esc(p.color)}"></i><b>${esc(p.name)}</b><span class="spacer"></span>
        ${late ? `<span class="badge danger">${late} critique${late > 1 ? 's' : ''}</span>` : ''}</div>
      <div class="progress"><i style="width:${list.length ? (done / list.length) * 100 : 0}%;background:${esc(p.color)}"></i></div>
      <small class="muted">${done}/${list.length} tâche${list.length > 1 ? 's' : ''} faite${done > 1 ? 's' : ''}
        ${end ? ` · fin prévue ${fmt.dateShort.format(new Date(end - 1))}` : ''}${p.deadline ? ` · échéance ${fmt.dateShort.format(parse(p.deadline))}` : ''}</small>
    </li>`;
  }).join('');

  const resHtml = Object.entries(RES_TYPES).map(([type, T]) => {
    const list = rs.filter((r) => r.type === type);
    return `<section class="res-group">
      <header><h3>${T.plural}</h3><button class="icon-btn xs" data-newres="${type}" title="Ajouter" aria-label="Ajouter">${icon('plus', 16)}</button></header>
      ${list.length ? `<ul class="res-list">${list.map((r) => {
        const used = all.filter((t) => t.assign.some((a) => a.id === r.id) || t.delegate === r.id);
        const open = used.filter((t) => t.status !== 'done');
        const qty = all.reduce((s, t) => s + (Number(t.assign.find((a) => a.id === r.id)?.qty) || 0), 0);
        const pct = r.capacity ? Math.min(100, (qty / r.capacity) * 100) : null;
        const over = r.capacity && qty > r.capacity;
        return `<li class="card res-card" data-res="${r.id}">
          <div class="row gap"><b>${esc(r.name)}</b><span class="spacer"></span><small class="muted">${open.length} tâche${open.length > 1 ? 's' : ''} en cours</small></div>
          ${type === 'budget' || type === 'materiel' ? `
            <div class="progress ${over ? 'over' : ''}"><i style="width:${pct ?? 0}%"></i></div>
            <small class="${over ? 'danger-text' : 'muted'}">${qty.toLocaleString('fr-FR')} ${T.unit} engagé${r.capacity ? ` sur ${Number(r.capacity).toLocaleString('fr-FR')} ${T.unit}` : ''}${over ? ' — dépassement' : ''}</small>` : ''}
          ${type === 'personne' && qty ? `<small class="muted">${qty.toLocaleString('fr-FR')} h affectées</small>` : ''}
          ${open.length ? `<ul class="mini-tasks">${open.slice(0, 4).map((t) => `<li><button class="link" data-task="${t.id}">${esc(t.title)}</button>${t.delegate === r.id ? ' <small class="muted">(déléguée)</small>' : ''}</li>`).join('')}${open.length > 4 ? `<li class="muted sm">+ ${open.length - 4} autre(s)</li>` : ''}</ul>` : ''}
        </li>`;
      }).join('')}</ul>` : `<p class="muted sm">—</p>`}
    </section>`;
  }).join('');

  el.innerHTML = `
    <section class="view res-view">
      <div class="section-head"><h2>Projets</h2><span class="spacer"></span><button class="btn ghost sm" data-fromtpl>${icon('copy', 16)} Depuis un modèle</button><button class="icon-btn" data-newproj title="Nouveau projet" aria-label="Nouveau projet">${icon('plus', 20)}</button></div>
      ${ps.length ? `<ul class="res-grid">${projHtml}</ul>` : '<p class="muted">Aucun projet.</p>'}
      <div class="section-head"><h2>Ressources ${info('ressources')}</h2></div>
      <div class="res-groups">${resHtml}</div>
    </section>`;

  el.querySelector('.res-view').addEventListener('click', (e) => {
    const tk = e.target.closest('[data-task]');
    if (tk) { openTaskEditor(tk.dataset.task); return; }
    if (e.target.closest('[data-fromtpl]')) { openTemplateDialog(); return; }
    if (e.target.closest('[data-newproj]')) { openProjectEditor(); return; }
    const nr = e.target.closest('[data-newres]');
    if (nr) { openResourceEditor(null, nr.dataset.newres); return; }
    const pc = e.target.closest('[data-proj]');
    if (pc) { openProjectEditor(pc.dataset.proj); return; }
    const rc = e.target.closest('[data-res]');
    if (rc) openResourceEditor(rc.dataset.res);
  });
}

/** Nouveau projet à partir d'un modèle : rétroplanning depuis la date clé. */
export function openTemplateDialog() {
  const list = allTemplates();
  let sel = list[0]?.id;
  const def = toDateStr(addDays(new Date(), 42));
  const body = () => `
    <div class="tpl-list">${list.map((t) => `
      <label class="tpl-item ${t.id === sel ? 'on' : ''}"><input type="radio" name="tpl" value="${t.id}" ${t.id === sel ? 'checked' : ''}>
        <span><b>${esc(t.name)}</b><small>${t.steps.length} étapes${t.builtin ? ' · modèle fourni' : ''}</small></span>
        ${t.builtin ? '' : `<button type="button" class="icon-btn xs" data-deltpl="${t.id}" title="Supprimer ce modèle">${icon('trash', 14)}</button>`}
      </label>`).join('')}</div>
    <label class="field big"><span>Nom du projet</span><input type="text" data-k="name" value="${esc(list.find((t) => t.id === sel)?.name || '')}"></label>
    <label class="field"><span>${esc(list.find((t) => t.id === sel)?.anchor || 'Date clé')}</span><input type="date" data-k="date" value="${def}"></label>
    <p class="hint">Les étapes sont planifiées à rebours depuis cette date, en jours ouvrés, avec leurs liens. Tout reste modifiable ensuite.</p>`;
  const { el, close } = openDialog({
    title: 'Nouveau projet depuis un modèle', body: body(),
    footer: `<span class="spacer"></span><button type="button" class="btn ghost" data-close>Annuler</button><button type="button" class="btn primary" data-create>Créer le projet</button>`,
  });
  el.addEventListener('change', (e) => {
    if (e.target.name === 'tpl') { sel = e.target.value; el.querySelector('.sheet-body').innerHTML = body(); }
  });
  el.addEventListener('click', (e) => {
    const d = e.target.closest('[data-deltpl]');
    if (d) { e.preventDefault(); removeTemplate(d.dataset.deltpl); close(); toast('Modèle supprimé.'); return; }
    if (e.target.closest('[data-create]')) {
      const name = el.querySelector('[data-k="name"]').value.trim();
      const date = el.querySelector('[data-k="date"]').value;
      if (!date) { toast('Indiquez la date clé.'); return; }
      const r = instantiate(sel, { name, anchorDate: date });
      close();
      if (r) { toast(`Projet « ${r.project.name} » créé : ${r.count} tâches planifiées.`); location.hash = '#gantt'; }
    }
  });
}
