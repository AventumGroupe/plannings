// Délégation suivie : à qui, depuis quand, retour attendu, relances.
// Pour l'instant la délégation est notée chez le délégant ; la délégation en ligne
// (la tâche arrive chez le collaborateur) viendra avec le déploiement à l'équipe.

import { db, tasks, putTask } from './store.js';
import { addWorkDays } from './templates.js';
import { delegateAbsence, absenceLabel } from './rh.js';
import { esc, icon, toDateStr, fmt, cap, parse, startOfDay, daysBetween } from './util.js';

const today = () => toDateStr(new Date());

/** Retour attendu par défaut : l'échéance si elle existe (moins 1 jour ouvré), sinon dans 3 jours ouvrés. */
export function defaultFollowUp(t) {
  if (t.due) { const d = addWorkDays(parse(t.due), -1); return toDateStr(d < new Date() ? new Date() : d); }
  return toDateStr(addWorkDays(new Date(), 3));
}

/** Confie la tâche (personId null = la reprendre). Ne sauvegarde pas si save=false (fiche en cours d'édition). */
export function delegateTo(t, personId, { followUp, save = true } = {}) {
  if (!personId) { t.delegate = null; t.delegatedAt = null; t.followUp = null; }
  else {
    if (t.delegate !== personId) { t.delegatedAt = Date.now(); t.nudges = []; }
    t.delegate = personId;
    t.followUp = followUp || t.followUp || defaultFollowUp(t);
  }
  if (save) putTask(t);
  return t;
}

export const waiting = () => tasks().filter((t) => t.delegate && t.status !== 'done' && db.resources[t.delegate]);
export const followUpDue = () => waiting().filter((t) => (t.followUp || '9999') <= today());

/** Lien e-mail de relance (mailto). */
export function nudgeHref(t) {
  const p = db.resources[t.delegate];
  const first = (p?.name || '').split(' ')[0];
  const back = t.followUp ? fmt.dateShort.format(parse(t.followUp)) : null;
  const subject = `Point sur : ${t.title}`;
  const body = `Bonjour ${first},\n\nOù en es-tu sur « ${t.title} » ?${back ? `\nLe retour était prévu le ${back}.` : ''}${t.due ? `\nÉchéance : ${fmt.dateShort.format(parse(t.due))}.` : ''}\n\nDis-moi si tu as besoin de quelque chose.\nMerci !`;
  return `mailto:${encodeURIComponent(p?.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Note la relance et repousse le prochain point de 2 jours ouvrés. */
export function recordNudge(t) {
  t.nudges = [...(t.nudges || []), Date.now()];
  t.followUp = toDateStr(addWorkDays(new Date(), 2));
  putTask(t);
}

const since = (ts) => { const n = ts ? daysBetween(startOfDay(new Date(ts)), startOfDay(new Date())) : null; return n == null ? '' : n === 0 ? 'aujourd’hui' : n === 1 ? 'hier' : `il y a ${n} j`; };

/** Bloc « En attente de… » de l'écran principal, regroupé par personne. */
export function waitingHtml(open) {
  const list = waiting();
  if (!list.length) return '';
  const due = list.filter((t) => (t.followUp || '9999') <= today()).length;
  const by = new Map();
  for (const t of list.sort((a, b) => (a.followUp || '9').localeCompare(b.followUp || '9'))) {
    if (!by.has(t.delegate)) by.set(t.delegate, []);
    by.get(t.delegate).push(t);
  }
  return `<section class="card wait ${open ? 'open' : ''}">
    <button class="suggest-toggle" data-toggle-wait aria-expanded="${!!open}">
      ${icon('people', 18)} <b>En attente de…</b> <span class="count">${list.length}</span>
      ${due ? `<span class="badge danger">${due} à relancer</span>` : ''}
      <span class="caret ${open ? 'open' : ''}">${icon('chevR', 16)}</span>
    </button>
    ${open ? [...by].map(([pid, ts]) => {
      const p = db.resources[pid];
      return `<div class="wait-person"><header><span class="avatar">${esc((p.name || '?').slice(0, 1).toUpperCase())}</span><b>${esc(p.name)}</b><small>${ts.length} tâche${ts.length > 1 ? 's' : ''}</small></header>
        <ul>${ts.map((t) => {
          const late = (t.followUp || '9999') <= today();
          const n = (t.nudges || []).length;
          return `<li class="${late ? 'late' : ''}">
            <button class="link wait-title" data-open-id="${t.id}">${esc(t.title)}</button>
            <small>${t.shared?.role === 'de' ? `<b class="share-st st-${t.shared.status}">${{ proposee: 'en attente d’acceptation', acceptee: 'acceptée', faite: 'faite', refusee: 'refusée', annulee: 'annulée' }[t.shared.status] || ''}</b> · ` : ''}${delegateAbsence(t) ? `<b class="danger-text">${esc(absenceLabel(delegateAbsence(t)))}</b> · ` : ''}confiée ${since(t.delegatedAt)}${t.followUp ? ` · retour ${late ? '<b>' : ''}${cap(fmt.dayShort.format(parse(t.followUp)))}${late ? '</b>' : ''}` : ''}${n ? ` · ${n} relance${n > 1 ? 's' : ''}` : ''}</small>
            <span class="wait-acts">
              <a class="btn sm ${late ? 'primary' : 'ghost'}" href="${nudgeHref(t)}" data-nudge="${t.id}">${icon('bell', 14)} Relancer</a>
              <button class="btn sm ghost" data-received="${t.id}">${icon('check', 14)} Reçu</button>
            </span>
          </li>`;
        }).join('')}</ul></div>`;
    }).join('') : ''}
  </section>`;
}
