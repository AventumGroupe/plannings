// Assistant Claude : questions en langage courant sur son planning.
// La question et un résumé des tâches passent par la plateforme RH (relais qui garde la clé d'API).
// Les actions proposées ne sont appliquées qu'une par une, après validation.

import { db, tasks, newTask, putTask, save, local, people, score, category, catInfo, remainingOf, outlookEvents, isLeader } from './store.js';
import { tStart, tEnd, setSpan, propagate, completeTask } from './sched.js';
import { delegateTo } from './delegation.js';
import { energyNow } from './today.js';
import { rhApi, rhConfigured } from './rh.js';
import { openDialog, toast } from './ui.js';
import { esc, icon, fmt, cap, parse, toLocal, toDateStr, addDays, startOfDay, MIN } from './util.js';

const history = () => local.get('assistantHistory', []);
const setHistory = (h) => local.set('assistantHistory', h.length > 30 ? h.slice(-30) : h);

/** Résumé des données envoyé avec la question (pas de notes, pas d'e-mails). */
function context() {
  const now = new Date();
  const horizon = addDays(startOfDay(now), 14);
  const open = tasks().filter((t) => t.status !== 'done').sort((a, b) => score(b) - score(a)).slice(0, 150);
  return {
    maintenant: toLocal(now), jour: cap(fmt.dayLong.format(now)),
    profil: isLeader() ? 'dirigeant' : 'collaborateur',
    energie_du_moment: energyNow(),
    horaires: { debut: db.settings.dayStart, fin_matinee: db.settings.morningEnd, fin: db.settings.dayEnd, jours_travailles: db.settings.workDays, seance_plombante_min: db.settings.sessionPlomb || 25, seance_autre_min: db.settings.sessionDyn || 50 },
    personnes: people().map((p) => p.name),
    projets: Object.values(db.projects).map((p) => ({ id: p.id, nom: p.name })),
    taches: open.map((t) => ({
      id: t.id, titre: t.title, u: t.urgency, i: t.importance, e: t.energy, categorie: catInfo(category(t)).label,
      charge_min: t.estimate || null, reste_min: remainingOf(t) || null, echeance: t.due || null,
      debut: t.start || null, fin: t.end || null, journee: !!t.allDay, statut: t.status,
      projet: t.projectId ? db.projects[t.projectId]?.name || null : null,
      confiee_a: t.delegate ? db.resources[t.delegate]?.name || null : null,
      sous_taches: (t.subtasks || []).filter((s) => !s.done).map((s) => s.title).slice(0, 8),
    })),
    rendez_vous: outlookEvents().filter((ev) => parse(ev.end) > now && parse(ev.start) < horizon && ev.showAs !== 'free')
      .map((ev) => ({ titre: ev.subject || 'Rendez-vous', debut: ev.start, fin: ev.end, journee: !!ev.isAllDay })).slice(0, 80),
  };
}

const ACT_LABEL = { planifier: 'Planifier', deleguer: 'Confier', modifier: 'Modifier', creer: 'Créer', terminer: 'Terminer' };

function actionText(a) {
  const t = a.tache_id && db.tasks[a.tache_id];
  const name = t ? `« ${t.title} »` : a.titre ? `« ${a.titre} »` : '';
  const when = a.debut ? `${cap(fmt.dayShort.format(parse(a.debut)))} à ${fmt.time.format(parse(a.debut))}` : '';
  switch (a.type) {
    case 'planifier': return `${name} ${when}${a.duree_min ? ` (${a.duree_min} min)` : ''}`;
    case 'deleguer': return `${name} à ${a.personne || '?'}`;
    case 'modifier': return `${name} : ${[a.urgence && `urgence ${a.urgence}`, a.importance && `importance ${a.importance}`, a.energie && `énergie ${a.energie}`, a.echeance && `échéance ${a.echeance}`].filter(Boolean).join(', ')}`;
    case 'creer': return `${name}${when ? ' ' + when : ''}${a.echeance ? ` · échéance ${a.echeance}` : ''}`;
    case 'terminer': return name;
    default: return name;
  }
}

/** Applique une action validée. Retourne un message. */
export function applyAction(a) {
  const t = a.tache_id ? db.tasks[a.tache_id] : null;
  const clamp = (v, lo, hi) => (v == null ? null : Math.max(lo, Math.min(hi, Math.round(v))));
  if (a.type !== 'creer' && !t) throw new Error('Tâche introuvable.');
  if (a.type === 'planifier') {
    const s = parse(a.debut); if (isNaN(s)) throw new Error('Date invalide.');
    const dur = clamp(a.duree_min, 5, 600) || Math.min(t.estimate || 60, 240);
    t.allDay = false; setSpan(t, s, new Date(s.getTime() + dur * MIN)); putTask(t, { silent: true }); propagate([t.id]); save('assistant');
    return `Planifiée ${cap(fmt.dayShort.format(s))} à ${fmt.time.format(s)}.`;
  }
  if (a.type === 'deleguer') {
    const p = people().find((x) => x.name.toLowerCase() === String(a.personne || '').toLowerCase()) || people().find((x) => x.name.toLowerCase().startsWith(String(a.personne || '').toLowerCase().split(' ')[0]));
    if (!p) throw new Error(`Personne inconnue : ${a.personne}`);
    delegateTo(t, p.id); return `Confiée à ${p.name}.`;
  }
  if (a.type === 'modifier') {
    if (a.urgence) t.urgency = clamp(a.urgence, 1, 5);
    if (a.importance) t.importance = clamp(a.importance, 1, 5);
    if (a.energie) t.energy = clamp(a.energie, 1, 4);
    if (a.echeance && /^\d{4}-\d{2}-\d{2}$/.test(a.echeance)) t.due = a.echeance;
    putTask(t); return 'Tâche mise à jour.';
  }
  if (a.type === 'terminer') { completeTask(t); save('assistant'); return 'Tâche terminée.'; }
  if (a.type === 'creer') {
    const n = newTask({ title: a.titre || 'Nouvelle tâche', urgency: clamp(a.urgence, 1, 5) || 3, importance: clamp(a.importance, 1, 5) || 3, energy: clamp(a.energie, 1, 4) || 3, estimate: clamp(a.duree_min, 5, 12000) || 60, due: /^\d{4}-\d{2}-\d{2}$/.test(a.echeance || '') ? a.echeance : null });
    if (a.debut && !isNaN(parse(a.debut))) { const s = parse(a.debut); setSpan(n, s, new Date(s.getTime() + Math.min(n.estimate, 240) * MIN)); }
    putTask(n); return `Tâche « ${n.title} » créée.`;
  }
  throw new Error('Action inconnue.');
}

const SUGGESTED = ['Que faire maintenant ?', 'Organise ma journée de demain', 'Qu’est-ce que je peux déléguer ?', 'Suis-je trop chargé cette semaine ?'];

export function openAssistant() {
  let busy = false;
  const msgsHtml = () => {
    const h = history();
    if (!h.length) return `<div class="as-empty">${icon('bulb', 28)}<p>Posez une question sur votre planning. Je propose, vous validez.</p>
      <div class="as-sugg">${SUGGESTED.map((s) => `<button type="button" class="chip" data-ask="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
    return h.map((m, i) => `<div class="as-msg ${m.role}"><div class="as-bubble">${esc(m.content).replace(/\n/g, '<br>')}</div>
      ${m.role === 'assistant' && m.actions?.length ? `<ul class="as-acts">${m.actions.map((a, j) => {
        const st = a.done;
        return `<li class="${st ? 'done' : ''}"><span><b>${ACT_LABEL[a.type] || a.type}</b> ${esc(actionText(a))}${a.justification ? `<small>${esc(a.justification)}</small>` : ''}</span>
          ${st ? `<span class="badge ${st === 'ok' ? 'accent' : 'muted'}">${st === 'ok' ? 'Fait' : 'Ignoré'}</span>` : `<span class="as-btns"><button type="button" class="btn sm primary" data-apply="${i}:${j}">Appliquer</button><button type="button" class="icon-btn xs" data-skipact="${i}:${j}" aria-label="Ignorer">${icon('close', 14)}</button></span>`}</li>`;
      }).join('')}</ul>` : ''}</div>`).join('') + (busy ? '<div class="as-msg assistant"><div class="as-bubble typing"><i></i><i></i><i></i></div></div>' : '');
  };
  const body = rhConfigured() ? `<div class="as-log">${msgsHtml()}</div>
      <div class="as-form"><textarea rows="2" placeholder="Votre question…" data-q aria-label="Question"></textarea><button class="btn primary" type="button" data-send aria-label="Envoyer">${icon('chevR', 18)}</button></div>
      <p class="muted sm as-note">Vos tâches (titres, critères, dates) sont envoyées à l’assistant via la plateforme RH. Pas de notes ni d’e-mails. ${history().length ? '<button type="button" class="link" data-asclear>Effacer la conversation</button>' : ''}</p>`
    : `<div class="as-empty">${icon('people', 28)}<p>L’assistant passe par la plateforme RH Aventum, qui garde la clé d’accès à Claude.</p><a class="btn primary" href="#reglages" data-close>Relier la plateforme RH</a></div>`;
  const { el, close } = openDialog({ title: 'Assistant', body, wide: true });
  el.classList.add('as-sheet');
  const log = () => el.querySelector('.as-log');
  const refresh = () => { const l = log(); if (l) { l.innerHTML = msgsHtml(); l.scrollTop = l.scrollHeight; } };
  refresh();

  const ask = async (q) => {
    q = q.trim(); if (!q || busy) return;
    const h = history();
    const prior = h.map((m) => ({ role: m.role, content: m.content }));
    h.push({ role: 'user', content: q }); setHistory(h);
    busy = true; refresh();
    try {
      const r = await rhApi('/api/plannings/assistant', { method: 'POST', body: { question: q, historique: prior, contexte: context() } });
      const h2 = history(); h2.push({ role: 'assistant', content: r.reponse || '…', actions: r.actions || [] }); setHistory(h2);
    } catch (e) {
      const h2 = history(); h2.push({ role: 'assistant', content: `⚠️ ${e.message}`, actions: [] }); setHistory(h2);
    } finally { busy = false; refresh(); }
  };

  const send = () => { const ta = el.querySelector('[data-q]'); const q = ta.value; ta.value = ''; ask(q); };
  el.addEventListener('keydown', (e) => {
    if (e.target.matches('[data-q]') && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-send]')) { send(); return; }
    const s = e.target.closest('[data-ask]'); if (s) { ask(s.dataset.ask); return; }
    if (e.target.closest('[data-asclear]')) { setHistory([]); refresh(); e.target.closest('[data-asclear]').remove(); return; }
    const ap = e.target.closest('[data-apply]');
    if (ap) {
      const [i, j] = ap.dataset.apply.split(':').map(Number);
      const h = history(); const a = h[i]?.actions?.[j]; if (!a) return;
      try { toast(applyAction(a)); a.done = 'ok'; } catch (err) { toast(err.message, { tone: 'danger' }); return; }
      setHistory(h); refresh(); return;
    }
    const sk = e.target.closest('[data-skipact]');
    if (sk) { const [i, j] = sk.dataset.skipact.split(':').map(Number); const h = history(); if (h[i]?.actions?.[j]) { h[i].actions[j].done = 'skip'; setHistory(h); } refresh(); }
  });
  setTimeout(() => el.querySelector('[data-q]')?.focus(), 60);
  return { el, close };
}
