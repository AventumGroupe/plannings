// Connexion Microsoft 365 / Exchange (MSAL + Microsoft Graph).
// Toutes les données passent par votre boîte Exchange :
//  - tâches avec une heure précise  -> rendez-vous dans l'agenda Outlook ;
//  - autres tâches                   -> liste « Plannings » de Microsoft To Do (Tâches Outlook) ;
//  - projets, ressources, réglages   -> données invisibles attachées à cette liste.
// Chaque élément Exchange porte la fiche complète de la tâche (critères, liens, ressources…),
// ce qui permet au téléphone et à l'ordinateur de partager exactement les mêmes données.
// Les modifications faites directement dans Outlook ou To Do (titre, date, statut) sont reprises.

import { db, tasks, newTask, putTask, save, local, mergeRemote, ENERGY } from './store.js';
import { tEnd, propagate, completeTask } from './sched.js';
import { toLocal, toDateStr, parse, addDays, startOfDay } from './util.js';

const SCOPES = ['User.Read', 'Calendars.ReadWrite', 'Tasks.ReadWrite'];
const PROP = 'String {7d3f1b2a-4c6e-4f8a-9b1d-5e2c3a4b6d8f} Name gpTaskId';
const PROP_DATA = 'String {7d3f1b2a-4c6e-4f8a-9b1d-5e2c3a4b6d8f} Name gpTaskData';
const EXT_TASK = 'com.aventum.plannings.task';
const EXT_META = 'com.aventum.plannings.meta';
const LIST_NAME = 'Plannings';
const CATEGORY = 'Gestion des plannings';
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

// Identifiant de l'application inscrite une fois par l'administrateur Microsoft 365 de l'entreprise.
// Une fois renseigné ici, chaque salarié n'a qu'à se connecter avec son adresse Office 365.
export const BUILTIN_CLIENT_ID = 'cd336ff4-1413-4ef2-bef5-1f8c9b55c254';
export const clientId = () => local.get('msClientId', '') || BUILTIN_CLIENT_ID;
export const hasClientId = () => !!clientId();
export const lastEmail = () => local.get('msEmail', '');
export const setClientId = (v) => local.set('msClientId', (v || '').trim());
export const calendarId = () => local.get('msCalendarId', '');
export const setCalendarId = (v) => local.set('msCalendarId', v || '');
// Dans l'application Android, Microsoft renvoie vers une page relais du site web, qui rebascule vers l'application.
export const NATIVE_REDIRECT = 'https://aventumgroupe.github.io/plannings/auth-android.html';
const isNative = () => !!window.Capacitor?.isNativePlatform?.();
export const redirectUri = () => (isNative() ? NATIVE_REDIRECT : new URL('./', location.href).href);
export const isConnected = () => !!account;
export const needsReauth = () => status.state === 'reauth';
export const useTodo = () => local.get('msTodo', true);
export const useAgenda = () => local.get('msAgenda', true);
export const setUse = (k, v) => local.set({ todo: 'msTodo', agenda: 'msAgenda', flags: 'msFlags' }[k] || 'msAgenda', !!v);
export const useFlags = () => local.get('msFlags', true);
export const accountLabel = () => account ? (account.name ? `${account.name} (${account.username})` : account.username) : '';

class GraphError extends Error {
  constructor(status, msg, code = '', path = '') { super(msg); this.status = status; this.code = code; this.path = path; }
}
let step = '';

// L'annuaire de l'entreprise est déduit du domaine de l'adresse (fonctionne aussi si l'application
// n'est inscrite que pour l'annuaire de l'entreprise).
const PERSONAL = /@(outlook|hotmail|live|msn)\.[a-z.]+$/i;
function authority() {
  const email = lastEmail();
  if (!email) return 'https://login.microsoftonline.com/organizations';
  if (PERSONAL.test(email)) return 'https://login.microsoftonline.com/consumers';
  return `https://login.microsoftonline.com/${email.split('@')[1].toLowerCase()}`;
}

// Banc d'essai : window.__GP_TEST__ = { token, account } remplace la connexion MSAL.
const testHook = () => window.__GP_TEST__ || null;

// ---------- Authentification ----------
const bootAt = Date.now();
const inIframe = window.self !== window.top;

export async function initMs() {
  if (testHook()) { account = testHook().account || { username: 'test@exemple.fr' }; setStatus({ state: 'idle' }); return true; }
  const id = clientId();
  if (!id || !window.msal) { setStatus({ state: 'off' }); return false; }
  try {
    pca = new window.msal.PublicClientApplication({
      auth: { clientId: id, authority: authority(), redirectUri: redirectUri(), navigateToLoginRequestUrl: false },
      cache: { cacheLocation: 'localStorage' },
      system: { iframeHashTimeout: 8000 },
    });
    await pca.initialize();
  } catch (e) {
    console.error(e);
    setStatus({ state: 'error', error: messageOf(e) });
    return false;
  }
  // Un retour de connexion raté ne doit pas faire « oublier » le compte déjà enregistré.
  let r = null;
  try { r = await pca.handleRedirectPromise(); } catch (e) { console.warn('Retour de connexion Microsoft', e); }
  account = r?.account || pca.getActiveAccount() || pca.getAllAccounts()[0] || null;
  if (r?.account) { local.set('msWanted', true); sessionStorage.removeItem('gpReauthTried'); }
  // Compte absent du cache mais connexion souhaitée : reconnexion silencieuse avec l'adresse mémorisée.
  if (!account && local.get('msWanted') && lastEmail()) account = await silentSignIn();
  if (account) { pca.setActiveAccount(account); setStatus({ state: 'idle', error: null }); return true; }
  if (local.get('msWanted') && lastEmail()) { setStatus({ state: 'reauth', error: null }); maybeAutoReconnect(); return false; }
  setStatus({ state: 'off', error: null });
  return false;
}

/** Reconnexion sans fenêtre (utilise la session Microsoft du navigateur). Version web uniquement. */
async function silentSignIn() {
  if (isNative() || inIframe) return null;
  try {
    const res = await pca.ssoSilent({ scopes: SCOPES, loginHint: lastEmail() });
    return res.account;
  } catch (e) { console.warn('Reconnexion silencieuse impossible', e); return null; }
}

/** Au lancement seulement (pour ne pas interrompre une saisie) : reconnexion automatique, une fois. */
function maybeAutoReconnect() {
  if (inIframe || Date.now() - bootAt > 30000) return;
  const tried = Number(sessionStorage.getItem('gpReauthTried') || 0);
  if (Date.now() - tried < 10 * 60 * 1000) return;
  sessionStorage.setItem('gpReauthTried', String(Date.now()));
  reconnect().catch(() => {});
}

/** Reconnexion en un geste (la session Microsoft évite généralement de retaper le mot de passe). */
export async function reconnect() {
  if (!pca) await initMs();
  if (!pca) return;
  await pca.loginRedirect({ scopes: SCOPES, loginHint: lastEmail() || undefined });
}

/** Connexion avec l'adresse Office 365 du salarié (page de connexion Microsoft pré-remplie). */
export async function login(email = '') {
  if (email && email !== lastEmail()) { local.set('msEmail', email); pca = null; } // annuaire propre à l'adresse
  if (!pca) await initMs();
  if (!pca) throw new Error('L’application n’est pas encore inscrite chez Microsoft : voir avec l’administrateur.');
  local.set('msWanted', true);
  await pca.loginRedirect({ scopes: SCOPES, ...(email ? { loginHint: email } : { prompt: 'select_account' }) });
}

export async function logout() {
  if (!pca || !account) return;
  const a = account;
  account = null;
  local.set('msWanted', false);
  setStatus({ state: 'off' });
  await pca.logoutRedirect({ account: a, postLogoutRedirectUri: redirectUri() });
}

async function token() {
  if (testHook()) return testHook().token;
  try {
    const r = await pca.acquireTokenSilent({ scopes: SCOPES, account });
    return r.accessToken;
  } catch (e) {
    if (!(e instanceof window.msal.InteractionRequiredAuthError) && !/no_tokens_found|token_renewal|monitor_window_timeout|login_required/i.test(e.errorCode || '')) throw e;
    // Session Microsoft expirée (environ 24 h pour ce type d'application) : on renouvelle sans rien demander si possible.
    const acc = await silentSignIn();
    if (acc) {
      account = acc; pca.setActiveAccount(acc);
      const r = await pca.acquireTokenSilent({ scopes: SCOPES, account });
      return r.accessToken;
    }
    setStatus({ state: 'reauth' });
    maybeAutoReconnect();
    const err = new Error('Reconnexion Microsoft nécessaire : touchez « Se reconnecter ».');
    err.reauth = true;
    throw err;
  }
}

async function graph(path, { method = 'GET', body, headers = {} } = {}) {
  const url = path.startsWith('http') ? path : GRAPH + path;
  const h = { Authorization: `Bearer ${await token()}`, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.statusText, code = '';
    try { const j = await res.json(); msg = j.error?.message || msg; code = j.error?.code || ''; } catch {}
    throw new GraphError(res.status, msg, code, `${method} ${url.replace(GRAPH, '').split('?')[0].replace(/\/[A-Za-z0-9=_-]{20,}/g, '/…')}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}
const ignore404 = (p) => p.catch((e) => { if (e.status !== 404) throw e; return null; });

async function pages(url, headers) {
  const out = [];
  let guard = 0;
  while (url && guard++ < 50) {
    const r = await graph(url, { headers });
    out.push(...(r.value || []));
    url = r['@odata.nextLink'] || null;
  }
  return out;
}

function messageOf(e) {
  if (!e) return '';
  if (e.status === 401 || e.status === 403) return 'Accès refusé par Microsoft : vérifiez les autorisations de l’application (Calendars.ReadWrite, Tasks.ReadWrite).';
  if (e.errorCode === 'user_cancelled') return 'Connexion annulée.';
  if (!navigator.onLine) return 'Hors connexion : la synchronisation reprendra automatiquement.';
  const where = [step, e.path].filter(Boolean).join(' · ');
  return `${e.message || String(e)}${e.code ? ` [${e.code}]` : ''}${where ? ` — ${where}` : ''}`;
}

export async function listCalendars() {
  const r = await graph('/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=50');
  return (r.value || []).filter((c) => c.canEdit);
}

// ---------- Règle de répartition ----------
/** Une tâche avec une heure précise va dans l'agenda ; les autres vont dans To Do. */
const inAgenda = (t) => useAgenda() && !!t.start && !t.allDay;

/** Fiche transportée dans Exchange (sans les identifiants propres à chaque élément). */
const packTask = (t) => JSON.stringify({ ...t });

// ---------- Synchronisation globale ----------
export function syncAll({ manual = false } = {}) {
  if (!account) return Promise.resolve(false);
  if (!navigator.onLine) { setStatus({ state: 'offline', error: null }); return Promise.resolve(false); }
  if (running) return running;
  running = (async () => {
    setStatus({ state: 'syncing', error: null, detail: 'Exchange…' });
    try {
      const stats = { pulled: 0, pushed: 0, removed: 0 };
      const todoOn = useTodo(), agendaOn = useAgenda();
      step = 'Liste To Do'; const listId = todoOn ? await ensureList() : null;
      const now = new Date();
      const from = addDays(startOfDay(now), -PAST_DAYS);
      const to = addDays(startOfDay(now), FUTURE_DAYS);

      // 1. Lecture : données générales, tâches To Do, rendez-vous
      step = 'Lecture des réglages'; const meta = todoOn ? await readMeta(listId) : null;
      step = 'Lecture des tâches To Do'; const todos = todoOn ? await readTodos(listId) : [];
      step = 'Lecture de l’agenda'; const events = agendaOn ? await readEvents(from, to) : { ours: [], external: [] };

      // 2. Fusion (pour chaque élément, la version la plus récente gagne)
      const remote = { tasks: {}, projects: meta?.projects || {}, resources: meta?.resources || {}, templates: meta?.templates || {}, deleted: meta?.deleted || {}, settings: meta?.settings };
      const keep = (obj) => { if (obj?.id && (!remote.tasks[obj.id] || (obj.updatedAt || 0) > (remote.tasks[obj.id].updatedAt || 0))) remote.tasks[obj.id] = obj; };
      todos.forEach((x) => keep(x.data));
      events.ours.forEach((x) => keep(x.data));
      if (mergeRemote(remote)) stats.pulled++;

      // 3. Modifications faites directement dans To Do / Outlook
      setStatus({ detail: 'To Do…' });
      step = 'Fusion'; if (todoOn) stats.pulled += applyTodoEdits(todos, listId);
      setStatus({ detail: 'Agenda…' });
      if (agendaOn) { stats.pulled += await applyEventEdits(events.ours); local.set('outlookEvents', events.external); }
      else local.set('outlookEvents', []);

      // 4. Envoi
      step = 'Envoi vers l’agenda'; if (agendaOn) stats.pushed += await pushEvents(from, stats);
      else for (const t of tasks()) if (t.outlook?.id) { await ignore404(graph(`/me/events/${t.outlook.id}`, { method: 'DELETE' })); t.outlook = null; putTask(t, { silent: true, touch: false }); stats.removed++; }
      step = 'Envoi vers To Do'; if (todoOn) stats.pushed += await pushTodos(listId, stats);
      step = 'Étapes To Do'; if (todoOn) stats.pulled += await syncAllChecklists(listId, stats);
      step = 'Mails marqués'; if (useFlags()) stats.pulled += await syncFlagged().catch((e) => { console.warn('Mails marqués indisponibles', e); return 0; });
      step = 'Suppressions'; await pushDeleted(stats);
      step = 'Enregistrement des réglages'; if (todoOn) await writeMeta(listId, meta);
      step = '';

      save('sync');
      const t = Date.now();
      local.set('lastSync', t);
      setStatus({ state: 'idle', last: t, detail: '', lastResult: stats });
      return stats;
    } catch (e) {
      console.error(e);
      setStatus(e.reauth ? { state: 'reauth', error: null, detail: '' } : { state: 'error', error: messageOf(e), detail: '' });
      if (manual) throw new Error(messageOf(e));
      return false;
    } finally {
      running = null;
    }
  })();
  return running;
}

// ---------- Mails marqués d'un drapeau -> tâches ----------
const mailTaskId = (todoId) => { let h = 5381; for (let i = 0; i < todoId.length; i++) h = ((h * 33) ^ todoId.charCodeAt(i)) >>> 0; return 'mail-' + h.toString(36) + todoId.length.toString(36); };

async function syncFlagged() {
  let listId = local.get('flagListId');
  if (!listId) {
    const lists = await pages('/me/todo/lists');
    const l = lists.find((x) => x.wellknownListName === 'flaggedEmails');
    if (!l) return 0;
    listId = l.id; local.set('flagListId', listId);
  }
  const base = `/me/todo/lists/${listId}/tasks`;
  let items;
  try { items = await pages(`${base}?$expand=linkedResources`); } catch (e) { if (e.status === 404) { local.set('flagListId', ''); return 0; } items = await pages(base); }
  let n = 0;
  const byTodo = new Map(tasks().filter((t) => t.mail?.todoId).map((t) => [t.mail.todoId, t]));
  for (const it of items) {
    const id = mailTaskId(it.id);
    const t = byTodo.get(it.id) || db.tasks[id];
    const done = it.status === 'completed';
    const link = (it.linkedResources || []).find((r) => r.webUrl)?.webUrl || '';
    if (!t) {
      if (done || db.deleted[id]) continue;
      const high = it.importance === 'high';
      const nt = newTask({
        id, title: it.title || 'Mail à traiter', urgency: high ? 4 : 3, importance: high ? 4 : 3, energy: 3, estimate: 15,
        due: it.dueDateTime?.dateTime ? it.dueDateTime.dateTime.slice(0, 10) : null,
        notes: link ? `Mail : ${link}` : 'Issu d’un mail marqué d’un drapeau dans Outlook.',
        mail: { todoId: it.id, listId, webUrl: link },
      });
      putTask(nt, { silent: true }); n++;
      continue;
    }
    if (done && t.status !== 'done') { t.status = 'done'; t.doneAt = Date.now(); putTask(t, { silent: true }); n++; }
    else if (!done && t.status === 'done' && !t.mail?.closed) {
      // Terminée dans l'application : on retire le drapeau dans Outlook
      await ignore404(graph(`${base}/${it.id}`, { method: 'PATCH', body: { status: 'completed' } }));
      t.mail = { ...t.mail, closed: true }; putTask(t, { silent: true, touch: false });
    }
  }
  return n;
}

// ---------- Liste To Do « Plannings » ----------
async function ensureList() {
  const cached = local.get('todoListId');
  if (cached) {
    const ok = await ignore404(graph(`/me/todo/lists/${cached}`));
    if (ok) return cached;
  }
  const lists = await pages('/me/todo/lists');
  let list = lists.find((l) => l.displayName === LIST_NAME);
  if (!list) list = await graph('/me/todo/lists', { method: 'POST', body: { displayName: LIST_NAME } });
  local.set('todoListId', list.id);
  return list.id;
}

const findExt = (exts, name) => (exts || []).find((e) => e.extensionName === name || String(e.id || '').endsWith(name));

async function readMeta(listId) {
  const exts = await pages(`/me/todo/lists/${listId}/extensions`).catch(() => []);
  const ext = findExt(exts, EXT_META);
  if (!ext?.data) return null;
  try { return JSON.parse(ext.data); } catch { return null; }
}

async function writeMeta(listId) {
  const data = JSON.stringify({ projects: db.projects, resources: db.resources, templates: db.templates || {}, deleted: db.deleted, settings: db.settings });
  if (data === local.get('metaPushed')) return;
  await upsertExt(`/me/todo/lists/${listId}/extensions`, EXT_META, data);
  local.set('metaPushed', data);
}

async function upsertExt(base, name, data) {
  if (local.get('extOff')) return false;
  try {
    try {
      await graph(`${base}/${name}`, { method: 'PATCH', body: { '@odata.type': 'microsoft.graph.openTypeExtension', extensionName: name, data } });
    } catch (e) {
      if (e.status !== 404) throw e;
      await graph(base, { method: 'POST', body: { '@odata.type': 'microsoft.graph.openTypeExtension', extensionName: name, data } });
    }
    return true;
  } catch (e) {
    // Certains comptes refusent les données attachées : on continue sans (titre, date, statut, étapes restent synchronisés).
    if (e.status === 400 || e.status === 403 || e.status === 501) { console.warn('Extensions To Do indisponibles', e); local.set('extOff', true); return false; }
    throw e;
  }
}

async function readTodos(listId) {
  const base = `/me/todo/lists/${listId}/tasks`;
  let items, expanded = true;
  try { items = await pages(`${base}?$expand=extensions`); }
  catch (e) {
    if (e.status !== 400 && e.status !== 501) throw e;
    // Repli : liste simple, puis fiche (extension) de chaque tâche modifiée depuis la dernière lecture
    expanded = false;
    items = await pages(base);
  }
  const out = [];
  for (const it of items) {
    let exts = it.extensions;
    if (!expanded) {
      const known = tasks().find((t) => t.todo?.id === it.id);
      if (known && known.todo.remoteMod === it.lastModifiedDateTime) { out.push({ item: it, data: null }); continue; }
      exts = (await pages(`${base}/${it.id}/extensions`).catch(() => []));
    }
    const ext = findExt(exts, EXT_TASK);
    let data = null;
    try { data = ext?.data ? JSON.parse(ext.data) : null; } catch {}
    out.push({ item: it, data });
  }
  return out;
}

const todoStatus = (t) => (t.status === 'done' ? 'completed' : t.status === 'doing' ? 'inProgress' : 'notStarted');
const fromTodoStatus = (s) => (s === 'completed' ? 'done' : s === 'inProgress' ? 'doing' : 'todo');
const todoImportance = (t) => (t.importance >= 4 ? 'high' : t.importance <= 2 ? 'low' : 'normal');
const todoDue = (t) => t.due || (t.start ? t.start.slice(0, 10) : null);

function todoPayload(t) {
  const p = db.projects[t.projectId];
  const due = todoDue(t);
  const lines = [
    t.notes || '',
    `Urgence ${t.urgency}/5 · Importance ${t.importance}/5 · Énergie : ${ENERGY[t.energy].label}`,
    p ? `Projet : ${p.name}` : '',
    t.subtasks.length ? t.subtasks.map((s) => `${s.done ? '☑' : '☐'} ${s.title}`).join('\n') : '',
    '— Gestion des plannings',
  ].filter(Boolean);
  const body = {
    title: t.title,
    status: todoStatus(t),
    importance: todoImportance(t),
    body: { contentType: 'text', content: lines.join('\n') },
    categories: [CATEGORY],
  };
  if (due) body.dueDateTime = { dateTime: `${due}T00:00:00`, timeZone: TZ };
  if (due && t.reminder != null && t.status !== 'done') {
    const r = parse(due); r.setHours(db.settings.dayStart, 0, 0, 0);
    if (t.reminder >= 1440) r.setDate(r.getDate() - 1);
    body.isReminderOn = true;
    body.reminderDateTime = { dateTime: `${toLocal(r)}:00`, timeZone: TZ };
  } else body.isReminderOn = false;
  return body;
}

/** Reprend les changements faits dans To Do (titre, statut, échéance) et les tâches créées dans To Do. */
function applyTodoEdits(todos, listId) {
  let n = 0;
  for (const { item, data } of todos) {
    let t = data ? db.tasks[data.id] : tasks().find((x) => x.todo?.id === item.id);
    if (!t && data && db.deleted[data.id]) continue;
    if (!t) {
      // Tâche ajoutée directement dans To Do / Outlook : on l'importe.
      if (item.status === 'completed') continue;
      t = newTask({
        title: item.title || '(sans titre)',
        importance: item.importance === 'high' ? 4 : item.importance === 'low' ? 2 : 3,
        due: item.dueDateTime?.dateTime ? item.dueDateTime.dateTime.slice(0, 10) : null,
        notes: item.body?.contentType === 'text' ? item.body.content || '' : '',
      });
      t.todo = { id: item.id, remoteMod: item.lastModifiedDateTime, syncedAt: 0 };
      putTask(t, { silent: true });
      n++;
      continue;
    }
    if (!t.todo || t.todo.id !== item.id) { t.todo = { ...(t.todo || {}), id: item.id, remoteMod: item.lastModifiedDateTime, syncedAt: t.todo?.syncedAt || 0 }; putTask(t, { silent: true, touch: false }); }
    if (item.lastModifiedDateTime === t.todo.remoteMod) continue;
    const remoteNewer = Date.parse(item.lastModifiedDateTime) > (t.updatedAt || 0);
    const due = item.dueDateTime?.dateTime ? item.dueDateTime.dateTime.slice(0, 10) : null;
    const st = fromTodoStatus(item.status);
    const changed = remoteNewer && (item.title !== t.title || st !== t.status || (due || null) !== (todoDue(t) || null));
    t.todo.remoteMod = item.lastModifiedDateTime;
    if (!changed) { putTask(t, { silent: true, touch: false }); continue; }
    if (item.title) t.title = item.title;
    if (due !== todoDue(t)) t.due = due;
    if (st === 'done' && t.status !== 'done') completeTask(t);
    else t.status = st;
    putTask(t, { silent: true }); // updatedAt > syncedAt : la fiche sera renvoyée
    n++;
  }
  return n;
}

async function pushTodos(listId, stats) {
  let n = 0;
  const base = `/me/todo/lists/${listId}/tasks`;
  for (const t of tasks()) {
    const o = t.todo;
    if (t.mail && !o?.id) continue; // tâche issue d'un mail marqué : elle vit déjà dans To Do (« E-mails marqués »)
    try {
      if (inAgenda(t)) {
        if (o?.id) { await ignore404(graph(`${base}/${o.id}`, { method: 'DELETE' })); t.todo = null; putTask(t, { silent: true, touch: false }); stats.removed++; }
        continue;
      }
      if (!o?.id) {
        if (t.status === 'done' && t.doneAt && t.doneAt < Date.now() - 30 * 864e5) continue; // anciennes tâches faites
        const created = await graph(base, { method: 'POST', body: todoPayload(t) });
        t.todo = { ...(o || {}), id: created.id, remoteMod: null, syncedAt: 0 };
        await upsertExt(`${base}/${created.id}/extensions`, EXT_TASK, packTask(t));
        const fresh = await graph(`${base}/${created.id}`);
        t.todo = { ...t.todo, id: created.id, remoteMod: fresh.lastModifiedDateTime, syncedAt: Math.max(Date.now(), t.updatedAt) };
        putTask(t, { silent: true, touch: false });
        n++;
      } else if ((t.updatedAt || 0) > (o.syncedAt || 0)) {
        await upsertExt(`${base}/${o.id}/extensions`, EXT_TASK, packTask(t));
        const upd = await graph(`${base}/${o.id}`, { method: 'PATCH', body: todoPayload(t) });
        t.todo = { ...o, id: o.id, remoteMod: upd.lastModifiedDateTime, syncedAt: Math.max(Date.now(), t.updatedAt) };
        putTask(t, { silent: true, touch: false });
        n++;
      }
    } catch (e) {
      if (e.status === 404 && o?.id) { t.todo = null; putTask(t, { silent: true, touch: false }); continue; } // supprimée dans To Do entre-temps
      throw e;
    }
  }
  return n;
}

// ---------- Étapes To Do (checklistItems) <-> sous-tâches ----------
async function syncAllChecklists(listId, stats) {
  let n = 0;
  const base = `/me/todo/lists/${listId}/tasks`;
  for (const t of tasks()) {
    if (!t.todo?.id || t.status === 'done' || inAgenda(t)) continue;
    try { n += await syncChecklist(t, `${base}/${t.todo.id}/checklistItems`, stats); }
    catch (e) { if (e.status === 404) continue; throw e; }
  }
  return n;
}

async function syncChecklist(t, url, stats) {
  const remote = await pages(url);
  const known = new Set(t.todo.items || []);
  const localNewer = (t.updatedAt || 0) > (t.todo.checkSync || 0);
  let changed = 0;
  const remoteIds = new Set(remote.map((r) => r.id));
  for (const r of remote) {
    const sub = t.subtasks.find((x) => x.todoItem === r.id);
    if (sub) {
      const same = sub.title === r.displayName && !!sub.done === !!r.isChecked;
      if (same) continue;
      if (localNewer) await graph(`${url}/${r.id}`, { method: 'PATCH', body: { displayName: sub.title, isChecked: !!sub.done } });
      else { sub.title = r.displayName; sub.done = !!r.isChecked; if (sub.done && !sub.doneAt) sub.doneAt = Date.now(); changed++; }
    } else if (known.has(r.id)) {
      await ignore404(graph(`${url}/${r.id}`, { method: 'DELETE' })); stats.removed++; // supprimée dans l'application
    } else {
      t.subtasks.push({ id: `td-${r.id.slice(-12)}-${Date.now().toString(36)}`, title: r.displayName, done: !!r.isChecked, spent: 0, todoItem: r.id }); // ajoutée dans To Do
      changed++;
    }
  }
  for (const sub of [...t.subtasks]) {
    if (sub.todoItem && !remoteIds.has(sub.todoItem)) {
      if (known.has(sub.todoItem) && !localNewer) { t.subtasks = t.subtasks.filter((x) => x !== sub); changed++; continue; } // supprimée dans To Do
      sub.todoItem = null;
    }
    if (!sub.todoItem) {
      const c = await graph(url, { method: 'POST', body: { displayName: sub.title || '(sans titre)', isChecked: !!sub.done } });
      sub.todoItem = c.id;
    }
  }
  const now = Date.now();
  t.todo.items = t.subtasks.map((x) => x.todoItem).filter(Boolean);
  t.todo.checkSync = now;
  if (changed) { t.updatedAt = now; t.todo.syncedAt = now; }
  putTask(t, { silent: true, touch: false });
  return changed;
}

// ---------- Agenda Outlook (tâches avec heure) ----------
const calBase = () => (calendarId() ? `/me/calendars/${calendarId()}` : '/me/calendar');
const SELECT = 'id,subject,start,end,isAllDay,lastModifiedDateTime,showAs,location,isCancelled,webLink,categories';
const EXPAND = `singleValueExtendedProperties($filter=id eq '${PROP}' or id eq '${PROP_DATA}')`;
const PREFER = { Prefer: `outlook.timezone="${TZ}"` };
const localStr = (dt) => dt.slice(0, 16);
const prop = (ev, id) => ev.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === id.toLowerCase())?.value || null;

async function readEvents(from, to) {
  const url = `${calBase()}/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$top=250&$select=${SELECT}&$expand=${encodeURIComponent(EXPAND)}`;
  const list = await pages(url, PREFER);
  const ours = [], external = [];
  for (const ev of list) {
    if (ev.isCancelled) continue;
    const id = prop(ev, PROP);
    if (id) {
      let data = null;
      try { data = JSON.parse(prop(ev, PROP_DATA) || 'null'); } catch {}
      ours.push({ ev, id, data });
    } else {
      external.push({
        id: ev.id, subject: ev.subject, start: localStr(ev.start.dateTime), end: localStr(ev.end.dateTime),
        isAllDay: ev.isAllDay, showAs: ev.showAs, location: ev.location?.displayName || '', webLink: ev.webLink,
      });
    }
  }
  return { ours, external };
}

function eventPayload(t) {
  const p = db.projects[t.projectId];
  const end = tEnd(t);
  const lines = [
    t.notes || '',
    `Urgence ${t.urgency}/5 · Importance ${t.importance}/5 · Énergie : ${ENERGY[t.energy].label}`,
    p ? `Projet : ${p.name}` : '',
    t.subtasks.length ? t.subtasks.map((s) => `${s.done ? '☑' : '☐'} ${s.title}`).join('\n') : '',
    '— Gestion des plannings',
  ].filter(Boolean);
  return {
    subject: (t.status === 'done' ? '✓ ' : '') + t.title,
    body: { contentType: 'text', content: lines.join('\n') },
    start: { dateTime: `${t.start}:00`, timeZone: TZ },
    end: { dateTime: `${toLocal(end)}:00`, timeZone: TZ },
    isAllDay: false,
    isReminderOn: t.reminder != null && t.status !== 'done',
    reminderMinutesBeforeStart: t.reminder ?? 15,
    showAs: t.status === 'done' ? 'free' : 'busy',
    categories: [CATEGORY],
    singleValueExtendedProperties: [{ id: PROP, value: t.id }, { id: PROP_DATA, value: packTask(t) }],
  };
}

function applyRemoteEvent(t, ev) {
  const subj = (ev.subject || '').replace(/^✓\s*/, '').trim();
  if (subj) t.title = subj;
  const s = localStr(ev.start.dateTime), e = localStr(ev.end.dateTime);
  if (ev.isAllDay) {
    t.allDay = true;
    t.start = `${s.slice(0, 10)}T00:00`;
    const last = addDays(parse(e), -1);
    t.end = `${toDateStr(last < parse(s) ? parse(s) : last)}T00:00`;
  } else {
    t.allDay = false;
    t.start = s; t.end = e;
    t.estimate = Math.max(15, Math.round((parse(e) - parse(s)) / 60000));
  }
  t.updatedAt = Date.now();
  // syncedAt reste ancien : la fiche complète sera réécrite dans l'événement (ou passée dans To Do si journée entière)
  t.outlook = { id: ev.id, remoteMod: ev.lastModifiedDateTime, syncedAt: t.outlook?.syncedAt || 0 };
  putTask(t, { silent: true, touch: false });
}

async function applyEventEdits(ours) {
  let n = 0;
  const applied = [];
  const seen = new Set();
  for (const { ev, id, data } of ours) {
    seen.add(id);
    let t = db.tasks[id];
    if (!t) {
      if (db.deleted[id]) continue;
      // Événement créé par un autre appareil sans fiche lisible : on recrée la tâche
      t = newTask(data ? { ...data } : { id, title: ev.subject || '(sans titre)' });
      t.id = id;
      putTask(t, { silent: true, touch: false });
    }
    if (!t.outlook || t.outlook.id !== ev.id) { t.outlook = { id: ev.id, remoteMod: ev.lastModifiedDateTime, syncedAt: t.outlook?.syncedAt || 0 }; putTask(t, { silent: true, touch: false }); continue; }
    if (ev.lastModifiedDateTime === t.outlook.remoteMod) continue;
    const localChanged = (t.updatedAt || 0) > (t.outlook.syncedAt || 0);
    if (!localChanged || Date.parse(ev.lastModifiedDateTime) > t.updatedAt) {
      const before = `${t.title}|${t.start}|${t.end}|${t.allDay}`;
      const subj = (ev.subject || '').replace(/^✓\s*/, '').trim();
      const after = `${subj || t.title}|${ev.isAllDay ? '' : localStr(ev.start.dateTime)}|${ev.isAllDay ? '' : localStr(ev.end.dateTime)}|${!!ev.isAllDay}`;
      if (before !== after) { applyRemoteEvent(t, ev); applied.push(t.id); n++; }
      else { t.outlook.remoteMod = ev.lastModifiedDateTime; putTask(t, { silent: true, touch: false }); }
    }
  }
  // Rendez-vous supprimés dans Outlook
  for (const t of tasks()) {
    if (!t.outlook?.id || seen.has(t.id) || !inAgenda(t)) continue;
    const ev = await ignore404(graph(`/me/events/${t.outlook.id}?$select=id,isCancelled`, { headers: PREFER }));
    if (ev && !ev.isCancelled) continue; // hors de la période lue
    const localChanged = (t.updatedAt || 0) > (t.outlook.syncedAt || 0);
    if (localChanged) { t.outlook = null; putTask(t, { silent: true, touch: false }); } // sera recréé
    else { t.start = null; t.end = null; t.outlook = null; putTask(t, { silent: true }); n++; } // retourne dans To Do
  }
  if (applied.length) propagate(applied);
  return n;
}

async function pushEvents(from, stats) {
  let n = 0;
  for (const t of tasks()) {
    const o = t.outlook;
    try {
      if (o?.id && !inAgenda(t)) {
        await ignore404(graph(`/me/events/${o.id}`, { method: 'DELETE' }));
        t.outlook = null; putTask(t, { silent: true, touch: false }); stats.removed++;
      } else if (inAgenda(t) && !o?.id) {
        if (tEnd(t) < from) continue;
        const ev = await graph(`${calBase()}/events`, { method: 'POST', body: eventPayload(t), headers: PREFER });
        t.outlook = { id: ev.id, remoteMod: ev.lastModifiedDateTime, syncedAt: Math.max(Date.now(), t.updatedAt) };
        putTask(t, { silent: true, touch: false }); n++;
      } else if (inAgenda(t) && o?.id && (t.updatedAt || 0) > (o.syncedAt || 0)) {
        const ev = await graph(`/me/events/${o.id}`, { method: 'PATCH', body: eventPayload(t), headers: PREFER });
        t.outlook = { id: ev.id, remoteMod: ev.lastModifiedDateTime, syncedAt: Math.max(Date.now(), t.updatedAt) };
        putTask(t, { silent: true, touch: false }); n++;
      }
    } catch (e) {
      if (e.status === 404 && o?.id) { t.outlook = null; putTask(t, { silent: true, touch: false }); continue; }
      throw e;
    }
  }
  return n;
}

// ---------- Tâches supprimées dans l'application ----------
async function pushDeleted(stats) {
  const listId = local.get('todoListId');
  for (const del of Object.values(db.deleted)) {
    if (del.outlookId) { await ignore404(graph(`/me/events/${del.outlookId}`, { method: 'DELETE' })); del.outlookId = null; stats.removed++; }
    if (del.todoId && listId) { await ignore404(graph(`/me/todo/lists/${listId}/tasks/${del.todoId}`, { method: 'DELETE' })); del.todoId = null; stats.removed++; }
  }
}

