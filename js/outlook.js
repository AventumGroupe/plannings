// Connexion Microsoft (MSAL) :
//  - synchronisation Outlook dans les deux sens (Microsoft Graph, calendrier) ;
//  - synchronisation entre appareils via un fichier dans le dossier d'application OneDrive.

import { db, tasks, putTask, save, local, mergeRemote, ENERGY } from './store.js';
import { tEnd, propagate } from './sched.js';
import { toLocal, toDateStr, parse, addDays, startOfDay } from './util.js';

const SCOPES = ['User.Read', 'Calendars.ReadWrite', 'Files.ReadWrite.AppFolder'];
const PROP = 'String {7d3f1b2a-4c6e-4f8a-9b1d-5e2c3a4b6d8f} Name gpTaskId';
const CATEGORY = 'Gestion des plannings';
const FILE = 'gestion-plannings.json';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const PAST_DAYS = 30, FUTURE_DAYS = 365;

let pca = null;
let account = null;
let running = null;

// ---------- État affiché ----------
const status = { state: 'off', last: local.get('lastSync', null), error: null, detail: '' };
const listeners = new Set();
export const onStatus = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const getStatus = () => ({ ...status });
function setStatus(p) { Object.assign(status, p); listeners.forEach((f) => f(getStatus())); }

export const clientId = () => local.get('msClientId', '');
export const setClientId = (v) => local.set('msClientId', (v || '').trim());
export const calendarId = () => local.get('msCalendarId', '');
export const setCalendarId = (v) => local.set('msCalendarId', v || '');
export const redirectUri = () => new URL('./', location.href).href;
export const isConnected = () => !!account;
export const accountLabel = () => account ? (account.name ? `${account.name} (${account.username})` : account.username) : '';

class GraphError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// ---------- Authentification ----------
export async function initMs() {
  const id = clientId();
  if (!id || !window.msal) { setStatus({ state: 'off' }); return false; }
  try {
    pca = new window.msal.PublicClientApplication({
      auth: { clientId: id, authority: 'https://login.microsoftonline.com/common', redirectUri: redirectUri(), navigateToLoginRequestUrl: false },
      cache: { cacheLocation: 'localStorage' },
    });
    await pca.initialize();
    const r = await pca.handleRedirectPromise();
    account = r?.account || pca.getActiveAccount() || pca.getAllAccounts()[0] || null;
    if (account) pca.setActiveAccount(account);
    setStatus({ state: account ? 'idle' : 'off', error: null });
    return !!account;
  } catch (e) {
    console.error(e);
    setStatus({ state: 'error', error: messageOf(e) });
    return false;
  }
}

export async function login() {
  if (!pca) await initMs();
  if (!pca) throw new Error('Renseignez d’abord l’identifiant d’application (client ID).');
  await pca.loginRedirect({ scopes: SCOPES, prompt: 'select_account' });
}

export async function logout() {
  if (!pca || !account) return;
  const a = account;
  account = null;
  setStatus({ state: 'off' });
  await pca.logoutRedirect({ account: a, postLogoutRedirectUri: redirectUri() });
}

async function token() {
  try {
    const r = await pca.acquireTokenSilent({ scopes: SCOPES, account });
    return r.accessToken;
  } catch (e) {
    if (e instanceof window.msal.InteractionRequiredAuthError) {
      await pca.acquireTokenRedirect({ scopes: SCOPES, account });
    }
    throw e;
  }
}

async function graph(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const url = path.startsWith('http') ? path : GRAPH + path;
  const h = { Authorization: `Bearer ${await token()}`, ...headers };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    throw new GraphError(res.status, msg);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

function messageOf(e) {
  if (!e) return '';
  if (e.status === 401 || e.status === 403) return 'Accès refusé par Microsoft : vérifiez les autorisations de l’application.';
  if (e.errorCode === 'user_cancelled') return 'Connexion annulée.';
  if (!navigator.onLine) return 'Hors connexion : la synchronisation reprendra automatiquement.';
  return e.message || String(e);
}

export async function listCalendars() {
  const r = await graph('/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=50');
  return (r.value || []).filter((c) => c.canEdit);
}

// ---------- Synchronisation globale ----------
/** Fusion OneDrive -> calendrier Outlook -> envoi OneDrive. */
export function syncAll({ manual = false } = {}) {
  if (!account) return Promise.resolve(false);
  if (!navigator.onLine) { setStatus({ state: 'offline', error: null }); return Promise.resolve(false); }
  if (running) return running;
  running = (async () => {
    setStatus({ state: 'syncing', error: null, detail: 'Appareils…' });
    try {
      const cloud = await pullCloud();
      setStatus({ detail: 'Outlook…' });
      const cal = await syncCalendar();
      setStatus({ detail: 'Enregistrement…' });
      await pushCloud(cloud.eTag);
      const now = Date.now();
      local.set('lastSync', now);
      setStatus({ state: 'idle', last: now, detail: '', lastResult: cal });
      return cal;
    } catch (e) {
      console.error(e);
      setStatus({ state: 'error', error: messageOf(e), detail: '' });
      if (manual) throw e;
      return false;
    } finally {
      running = null;
    }
  })();
  return running;
}

// ---------- OneDrive (entre appareils) ----------
const itemPath = `/me/drive/special/approot:/${encodeURIComponent(FILE)}`;

async function pullCloud() {
  let meta;
  try { meta = await graph(`${itemPath}?$select=id,eTag,@microsoft.graph.downloadUrl`); }
  catch (e) { if (e.status === 404) return { eTag: null }; throw e; }
  const url = meta['@microsoft.graph.downloadUrl'];
  if (url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) {
      const remote = await res.json().catch(() => null);
      if (remote) mergeRemote(remote);
    }
  }
  return { eTag: meta.eTag };
}

async function pushCloud(eTag, retry = true) {
  try {
    await graph(`${itemPath}:/content`, {
      method: 'PUT', raw: true, body: JSON.stringify(db),
      headers: { 'Content-Type': 'application/json', ...(eTag ? { 'If-Match': eTag } : {}) },
    });
  } catch (e) {
    if (e.status === 412 && retry) { // modifié entre-temps par un autre appareil
      const c = await pullCloud();
      return pushCloud(c.eTag, false);
    }
    throw e;
  }
}

// ---------- Calendrier Outlook (deux sens) ----------
const calBase = () => (calendarId() ? `/me/calendars/${calendarId()}` : '/me/calendar');
const SELECT = 'id,subject,start,end,isAllDay,lastModifiedDateTime,showAs,location,isCancelled,webLink,categories';
const EXPAND = `singleValueExtendedProperties($filter=id eq '${PROP}')`;
const PREFER = { Prefer: `outlook.timezone="${TZ}"` };

const localStr = (dt) => dt.slice(0, 16); // "2026-11-09T09:00:00.0000000" -> "2026-11-09T09:00"
const taskIdOf = (ev) => ev.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === PROP.toLowerCase())?.value || null;

function payload(t) {
  const p = db.projects[t.projectId];
  const end = tEnd(t);
  const lines = [
    t.notes || '',
    '',
    `Urgence ${t.urgency}/5 · Importance ${t.importance}/5 · Énergie : ${ENERGY[t.energy].label}`,
    p ? `Projet : ${p.name}` : '',
    t.subtasks.length ? `Sous-tâches :\n${t.subtasks.map((s) => `${s.done ? '☑' : '☐'} ${s.title}`).join('\n')}` : '',
    '— Gestion des plannings',
  ].filter((x, i) => x || i === 1);
  return {
    subject: (t.status === 'done' ? '✓ ' : '') + t.title,
    body: { contentType: 'text', content: lines.join('\n').trim() },
    start: { dateTime: t.allDay ? `${t.start.slice(0, 10)}T00:00:00` : `${t.start}:00`, timeZone: TZ },
    end: { dateTime: t.allDay ? `${toDateStr(end)}T00:00:00` : `${toLocal(end)}:00`, timeZone: TZ },
    isAllDay: !!t.allDay,
    isReminderOn: t.reminder != null && t.status !== 'done',
    reminderMinutesBeforeStart: t.reminder ?? 15,
    showAs: t.status === 'done' ? 'free' : 'busy',
    categories: [CATEGORY],
    singleValueExtendedProperties: [{ id: PROP, value: t.id }],
  };
}

function applyRemote(t, ev) {
  const subj = (ev.subject || '').replace(/^✓\s*/, '').trim();
  if (subj) t.title = subj;
  t.allDay = !!ev.isAllDay;
  const s = localStr(ev.start.dateTime), e = localStr(ev.end.dateTime);
  if (t.allDay) {
    t.start = `${s.slice(0, 10)}T00:00`;
    const last = addDays(parse(e), -1);
    t.end = `${toDateStr(last < parse(s) ? parse(s) : last)}T00:00`;
  } else {
    t.start = s; t.end = e;
    t.estimate = Math.max(15, Math.round((parse(e) - parse(s)) / 60000));
  }
  const now = Date.now();
  t.updatedAt = now;
  t.outlook = { id: ev.id, remoteMod: ev.lastModifiedDateTime, syncedAt: now };
  putTask(t, { silent: true, touch: false });
}

function markSynced(t, ev) {
  t.outlook = { id: ev.id, remoteMod: ev.lastModifiedDateTime, syncedAt: Math.max(Date.now(), t.updatedAt) };
  putTask(t, { silent: true, touch: false });
}

async function fetchView(from, to) {
  let url = `${calBase()}/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$top=250&$select=${SELECT}&$expand=${encodeURIComponent(EXPAND)}`;
  const out = [];
  let guard = 0;
  while (url && guard++ < 40) {
    const r = await graph(url, { headers: PREFER });
    out.push(...(r.value || []));
    url = r['@odata.nextLink'] || null;
  }
  return out;
}

export async function syncCalendar() {
  const now = new Date();
  const from = addDays(startOfDay(now), -PAST_DAYS);
  const to = addDays(startOfDay(now), FUTURE_DAYS);
  const events = await fetchView(from, to);

  const ours = new Map();
  const external = [];
  for (const ev of events) {
    if (ev.isCancelled) continue;
    const id = taskIdOf(ev);
    if (id) ours.set(id, ev);
    else external.push({
      id: ev.id, subject: ev.subject, start: localStr(ev.start.dateTime), end: localStr(ev.end.dateTime),
      isAllDay: ev.isAllDay, showAs: ev.showAs, location: ev.location?.displayName || '', webLink: ev.webLink,
    });
  }
  local.set('outlookEvents', external);

  const stats = { pulled: 0, pushed: 0, removed: 0 };
  const applied = [];

  // 1. Réception des modifications faites dans Outlook
  for (const t of tasks()) {
    let ev = ours.get(t.id);
    if (!ev && t.outlook?.id) {
      try { ev = await graph(`/me/events/${t.outlook.id}?$select=${SELECT}&$expand=${encodeURIComponent(EXPAND)}`, { headers: PREFER }); }
      catch (e) { if (e.status !== 404) throw e; ev = null; }
      if (!ev || ev.isCancelled) {
        // Supprimé dans Outlook
        const localChanged = t.updatedAt > (t.outlook.syncedAt || 0);
        if (localChanged && t.start) { t.outlook = null; putTask(t, { silent: true, touch: false }); }
        else { t.start = null; t.end = null; t.outlook = null; t.updatedAt = Date.now(); putTask(t, { silent: true, touch: false }); stats.removed++; }
        continue;
      }
    }
    if (!ev) continue;
    if (!t.outlook || t.outlook.id !== ev.id) t.outlook = { id: ev.id, remoteMod: null, syncedAt: 0 };
    const remoteChanged = ev.lastModifiedDateTime !== t.outlook.remoteMod;
    const localChanged = t.updatedAt > (t.outlook.syncedAt || 0);
    if (remoteChanged && (!localChanged || Date.parse(ev.lastModifiedDateTime) > t.updatedAt)) {
      if (t.outlook.remoteMod === null && !localChanged) { markSynced(t, ev); continue; }
      applyRemote(t, ev);
      applied.push(t.id);
      stats.pulled++;
    }
  }
  if (applied.length) propagate(applied);

  // 2. Envoi des modifications locales
  for (const t of tasks()) {
    const o = t.outlook;
    try {
      if (o?.id && !t.start) {
        await graph(`/me/events/${o.id}`, { method: 'DELETE' }).catch((e) => { if (e.status !== 404) throw e; });
        t.outlook = null; putTask(t, { silent: true, touch: false }); stats.removed++;
      } else if (t.start && !o?.id) {
        if (tEnd(t) < from) continue; // trop ancienne
        const ev = await graph(`${calBase()}/events`, { method: 'POST', body: payload(t), headers: PREFER });
        markSynced(t, ev); stats.pushed++;
      } else if (o?.id && t.updatedAt > (o.syncedAt || 0)) {
        const ev = await graph(`/me/events/${o.id}`, { method: 'PATCH', body: payload(t), headers: PREFER });
        markSynced(t, ev); stats.pushed++;
      }
    } catch (e) {
      if (e.status === 404 && o?.id) { t.outlook = null; putTask(t, { silent: true, touch: false }); continue; }
      throw e;
    }
  }

  // 3. Tâches supprimées dans l'application
  for (const del of Object.values(db.deleted)) {
    if (!del.outlookId) continue;
    await graph(`/me/events/${del.outlookId}`, { method: 'DELETE' }).catch((e) => { if (e.status !== 404) throw e; });
    del.outlookId = null; stats.removed++;
  }

  save('sync');
  return stats;
}
