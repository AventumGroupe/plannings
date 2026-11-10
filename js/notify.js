// Rappels et notifications.
// - Application Android (APK) : notifications natives programmées à l'avance (rappels, résumé du matin,
//   relances de délégation, revue du vendredi, fin de séance) : elles arrivent même application fermée.
// - Version web : l'application affiche les rappels tant qu'elle est ouverte (ou en arrière-plan récent).

import { db, tasks, local } from './store.js';
import { tStart, tEnd } from './sched.js';
import { fmt, sameDay, toDateStr, addDays, startOfDay, MIN } from './util.js';

const LN = () => (window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.LocalNotifications : null);
export const isNativeNotif = () => !!LN();

export const notifSupported = () => isNativeNotif() || ('Notification' in window && 'serviceWorker' in navigator);
export const notifEnabled = () => {
  if (!local.get('notify', false)) return false;
  if (isNativeNotif()) return true;
  return notifSupported() && Notification.permission === 'granted';
};

export async function enableNotifications() {
  if (isNativeNotif()) {
    let r = await LN().checkPermissions();
    if (r.display !== 'granted') r = await LN().requestPermissions();
    const ok = r.display === 'granted';
    local.set('notify', ok);
    if (ok) { refreshNative(true); }
    return ok ? 'granted' : 'denied';
  }
  if (!notifSupported()) return 'unsupported';
  const p = await Notification.requestPermission();
  local.set('notify', p === 'granted');
  if (p === 'granted') tick();
  return p;
}
export function disableNotifications() {
  local.set('notify', false);
  if (isNativeNotif()) cancelAllNative();
}

export async function show(title, body, tag, url = './#taches') {
  if (isNativeNotif()) {
    try { await LN().schedule({ notifications: [{ id: nid(tag + Date.now()), title, body, schedule: { at: new Date(Date.now() + 1000), allowWhileIdle: true }, extra: { url } }] }); } catch (e) { console.warn(e); }
    return;
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { url }, renotify: false };
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch (e) { console.warn('Notification impossible', e); }
}

// ---------- Ce qu'il faut rappeler ----------
const reminderAt = (t) => {
  const S = db.settings, s = tStart(t).getTime();
  return t.allDay ? s + S.dayStart * 60 * MIN - (t.reminder >= 1440 ? 1440 * MIN : 0) : s - t.reminder * MIN;
};

function digestFor(day) {
  const open = tasks().filter((t) => t.status !== 'done' && !t.delegate);
  const ds = startOfDay(day), de = addDays(ds, 1);
  const list = open.filter((t) => t.start && tStart(t) < de && tEnd(t) > ds);
  const heavy = list.filter((t) => t.energy <= 2).length;
  const due = open.filter((t) => t.due === toDateStr(day)).length;
  if (!list.length && !due) return null;
  const parts = [`${list.length} tâche${list.length > 1 ? 's' : ''} prévue${list.length > 1 ? 's' : ''}`];
  if (heavy) parts.push(`${heavy} plombante${heavy > 1 ? 's' : ''} : à faire ce matin`);
  if (due) parts.push(`${due} échéance${due > 1 ? 's' : ''} aujourd’hui`);
  return parts.join(' · ');
}

/** Toutes les notifications à venir sur `days` jours : { key, at (ms), title, body, url } */
export function upcoming(days = 7, now = Date.now()) {
  const S = db.settings, out = [];
  const end = now + days * 864e5;
  const add = (key, at, title, body, url = './#journee') => { if (at > now && at < end) out.push({ key, at, title, body, url }); };
  for (const t of tasks()) {
    if (t.status === 'done') continue;
    if (t.start && t.reminder != null) {
      const when = t.allDay ? 'aujourd’hui' : `à ${fmt.time.format(tStart(t))}`;
      add(`${t.id}@${t.start}`, reminderAt(t), t.title, `Prévue ${when}${t.energy <= 2 ? ' · tâche plombante' : ''}`, './#journee');
    }
    if (t.delegate && t.followUp && db.resources[t.delegate]) {
      const d = new Date(t.followUp + 'T00:00'); d.setHours(S.dayStart, 30, 0, 0);
      add(`fu:${t.id}:${t.followUp}`, d.getTime(), `Faire le point avec ${db.resources[t.delegate].name}`, `Retour attendu aujourd’hui : « ${t.title} »`, './#taches');
    }
  }
  for (let i = 0; i <= days; i++) {
    const day = addDays(startOfDay(new Date(now)), i);
    if (!S.workDays.includes(day.getDay())) continue;
    const at = new Date(day); at.setHours(S.dayStart, 0, 0, 0);
    const body = digestFor(day);
    if (body) add(`digest:${toDateStr(day)}`, at.getTime(), 'Votre journée', body, './#journee');
  }
  // Revue de la semaine : dernier jour travaillé, 16 h, si pas encore faite
  const lastWd = Math.max(...S.workDays.map((d) => (d + 6) % 7));
  for (let i = 0; i <= days; i++) {
    const day = addDays(startOfDay(new Date(now)), i);
    if ((day.getDay() + 6) % 7 !== lastWd) continue;
    const ws = addDays(day, -lastWd);
    if (local.get('lastReview', '') === toDateStr(ws)) continue;
    const at = new Date(day); at.setHours(16, 0, 0, 0);
    add(`review:${toDateStr(day)}`, at.getTime(), 'Revue de la semaine', '15 minutes pour boucler la semaine et préparer la suivante.', './#journee/revue');
  }
  // Fin de la séance de concentration en cours
  const f = local.get('focus', null);
  if (f && (f.mode === 'work' || f.mode === 'break') && !f.pausedAt) {
    const at = f.start + f.dur * MIN + (f.pausedTotal || 0);
    const t = db.tasks[f.taskId];
    add(`focus:${f.start}:${f.dur}`, at, f.mode === 'work' ? 'Séance terminée 🍅' : 'Fin de la pause',
      f.mode === 'work' ? `Bravo ! ${t ? `« ${t.title} » : ` : ''}temps enregistré. Une petite pause ?` : 'On s’y remet ?', './#journee');
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 60);
}

// ---------- Android : programmation native ----------
/** Identifiant entier stable (31 bits) à partir d'une clé. */
function nid(key) { let h = 2166136261; for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 1) || 1; }

async function cancelAllNative() {
  try { const p = await LN().getPending(); if (p.notifications?.length) await LN().cancel({ notifications: p.notifications.map((n) => ({ id: n.id })) }); } catch (e) { console.warn(e); }
}

let nativeTimer = null, lastPlan = '';
/** Reprogramme les notifications natives (appelé après chaque modification, avec un délai). */
export function refreshNative(now = false) {
  if (!isNativeNotif() || !notifEnabled()) return;
  clearTimeout(nativeTimer);
  nativeTimer = setTimeout(async () => {
    const list = upcoming();
    const plan = JSON.stringify(list.map((n) => [n.key, n.at, n.title, n.body]));
    if (plan === lastPlan) return;
    lastPlan = plan;
    try {
      await cancelAllNative();
      if (list.length) {
        await LN().schedule({ notifications: list.map((n) => ({
          id: nid(n.key), title: n.title, body: n.body, schedule: { at: new Date(n.at), allowWhileIdle: true }, extra: { url: n.url },
        })) });
      }
    } catch (e) { console.warn('Programmation des notifications impossible', e); lastPlan = ''; }
  }, now ? 50 : 2500);
}

// ---------- Boucle ----------
let timer = null;
export function startReminders() {
  if (isNativeNotif()) {
    // Toucher une notification ouvre le bon écran
    LN().addListener?.('localNotificationActionPerformed', (a) => { const u = a?.notification?.extra?.url; if (u) location.hash = u.replace(/^\.\//, ''); });
    refreshNative(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastPlan = ''; refreshNative(true); } });
    return;
  }
  clearInterval(timer);
  timer = setInterval(tick, 30 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();
}

/** Web : affiche ce qui est dû maintenant (fenêtre de 15 min). */
function tick() {
  if (!notifEnabled()) return;
  const sent = local.get('sent', {});
  const now = Date.now();
  for (const n of upcoming(1, now - 15 * MIN)) {
    if (n.key.startsWith('focus:')) continue; // le minuteur gère lui-même la fin de séance quand l'application est ouverte
    if (now >= n.at && now < n.at + 15 * MIN && !sent[n.key]) { sent[n.key] = now; show(n.title, n.body, n.key, n.url); }
  }
  for (const k in sent) if (now - sent[k] > 3 * 864e5) delete sent[k];
  local.set('sent', sent);
}
