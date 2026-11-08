// Application : navigation, réglages, synchronisation automatique, installation.

import { db, onChange, setSettings, local, exportJson, replaceDb, mergeRemote, tasks, newTask, putTask, newProject, putProject, newResource, putResource, save } from './store.js';
import { rollOverdue, propagate } from './sched.js';
import { renderList } from './list.js';
import { renderCalendar, calendarRoute, setCalendarHooks } from './calendar.js';
import { renderGantt } from './gantt.js';
import { renderResources } from './resources.js';
import { openTaskEditor } from './editor.js';
import * as ms from './outlook.js';
import { ghSync, ghStatus, onGhStatus, ghConfigured, ghRepo, ghSetup, ghDisconnect } from './github.js';
import { notifSupported, notifEnabled, enableNotifications, disableNotifications, show, startReminders } from './notify.js';
import { toast, confirmDialog, slider, bindSliders, info } from './ui.js';
import { $, esc, icon, debounce, download, toLocal, toDateStr, addDays, startOfDay, fmt } from './util.js';

const VERSION = '1.4.0';
const TABS = [
  { id: 'taches', label: 'Tâches', icon: 'list', render: renderList },
  { id: 'calendrier', label: 'Calendrier', icon: 'calendar', render: renderCalendar },
  { id: 'gantt', label: 'Gantt', icon: 'gantt', render: renderGantt },
  { id: 'ressources', label: 'Ressources', icon: 'people', render: renderResources },
  { id: 'reglages', label: 'Réglages', icon: 'settings', render: renderSettings },
];

let current = 'taches';
let installEvent = null;

// ---------- Thème ----------
function applyTheme() {
  const t = db.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- Navigation ----------
function route() {
  const [tab, ...rest] = (location.hash.replace(/^#\/?/, '') || 'taches').split('/');
  current = TABS.some((t) => t.id === tab) ? tab : 'taches';
  if (current === 'calendrier') calendarRoute(rest);
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === current));
  render();
}

function render() {
  const main = $('#view');
  const tab = TABS.find((t) => t.id === current);
  document.body.dataset.view = current;
  const y = window.scrollY;
  tab.render(main);
  if (current !== 'taches') window.scrollTo(0, y);
}
let pendingRender = false;
const rerender = debounce(() => {
  // Ne pas effacer une saisie en cours : on attend que le champ perde le focus.
  const a = document.activeElement;
  if (a && a.closest('#view') && a.matches('input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="number"], textarea') && a.value) {
    if (!pendingRender) { pendingRender = true; a.addEventListener('blur', () => { pendingRender = false; render(); }, { once: true }); }
    return;
  }
  render();
}, 60);

function shell() {
  const nav = TABS.map((t) => `<a href="#${t.id}" data-tab="${t.id}">${icon(t.icon, 20)}<span>${t.label}</span></a>`).join('');
  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <a class="brand" href="#taches"><img src="icons/icon.svg" alt="" width="28" height="28"><span>Gestion des plannings</span></a>
      <nav class="tabs" aria-label="Navigation">${nav}</nav>
      <span class="spacer"></span>
      <button class="sync-ind" data-syncnow title="Synchronisation"></button>
    </header>
    <main id="view" tabindex="-1"></main>
    <nav class="bottom-nav" aria-label="Navigation">${nav}</nav>
    <button class="fab" data-add aria-label="Nouvelle tâche">${icon('plus', 26)}</button>`;
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) openTaskEditor();
    if (e.target.closest('[data-syncnow]')) {
      if (ms.isConnected() || ghConfigured()) manualSync(); else location.hash = '#reglages';
    }
  });
  updateSyncIndicator();
}

const syncStatus = () => (ghConfigured() ? ghStatus() : ms.getStatus());

function updateSyncIndicator(s = syncStatus()) {
  const el = document.querySelector('.sync-ind');
  if (!el) return;
  const connected = ms.isConnected() || ghConfigured();
  const last = s.last ? `Dernière synchronisation : ${fmt.time.format(new Date(s.last))}` : '';
  const map = {
    off: [connected ? 'idle' : 'off', connected ? 'Synchronisé' : 'Local', 'Données sur cet appareil uniquement. Activez la synchronisation dans les réglages.'],
    idle: ['idle', 'Synchronisé', last],
    syncing: ['syncing', 'Synchronisation…', s.detail || ''],
    offline: ['offline', 'Hors connexion', 'Les modifications sont enregistrées et seront synchronisées au retour du réseau.'],
    error: ['error', 'Erreur de synchro', s.error || ''],
  }[s.state] || ['off', '', ''];
  el.className = `sync-ind ${map[0]}`;
  el.innerHTML = `${icon('sync', 16)}<span class="hide-sm">${map[1]}</span>`;
  el.title = map[2];
}

async function manualSync() {
  try {
    if (ghConfigured()) {
      const r = await ghSync({ manual: true });
      if (r && !ms.isConnected()) toast(r.pushed ? 'Synchronisé : modifications envoyées sur GitHub.' : 'Synchronisé : tout est à jour.');
    }
    if (ms.isConnected()) {
      const r = await ms.syncAll({ manual: true });
      if (r) toast(`Synchronisé · ${r.pulled} reçue(s) d’Outlook, ${r.pushed} envoyée(s), ${r.removed} retirée(s).`);
    }
  } catch (e) {
    toast(`Synchronisation impossible : ${e.message}`, { tone: 'danger', timeout: 6000 });
  }
}

// Après une modification : GitHub puis Outlook (la synchro GitHub attend 6 s pour regrouper les saisies).
const autoSyncGh = debounce(() => { if (ghConfigured()) ghSync(); }, 6000);
const autoSyncMs = debounce(() => { if (ms.isConnected()) ms.syncAll(); }, 4000);
const autoSync = () => { autoSyncGh(); autoSyncMs(); };

// ---------- Réglages ----------
function renderSettings(el) {
  const S = db.settings;
  const st = ms.getStatus();
  const gs = ghStatus();
  const connected = ms.isConnected();
  const hours = (from, to, v) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map((h) => `<option value="${h}" ${v === h ? 'selected' : ''}>${h} h</option>`).join('');
  const WD = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Jeu'], [5, 'Ven'], [6, 'Sam'], [0, 'Dim']];
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  const H = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const hs = (from, to, k, label) => slider(k, { label, values: H(from, to), labels: H(from, to).map((h) => `${h} h`), value: S[k], ticks: false });
  const rem = [null, 0, 5, 10, 15, 30, 60];
  el.innerHTML = `
    <section class="view settings">
      <h2>Réglages</h2>

      <section class="card set">
        <h3>${icon('user', 18)} Profil ${info('profil')}</h3>
        ${slider('role', { values: ['dirigeant', 'collaborateur'], labels: ['Dirigeant', 'Collaborateur'], value: S.role, ticks: 'labels' })}
      </section>

      <section class="card set">
        <h3>${icon('sun', 18)} Journée</h3>
        <div class="grid3">
          ${hs(5, 12, 'dayStart', 'Début')}
          ${hs(9, 14, 'morningEnd', 'Fin de matinée')}
          ${hs(15, 23, 'dayEnd', 'Fin')}
        </div>
        <div class="field"><span>Jours travaillés</span><div class="weekdays">${WD.map(([v, l]) => `<button type="button" class="wd ${S.workDays.includes(v) ? 'on' : ''}" data-wd="${v}">${l}</button>`).join('')}</div></div>
        <div class="row gap"><label class="switch"><input type="checkbox" data-s="autoShift" ${S.autoShift ? 'checked' : ''}><span></span> Décaler les retards</label>${info('retards')}</div>
        ${slider('reminder', { label: 'Rappel par défaut', values: rem, labels: ['Aucun', 'À l’heure', '5 min', '10 min', '15 min', '30 min', '1 h'], value: S.reminder, ticks: false })}
      </section>

      <section class="card set">
        <h3>${icon('sync', 18)} Téléphone ↔ ordinateur ${info('github')}</h3>
        ${ghConfigured() ? `
          <p class="ok-text">${icon('check', 16)} Synchronisé avec <b>${esc(ghRepo())}</b></p>
          <div class="row wrap gap">
            <button class="btn primary" data-act="ghsync">${icon('sync', 16)} Synchroniser</button>
            <button class="btn ghost" data-act="ghoff">Déconnecter cet appareil</button>
          </div>
          <p class="hint">${gs.last ? `${fmt.dayShort.format(new Date(gs.last))} · ${fmt.time.format(new Date(gs.last))}` : ''}${gs.error ? ` <span class="danger-text">${esc(gs.error)}</span>` : ''}</p>`
        : `
          <label class="field"><span>Dépôt privé des données</span><input type="text" data-ghrepo value="${esc(ghRepo())}" spellcheck="false" autocomplete="off"></label>
          <label class="field"><span>Clé d’accès GitHub</span><input type="password" data-ghtoken placeholder="github_pat_…" spellcheck="false" autocomplete="off"></label>
          <div class="row wrap gap"><button class="btn primary" data-act="ghon">Connecter</button></div>
          ${gs.error ? `<p class="danger-text">${esc(gs.error)}</p>` : ''}
          <details class="howto"><summary>${icon('info', 16)} Créer la clé d’accès</summary>
            <ol>
              <li>Ouvrir <code class="copy" data-copy="https://github.com/settings/personal-access-tokens/new">github.com/settings/personal-access-tokens/new</code></li>
              <li>Nom : <i>Plannings</i>. Expiration : la plus longue possible.</li>
              <li>Repository access : <b>Only select repositories</b> → <b>${esc(ghRepo())}</b>.</li>
              <li>Permissions → Repository → <b>Contents : Read and write</b>.</li>
              <li><b>Generate token</b>, copier la clé (commence par <code>github_pat_</code>) et la coller ici, sur chaque appareil.</li>
            </ol></details>`}
      </section>

      <section class="card set">
        <h3>${icon('sync', 18)} Outlook ${info('outlook')}</h3>
        ${connected ? `
          <p class="ok-text">${icon('check', 16)} <b>${esc(ms.accountLabel())}</b></p>
          <label class="field"><span>Calendrier</span><select data-cal><option value="">Calendrier principal</option></select></label>
          <div class="row wrap gap">
            <button class="btn primary" data-act="sync">${icon('sync', 16)} Synchroniser</button>
            <button class="btn ghost" data-act="logout">Se déconnecter</button>
          </div>
          <p class="hint">${st.last ? `${fmt.dayShort.format(new Date(st.last))} · ${fmt.time.format(new Date(st.last))}` : ''}${st.error ? ` <span class="danger-text">${esc(st.error)}</span>` : ''}</p>`
        : `
          <label class="field"><span>Identifiant d’application (client ID)</span>
            <input type="text" data-clientid value="${esc(ms.clientId())}" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" autocomplete="off"></label>
          <div class="row wrap gap">
            <button class="btn primary" data-act="login" ${window.msal ? '' : 'disabled'}>Se connecter</button>
          </div>
          ${st.error ? `<p class="danger-text">${esc(st.error)}</p>` : ''}
          <details class="howto"><summary>${icon('info', 16)} Obtenir l’identifiant</summary>
            <ol>
              <li><b>portal.azure.com</b> → Microsoft Entra ID → Inscriptions d’applications → Nouvelle.</li>
              <li>Comptes : <b>organisationnels et personnels</b>.</li>
              <li>Redirection <b>SPA</b> : <code class="copy" data-copy="${esc(ms.redirectUri())}">${esc(ms.redirectUri())}</code></li>
              <li>API Graph déléguées : <code>Calendars.ReadWrite</code> <code>Files.ReadWrite.AppFolder</code> <code>User.Read</code></li>
              <li>Copier l’ID d’application ici.</li>
            </ol></details>`}
        <hr>
        <div class="row wrap gap">
          <button class="icon-btn" data-act="export" title="Exporter une sauvegarde (.json)" aria-label="Exporter">${icon('download', 18)}</button>
          <label class="icon-btn" title="Importer une sauvegarde" aria-label="Importer">${icon('upload', 18)}<input type="file" accept="application/json,.json" data-import hidden></label>
          <span class="muted sm">Sauvegarde</span>${info('sauvegarde')}
        </div>
      </section>

      <section class="card set">
        <h3>${icon('bell', 18)} Rappels ${info('rappels')}</h3>
        ${!notifSupported() ? '<p class="muted">Non pris en charge.</p>'
          : `<div class="row gap"><label class="switch"><input type="checkbox" data-notif ${notifEnabled() ? 'checked' : ''}><span></span> Notifications</label>
             ${notifEnabled() ? `<button class="icon-btn xs" data-act="testnotif" title="Tester">${icon('bell', 16)}</button>` : ''}</div>`}
      </section>

      <section class="card set">
        <h3>Apparence</h3>
        ${slider('theme', { values: ['light', 'auto', 'dark'], labels: ['Clair', 'Auto', 'Sombre'], value: S.theme, ticks: 'labels' })}
      </section>

      <section class="card set">
        <h3>Installer ${info('installer')}</h3>
        ${standalone ? `<p class="ok-text">${icon('check', 16)} Installée</p>`
          : installEvent ? `<button class="btn primary" data-act="install">Installer</button>` : '<p class="muted sm">Menu du navigateur → Installer</p>'}
      </section>

      <section class="card set">
        <h3>Données</h3>
        <p class="muted sm">${tasks().length} tâches · ${Object.keys(db.projects).length} projets · ${Object.keys(db.resources).length} ressources · v${VERSION}</p>
        <div class="row wrap gap">
          <button class="btn ghost sm" data-act="demo">Exemple</button>
          <button class="btn ghost sm danger-text" data-act="wipe">${icon('trash', 16)} Tout effacer</button>
        </div>
      </section>
    </section>`;

  const root = el.querySelector('.settings');
  bindSliders(root, (name, v, final) => {
    if (name === 'theme') { if (final) { setSettings({ theme: v }); applyTheme(); } return; }
    if (final && ['dayStart', 'morningEnd', 'dayEnd', 'reminder', 'role'].includes(name)) setSettings({ [name]: v });
  });

  root.addEventListener('change', async (e) => {
    const k = e.target.dataset.s;
    if (k) {
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value === '' ? null : Number(e.target.value);
      setSettings({ [k]: v });
      if (k === 'autoShift' && v) { const m = rollOverdue(); if (m.length) toast(`${m.length} tâche(s) en retard décalée(s).`); }
    }
    if (e.target.matches('[data-notif]')) {
      if (e.target.checked) { const p = await enableNotifications(); if (p !== 'granted') toast('Notifications refusées par le navigateur.'); }
      else disableNotifications();
      render(); return;
    }
    if (e.target.matches('[data-cal]')) { ms.setCalendarId(e.target.value); toast('Calendrier choisi. Synchronisation…'); manualSync(); }
    if (e.target.matches('[data-clientid]')) ms.setClientId(e.target.value);
    if (e.target.matches('[data-import]')) {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const changed = mergeRemote(data);
        toast(changed ? 'Données importées et fusionnées.' : 'Rien de nouveau dans ce fichier.');
      } catch { toast('Fichier illisible.', { tone: 'danger' }); }
    }
  });

  root.addEventListener('click', async (e) => {
    const wd = e.target.closest('[data-wd]');
    if (wd) {
      const v = Number(wd.dataset.wd);
      const set = new Set(db.settings.workDays);
      set.has(v) ? set.delete(v) : set.add(v);
      if (!set.size) return;
      setSettings({ workDays: [...set].sort() });
      return;
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) { navigator.clipboard?.writeText(cp.dataset.copy); toast('Adresse copiée.'); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'login') {
      const v = root.querySelector('[data-clientid]').value.trim();
      if (!/^[0-9a-f-]{36}$/i.test(v)) { toast('L’identifiant doit ressembler à 00000000-0000-0000-0000-000000000000.'); return; }
      ms.setClientId(v);
      try { await ms.initMs(); await ms.login(); } catch (err) { toast(err.message, { tone: 'danger' }); }
    }
    if (act === 'logout') ms.logout();
    if (act === 'sync') manualSync();
    if (act === 'ghsync') manualSync();
    if (act === 'ghoff') { ghDisconnect(); toast('Cet appareil n’est plus synchronisé.'); render(); }
    if (act === 'ghon') {
      const repo = root.querySelector('[data-ghrepo]').value.trim();
      const token = root.querySelector('[data-ghtoken]').value.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Nom du dépôt attendu sous la forme compte/depot.'); return; }
      if (token.length < 20) { toast('Collez la clé d’accès GitHub complète.'); return; }
      ghSetup(repo, token);
      try { await ghSync({ manual: true }); toast('Synchronisation activée : vos données sont sur GitHub.'); }
      catch (err) { toast(err.message, { tone: 'danger', timeout: 7000 }); }
      render();
    }
    if (act === 'export') download(`gestion-plannings-${toDateStr(new Date())}.json`, exportJson());
    if (act === 'notif') { const p = await enableNotifications(); toast(p === 'granted' ? 'Notifications activées.' : 'Notifications refusées par le navigateur.'); render(); }
    if (act === 'nonotif') { disableNotifications(); render(); }
    if (act === 'testnotif') show('Gestion des plannings', 'Les rappels fonctionnent 👍', 'test');
    if (act === 'install' && installEvent) { installEvent.prompt(); await installEvent.userChoice; installEvent = null; render(); }
    if (act === 'demo') { loadDemo(); toast('Exemple chargé : voyez la liste, le calendrier et le Gantt.'); location.hash = '#gantt'; }
    if (act === 'wipe') {
      if (await confirmDialog('Effacer toutes les données de cet appareil ? (Une copie OneDrive éventuelle n’est pas supprimée.)', { ok: 'Tout effacer' })) {
        replaceDb({}); local.set('outlookEvents', []); toast('Données effacées.');
      }
    }
  });

  if (connected) {
    ms.listCalendars().then((cals) => {
      const sel = root.querySelector('[data-cal]');
      if (!sel) return;
      sel.innerHTML = cals.map((c) => `<option value="${c.isDefaultCalendar ? '' : c.id}" ${(c.isDefaultCalendar ? '' : c.id) === ms.calendarId() ? 'selected' : ''}>${esc(c.name)}${c.isDefaultCalendar ? ' (principal)' : ''}</option>`).join('');
    }).catch(() => {});
  }
}

// ---------- Exemple ----------
function loadDemo() {
  const at = (dayOffset, h, m = 0) => { const d = addDays(startOfDay(new Date()), dayOffset); d.setHours(h, m, 0, 0); return toLocal(d); };
  const day = (dayOffset) => toDateStr(addDays(startOfDay(new Date()), dayOffset)) + 'T00:00';
  const date = (dayOffset) => toDateStr(addDays(startOfDay(new Date()), dayOffset));
  const camille = newResource({ name: 'Camille', type: 'personne' }); putResource(camille);
  const yanis = newResource({ name: 'Yanis', type: 'personne' }); putResource(yanis);
  const salle = newResource({ name: 'Salle Mistral', type: 'salle' }); putResource(salle);
  const budget = newResource({ name: 'Budget formation', type: 'budget', capacity: 5000 }); putResource(budget);
  const proj = newProject({ name: 'Session de formation de décembre', deadline: date(24) }); putProject(proj);
  const mk = (p) => { const t = newTask(p); putTask(t, { silent: true }); return t; };
  const a = mk({ title: 'Définir le programme', projectId: proj.id, urgency: 4, importance: 5, energy: 3, allDay: true, start: day(1), end: day(2), assign: [{ id: camille.id, qty: 6 }] });
  const b = mk({ title: 'Réserver la salle et le traiteur', projectId: proj.id, urgency: 3, importance: 3, energy: 2, allDay: true, start: day(3), end: day(3), preds: [{ id: a.id, lag: 0 }], assign: [{ id: salle.id }, { id: budget.id, qty: 1800 }], delegate: yanis.id });
  const c = mk({ title: 'Rédiger les supports', projectId: proj.id, urgency: 3, importance: 5, energy: 1, allDay: true, start: day(3), end: day(9), preds: [{ id: a.id, lag: 0 }], subtasks: [{ id: 's1', title: 'Module 1', done: false }, { id: 's2', title: 'Module 2', done: false }, { id: 's3', title: 'Exercices', done: false }] });
  const d = mk({ title: 'Envoyer les convocations', projectId: proj.id, urgency: 4, importance: 4, energy: 2, allDay: true, start: day(10), end: day(10), preds: [{ id: b.id, lag: 0 }, { id: c.id, lag: 0 }] });
  mk({ title: 'Animer la session', projectId: proj.id, urgency: 5, importance: 5, energy: 4, allDay: true, start: day(17), end: day(18), preds: [{ id: d.id, lag: 5 }], assign: [{ id: camille.id, qty: 14 }, { id: salle.id }, { id: budget.id, qty: 2500 }], due: date(21) });
  mk({ title: 'Relancer les factures impayées', urgency: 4, importance: 2, energy: 1, estimate: 60 });
  mk({ title: 'Point d’équipe hebdomadaire', urgency: 3, importance: 3, energy: 3, estimate: 30, start: at(1, 9), end: at(1, 9, 30), recur: { freq: 'weekly', interval: 1, days: [] } });
  mk({ title: 'Préparer la déclaration de TVA', urgency: 5, importance: 5, energy: 1, estimate: 90, due: date(3) });
  mk({ title: 'Appeler un nouveau client', urgency: 2, importance: 4, energy: 4, estimate: 30, start: at(2, 15), end: at(2, 15, 30) });
  mk({ title: 'Classer les mails', urgency: 2, importance: 1, energy: 2, estimate: 45 });
  propagate(tasks().map((t) => t.id));
  save('demo');
}

// ---------- Démarrage ----------
async function start() {
  applyTheme();
  shell();
  window.addEventListener('hashchange', route);
  window.matchMedia('(max-width: 760px)').addEventListener('change', render);

  onChange((reason) => {
    if (reason === 'settings') applyTheme();
    rerender();
    if (!['sync', 'merge'].includes(reason)) autoSync();
  });
  ms.onStatus(() => { updateSyncIndicator(); if (current === 'reglages') rerender(); });
  onGhStatus(() => { updateSyncIndicator(); if (current === 'reglages') rerender(); });
  setCalendarHooks({ connected: ms.isConnected, sync: manualSync });

  const moved = rollOverdue();
  route();
  if (moved.length) toast(`${moved.length} tâche(s) en retard reportée(s) automatiquement, successeurs compris.`);

  setInterval(() => { if (rollOverdue().length) toast('Des tâches en retard ont été reportées.'); }, 10 * 60 * 1000);
  startReminders();

  // Synchronisation entre appareils (GitHub)
  if (ghConfigured()) ghSync();
  setInterval(() => { if (ghConfigured() && !document.hidden) ghSync(); }, 2 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ghConfigured()) ghSync(); });
  window.addEventListener('online', () => { if (ghConfigured()) ghSync(); });

  // Connexion Microsoft et synchronisation
  const ok = await ms.initMs();
  updateSyncIndicator();
  if (ok) {
    ms.syncAll();
    setInterval(() => ms.syncAll(), 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) ms.syncAll(); });
    window.addEventListener('online', () => ms.syncAll());
  }
  window.addEventListener('offline', () => updateSyncIndicator({ ...syncStatus(), state: 'offline' }));
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (current === 'reglages') render(); });

// Dans l'application Android (Capacitor), les fichiers sont déjà embarqués : pas de service worker.
const isNativeApp = !!window.Capacitor?.isNativePlatform?.();
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !isNativeApp) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker', e));
}

start();
