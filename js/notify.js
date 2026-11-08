// Rappels et notifications.
// Quand l'application est ouverte (ou en arrière-plan récent), elle affiche les rappels elle-même.
// Quand elle est fermée, les rappels des événements synchronisés dans Outlook prennent le relais.

import { db, tasks, local } from './store.js';
import { tStart, tEnd } from './sched.js';
import { fmt, sameDay, toDateStr, MIN } from './util.js';

export const notifSupported = () => 'Notification' in window && 'serviceWorker' in navigator;
export const notifEnabled = () => notifSupported() && Notification.permission === 'granted' && local.get('notify', false);

export async function enableNotifications() {
  if (!notifSupported()) return 'unsupported';
  const p = await Notification.requestPermission();
  local.set('notify', p === 'granted');
  if (p === 'granted') tick();
  return p;
}
export function disableNotifications() { local.set('notify', false); }

export async function show(title, body, tag, url = './#taches') {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { url }, renotify: false };
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch (e) { console.warn('Notification impossible', e); }
}

let timer = null;
export function startReminders() {
  clearInterval(timer);
  timer = setInterval(tick, 30 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();
}

function tick() {
  if (!notifEnabled()) return;
  const sent = local.get('sent', {});
  const now = Date.now();
  const S = db.settings;

  for (const t of tasks()) {
    if (t.status === 'done' || !t.start || t.reminder == null) continue;
    const s = tStart(t).getTime();
    const at = t.allDay ? s + S.dayStart * 60 * MIN - (t.reminder >= 1440 ? 1440 * MIN : 0) : s - t.reminder * MIN;
    const key = `${t.id}@${t.start}`;
    if (now >= at && now < Math.max(at, s) + 15 * MIN && !sent[key]) {
      sent[key] = now;
      const when = t.allDay ? 'aujourd’hui' : `à ${fmt.time.format(new Date(s))}`;
      show(t.title, `Prévue ${when}${t.energy <= 2 ? ' · tâche plombante' : ''}`, key, `./#taches`);
    }
  }

  // Résumé du matin : une fois par jour, à l'heure de début de journée
  const today = new Date();
  const dk = `digest:${toDateStr(today)}`;
  if (!sent[dk] && today.getHours() >= S.dayStart && today.getHours() < S.dayEnd && S.workDays.includes(today.getDay())) {
    sent[dk] = now;
    const open = tasks().filter((t) => t.status !== 'done');
    const todayList = open.filter((t) => t.start && tStart(t) <= today && tEnd(t) > new Date(today.toDateString()) || (t.start && sameDay(tStart(t), today)));
    const heavy = todayList.filter((t) => t.energy <= 2).length;
    const due = open.filter((t) => t.due === toDateStr(today)).length;
    if (todayList.length || due) {
      const parts = [`${todayList.length} tâche${todayList.length > 1 ? 's' : ''} prévue${todayList.length > 1 ? 's' : ''}`];
      if (heavy) parts.push(`${heavy} plombante${heavy > 1 ? 's' : ''} : à faire ce matin`);
      if (due) parts.push(`${due} échéance${due > 1 ? 's' : ''} aujourd’hui`);
      show('Votre journée', parts.join(' · '), dk, './#calendrier/jour');
    }
  }

  for (const k in sent) if (now - sent[k] > 3 * 864e5) delete sent[k];
  local.set('sent', sent);
}
