// Application : navigation, réglages, synchronisation automatique, installation.

import { db, decisionsFor, onChange, setSettings, local, exportJson, replaceDb, mergeRemote, tasks, newTask, putTask, newProject, putProject, newResource, putResource, save } from './store.js';
import { rollOverdue, propagate } from './sched.js';
import { renderList } from './list.js';
import { renderMatrix } from './matrix.js';
import { renderToday } from './today.js';
import { renderDecision, toDecideCount } from './decision.js';
import { rhSync, rhConfigured, rhInfo, rhLink, setRhLink, parseLink } from './rh.js';
import { resumeFocus } from './focus.js';
import { renderCalendar, calendarRoute, setCalendarHooks } from './calendar.js';
import { renderGantt } from './gantt.js';
import { renderResources } from './resources.js';
import { openTaskEditor } from './editor.js';
import * as ms from './outlook.js';
import { ghSync, ghStatus, onGhStatus, ghConfigured, ghRepo, ghSetup, ghDisconnect } from './github.js';
import { notifSupported, notifEnabled, enableNotifications, disableNotifications, show, startReminders, refreshNative, isNativeNotif } from './notify.js';
import { toast, confirmDialog, slider, bindSliders, info, INFO } from './ui.js';
import { sourcesHtml } from './advice.js';
INFO.sources = sourcesHtml();
INFO.rythme = 'Plombante : séances courtes (25 min par défaut) avec 5 min de pause, 2 à 3 d’affilée au plus. Stimulante ou dynamisante : séances de 50 min, prolongeables jusqu’à 90 min si l’on est bien lancé. Au-delà d’environ 4 h de travail concentré par jour, l’attention chute.';
import { $, esc, icon, debounce, download, toLocal, toDateStr, addDays, startOfDay, fmt } from './util.js';

const VERSION = '3.1.0';
const TABS = [
  { id: 'journee', label: 'Journée', icon: 'today', render: renderToday, main: true },
  { id: 'decision', label: 'Décision', icon: 'bulb', render: renderDecision, main: true },
  { id: 'liste', label: 'Liste', icon: 'list', render: renderList, main: true },
  { id: 'matrice', label: 'Matrice', icon: 'grid', render: renderMatrix },
  { id: 'calendrier', label: 'Calendrier', icon: 'calendar', render: renderCalendar, main: true },
  { id: 'gantt', label: 'Gantt', icon: 'gantt', render: renderGantt },
  { id: 'ressources', label: 'Ressources', icon: 'people', render: renderResources },
  { id: 'reglages', label: 'Réglages', icon: 'settings', render: renderSettings },
];

let current = 'journee';
let installEvent = null;

// ---------- Thème ----------
function applyTheme() {
  const t = db.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- Navigation ----------
function route() {
  let [tab, ...rest] = (location.hash.replace(/^#\/?/, '') || 'journee').split('/');
  if (tab === 'taches') tab = 'liste'; // ancien nom
  current = TABS.some((t) => t.id === tab) ? tab : 'journee';
  if (current === 'calendrier') calendarRoute(rest);
  if (current === 'journee' && rest[0] === 'revue') { history.replaceState(null, '', '#journee'); import('./review.js').then((m) => m.openReview()); }
  const focusSync = current === 'reglages' && rest[0] === 'sync';
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === current));
  document.querySelector('[data-more-nav]')?.classList.toggle('on', !TABS.find((t) => t.id === current)?.main);
  render();
  if (focusSync) setTimeout(() => document.querySelector('[data-sync-card]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

function render() {
  const main = $('#view');
  const tab = TABS.find((t) => t.id === current);
  document.body.dataset.view = current;
  const y = window.scrollY;
  tab.render(main);
  window.scrollTo(0, y);
  updateBadges();
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
  const link = (t) => `<a href="#${t.id}" data-tab="${t.id}">${icon(t.icon, 20)}<span>${t.label}</span>${t.id === 'decision' ? '<i class="nav-badge" data-badge-decision hidden></i>' : ''}</a>`;
  const nav = TABS.map(link).join('');
  // Téléphone : 4 onglets principaux + « Plus »
  const bottom = TABS.filter((t) => t.main).map(link).join('') + `<button class="more-btn" data-more-nav aria-label="Plus">${icon('more', 20)}<span>Plus</span></button>`;
  const moreMenu = `<div class="more-menu" data-more-menu hidden>${TABS.filter((t) => !t.main).map(link).join('')}</div>`;
  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <a class="brand" href="#journee"><img src="icons/icon.svg" alt="" width="28" height="28"><span>Gestion des plannings</span></a>
      <nav class="tabs" aria-label="Navigation">${nav}</nav>
      <span class="spacer"></span>
      <button class="icon-btn as-btn" data-assistant title="Assistant" aria-label="Assistant">${icon('spark', 20)}</button>
      <button class="sync-ind" data-syncnow title="Synchronisation"></button>
    </header>
    <main id="view" tabindex="-1"></main>
    <nav class="bottom-nav" aria-label="Navigation">${bottom}</nav>${moreMenu}
    <button class="fab" data-add aria-label="Nouvelle tâche">${icon('plus', 26)}</button>`;
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) openTaskEditor();
    const mm = document.querySelector('[data-more-menu]');
    if (e.target.closest('[data-more-nav]')) { mm.hidden = !mm.hidden; return; }
    if (mm && !mm.hidden && !e.target.closest('[data-more-menu]')) mm.hidden = true;
    if (e.target.closest('[data-more-menu] a')) mm.hidden = true;
    if (e.target.closest('[data-assistant]')) import('./assistant.js').then((m) => m.openAssistant());
    if (e.target.closest('[data-syncnow]')) {
      if (ms.needsReauth()) ms.reconnect(); else if (ms.isConnected() || ghConfigured()) manualSync(); else location.hash = '#reglages/sync';
    }
  });
  updateSyncIndicator();
}

/** Pastille du nombre de tâches à trancher sur l'onglet Décision. */
function updateBadges() {
  const n = toDecideCount();
  document.querySelectorAll('[data-badge-decision]').forEach((b) => { b.hidden = !n; b.textContent = n > 99 ? '99+' : n; });
}

const syncStatus = () => (ms.isConnected() || ms.needsReauth() || !ghConfigured() ? ms.getStatus() : ghStatus());

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
    reauth: ['offline', 'Reconnexion', 'La session Microsoft a expiré : touchez pour vous reconnecter.'],
  }[s.state] || ['off', '', ''];
  el.className = `sync-ind ${map[0]}`;
  el.innerHTML = `${icon('sync', 16)}<span class="hide-sm">${map[1]}</span>`;
  el.title = map[2];
}

async function manualSync() {
  try {
    if (ghConfigured()) {
      const r = await ghSync({ manual: true });
      if (r && !ms.isConnected()) toast(r.pushed ? 'Synchronisé : modifications enregistrées.' : 'Synchronisé : tout est à jour.');
    }
    if (ms.isConnected()) {
      const r = await ms.syncAll({ manual: true });
      if (r) toast(`Synchronisé avec Exchange · ${r.pulled} reçue(s), ${r.pushed} envoyée(s), ${r.removed} retirée(s).`);
    }
  } catch (e) {
    toast(`Synchronisation impossible : ${e.message}`, { tone: 'danger', timeout: 6000 });
  }
}

// Après une modification : synchronisation (regroupe les saisies rapprochées).
const autoSyncGh = debounce(() => { if (ghConfigured()) ghSync(); }, 5000);
const autoSyncMs = debounce(() => { if (ms.isConnected()) ms.syncAll(); }, 5000);
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
      <header class="set-top"><h2>Réglages</h2><span class="badge accent">Version ${VERSION}</span></header>

      <section class="card set">
        <h3>${icon('user', 18)} Profil ${info('profil')}</h3>
        ${slider('role', { values: ['dirigeant', 'collaborateur'], labels: ['Dirigeant', 'Collaborateur'], value: S.role, ticks: 'labels' })}
      </section>

      <section class="card set">
        <h3>${icon('repeat', 18)} Rythme de travail ${info('rythme')} ${info('sources')}</h3>
        <div class="grid3">
          ${slider('sessionPlomb', { label: 'Séance plombante', values: [15, 20, 25, 30, 45], labels: ['15 min', '20 min', '25 min', '30 min', '45 min'], value: S.sessionPlomb ?? 25, ticks: false })}
          ${slider('sessionDyn', { label: 'Séance dynamisante', values: [25, 45, 50, 60, 90], labels: ['25 min', '45 min', '50 min', '60 min', '90 min'], value: S.sessionDyn ?? 50, ticks: false })}
          ${slider('breakMin', { label: 'Pause', values: [3, 5, 10, 15], labels: ['3 min', '5 min', '10 min', '15 min'], value: S.breakMin ?? 5, ticks: false })}
        </div>
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
        <h3 data-sync-card>${icon('sync', 18)} Téléphone ↔ ordinateur ${info('github')}</h3>
        ${ghConfigured() ? `
          <p class="ok-text">${icon('check', 16)} Données partagées via <b>${esc(ghRepo())}</b></p>
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
        <h3>${icon('sync', 18)} Microsoft 365 (Exchange) ${info('outlook')}</h3>
        ${ms.needsReauth() ? `
          <p class="warn-text">${icon('alert', 16)} Session Microsoft expirée pour <b>${esc(ms.lastEmail())}</b> : vos réglages sont conservés, il suffit de vous reconnecter.</p>
          <div class="row wrap gap"><button class="btn primary" data-act="reauth">Se reconnecter</button><button class="btn ghost" data-act="logout">Changer de compte</button></div>` : ''}
        ${!ms.needsReauth() && connected ? `
          <p class="ok-text">${icon('check', 16)} <b>${esc(ms.accountLabel())}</b></p>
          <div class="row wrap gap">
            <label class="switch"><input type="checkbox" data-mstodo ${ms.useTodo() ? 'checked' : ''}><span></span> Microsoft To Do</label>
            <label class="switch"><input type="checkbox" data-msagenda ${ms.useAgenda() ? 'checked' : ''}><span></span> Lire l’agenda Outlook</label>
            <label class="switch"><input type="checkbox" data-msflags ${ms.useFlags() ? 'checked' : ''}><span></span> Mails marqués ${icon('alert', 14)}</label>
            ${info('', 'Microsoft To Do : toutes vos tâches vont dans la liste « Plannings » (titre, échéance, statut, importance, rappel) et leurs sous-tâches deviennent des « étapes » To Do, dans les deux sens. Agenda Outlook : vos rendez-vous sont lus (calendrier 360, créneaux libres) ; Plannings n’y crée plus rien. Mails marqués : chaque mail marqué d’un drapeau dans Outlook devient une tâche (15 min, à trier) ; la cocher dans l’application retire le drapeau.')}
          </div>
          ${ms.useFlags() ? `<div class="row wrap gap mail-filter">
            <label class="switch"><input type="checkbox" data-msfilter ${ms.useMailFilter() ? 'checked' : ''}><span></span> Seulement les mails qui appellent une réponse</label>
            ${info('', 'Les mails promotionnels (lettres d’information, offres, webinaires…) et automatiques (commandes, factures, codes, notifications…) ne deviennent pas des tâches. Ils restent marqués dans Outlook. Si le tri se trompe, ouvrez la liste ci-dessous et faites-en une tâche.')}
          </div>
          ${ms.useMailFilter() && ms.mailIgnored().length ? `<details class="mail-ignored"><summary>${ms.mailIgnored().length} mail(s) écarté(s) par le tri</summary>
            <ul>${ms.mailIgnored().slice().reverse().map((m) => `<li><span><b>${esc(m.title)}</b><small>${esc(m.reason)}</small></span><button class="btn sm ghost" data-keepmail="${esc(m.todoId)}">En faire une tâche</button></li>`).join('')}</ul></details>` : ''}` : ''}
          <label class="field" ${ms.useAgenda() ? '' : 'hidden'}><span>Calendrier</span><select data-cal><option value="">Calendrier principal</option></select></label>
          <div class="row wrap gap">
            <button class="btn primary" data-act="sync">${icon('sync', 16)} Synchroniser</button>
            <button class="btn ghost" data-act="logout">Se déconnecter</button>
          </div>
          <p class="hint">${st.last ? `${fmt.dayShort.format(new Date(st.last))} · ${fmt.time.format(new Date(st.last))}` : ''}${st.error ? ` <span class="danger-text">${esc(st.error)}</span>` : ''}</p>`
        : ms.needsReauth() ? '' : `
          <label class="field"><span>Votre adresse e-mail Office 365</span>
            <input type="email" data-msemail value="${esc(ms.lastEmail())}" placeholder="prenom.nom@entreprise.fr" autocomplete="email" inputmode="email"></label>
          <div class="row wrap gap">
            <button class="btn primary" data-act="login" ${window.msal && ms.hasClientId() ? '' : 'disabled'}>Se connecter avec Microsoft</button>
          </div>
          <p class="hint">Chaque salarié se connecte avec sa propre adresse : ses tâches vont dans son agenda Outlook et dans sa liste « Plannings » de To Do.</p>
          ${!ms.hasClientId() ? `<p class="warn-text">${icon('alert', 15)} L’application doit d’abord être inscrite une fois par l’administrateur Microsoft 365 de l’entreprise.</p>` : ''}
          ${st.error ? `<p class="danger-text">${esc(st.error)}</p>` : ''}
          <details class="howto"><summary>${icon('info', 16)} Administrateur : inscription de l’application (une seule fois)</summary>
            <ol>
              <li><b>entra.microsoft.com</b> → Applications → Inscriptions d’applications → Nouvelle inscription, nom <i>Plannings</i>.</li>
              <li>Comptes : <b>cet annuaire uniquement</b> (salariés de l’entreprise) ou <b>organisationnels et personnels</b>.</li>
              <li>Plateforme <b>Application monopage (SPA)</b>, deux URI de redirection : <code class="copy" data-copy="https://aventumgroupe.github.io/plannings/">https://aventumgroupe.github.io/plannings/</code> et <code class="copy" data-copy="https://aventumgroupe.github.io/plannings/auth-android.html">https://aventumgroupe.github.io/plannings/auth-android.html</code> (application Android).</li>
              <li>Autorisations Microsoft Graph (déléguées) : <code>Calendars.ReadWrite</code> <code>Tasks.ReadWrite</code> <code>User.Read</code>, puis « Accorder un consentement d’administrateur ».</li>
              <li>Transmettre l’<b>ID d’application (client)</b> pour qu’il soit intégré à l’application, ou le coller ci-dessous en attendant.</li>
            </ol>
            <label class="field"><span>ID d’application (client)</span>
              <input type="text" data-clientid value="${esc(local.get('msClientId', ''))}" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" autocomplete="off"></label>
          </details>`}
      </section>

      <section class="card set" data-rh-card>
        <h3>${icon('people', 18)} Plateforme RH (congés et absences) ${info('', 'Collez votre lien « Mon agenda » de la plateforme RH Aventum. Plannings lit alors vos congés et absences (et ceux de l’équipe pour le gérant) : ces jours ne reçoivent plus de propositions, et une alerte prévient si vous déléguez à quelqu’un d’absent. Le même lien active l’assistant. Il reste sur cet appareil ; régénérez-le dans la plateforme pour couper l’accès.')}</h3>
        ${rhConfigured() ? `<p class="${rhInfo()?.error ? 'warn-text' : 'ok-text'}">${icon(rhInfo()?.error ? 'alert' : 'check', 16)} ${rhInfo()?.error ? esc(rhInfo().error) : `Reliée${rhInfo()?.nom ? ` : <b>${esc(rhInfo().nom)}</b>` : ''}${rhInfo()?.at ? ` · ${fmt.time.format(new Date(rhInfo().at))}` : ''}`}</p>` : '<p class="muted sm">Plateforme RH › Mon agenda › créer mon lien, puis copiez-le ici.</p>'}
        <div class="row gap-sm wrap">
          <input type="url" data-rhlink placeholder="https://…/agenda/….ics" value="${esc(rhLink())}" style="flex:1 1 260px" aria-label="Lien Mon agenda">
          ${rhConfigured() ? `<button class="btn ghost sm" data-act="rhsync">${icon('sync', 16)} Actualiser</button><a class="btn ghost sm" href="${esc(parseLink(rhLink()).base)}/mon-agenda" target="_blank" rel="noopener">Ouvrir</a>` : ''}
        </div>
      </section>

      <section class="card set">
        <h3>${icon('bell', 18)} Rappels ${info('rappels')}</h3>
        ${!notifSupported() ? '<p class="muted">Non pris en charge.</p>'
          : `<div class="row gap"><label class="switch"><input type="checkbox" data-notif ${notifEnabled() ? 'checked' : ''}><span></span> Notifications</label>
             ${notifEnabled() ? `<button class="icon-btn xs" data-act="testnotif" title="Tester">${icon('bell', 16)}</button>` : ''}</div>
             <p class="muted sm">${isNativeNotif() ? 'Notifications Android : rappels, résumé du matin, relances de délégation, revue du lundi et fin de séance, même application fermée.' : 'Sur le web, les rappels s’affichent tant que la page est ouverte. Pour les recevoir application fermée, utilisez l’application Android.'}</p>`}
      </section>

      <section class="card set">
        <h3>Apparence</h3>
        ${slider('theme', { values: ['light', 'auto', 'dark'], labels: ['Clair', 'Auto', 'Sombre'], value: S.theme, ticks: 'labels' })}
      </section>

      ${standalone ? '' : `<section class="card set install-card">
        <h3>${icon('download', 18)} Installer sur cet ordinateur ${info('installer')}</h3>
        <p class="muted sm">Plannings s’ouvre alors dans sa propre fenêtre, avec une icône sur le bureau et dans la barre des tâches, et fonctionne hors connexion.</p>
        ${installEvent ? `<button class="btn primary" data-act="install">${icon('download', 16)} Installer l’application</button>` : '<p class="sm">Chrome ou Edge : cliquez sur l’icône <b>Installer</b> à droite de la barre d’adresse (ou menu ⋮ → « Installer Gestion des plannings »).</p>'}
      </section>`}

      <details class="card set adv-set">
        <summary><h3>Avancé</h3><span class="muted sm">Sauvegarde, restauration, données</span></summary>
        <p class="muted sm">${tasks().length} tâches · ${Object.keys(db.projects).length} projets · ${Object.keys(db.resources).length} ressources · version ${VERSION}</p>
        <div class="row wrap gap">
          <button class="btn sm" data-act="export">${icon('download', 16)} Sauvegarder (.json)</button>
          <label class="btn sm">${icon('upload', 16)} Restaurer<input type="file" accept="application/json,.json" data-import hidden></label>
          ${info('sauvegarde')}
        </div>
        <hr>
        <div class="row wrap gap">
          <button class="btn ghost sm" data-act="demo">Charger des données d’exemple</button>
          <button class="btn ghost sm danger-text" data-act="wipe">${icon('trash', 16)} Tout effacer sur cet appareil</button>
        </div>
      </details>
    </section>`;

  const root = el.querySelector('.settings');
  bindSliders(root, (name, v, final) => {
    if (name === 'theme') { if (final) { setSettings({ theme: v }); applyTheme(); } return; }
    if (final && ['dayStart', 'morningEnd', 'dayEnd', 'reminder', 'role', 'sessionPlomb', 'sessionDyn', 'breakMin'].includes(name)) setSettings({ [name]: v });
  });

  root.addEventListener('change', async (e) => {
    const k = e.target.dataset.s;
    if (k) {
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value === '' ? null : Number(e.target.value);
      setSettings({ [k]: v });
      if (k === 'autoShift' && v) { const m = rollOverdue(); if (m.length) toast(`${m.length} tâche(s) en retard décalée(s).`); }
    }
    if (e.target.matches('[data-notif]')) {
      if (e.target.checked) { const p = await enableNotifications(); if (p !== 'granted') toast('Notifications refusées.'); }
      else disableNotifications();
      render(); return;
    }
    if (e.target.matches('[data-mstodo]') || e.target.matches('[data-msagenda]') || e.target.matches('[data-msflags]')) {
      ms.setUse(e.target.matches('[data-mstodo]') ? 'todo' : e.target.matches('[data-msflags]') ? 'flags' : 'agenda', e.target.checked);
      render(); manualSync(); return;
    }
    if (e.target.matches('[data-msfilter]')) { local.set('msMailFilter', e.target.checked); render(); manualSync(); return; }
    if (e.target.matches('[data-rhlink]')) {
      const v = e.target.value.trim();
      if (v && !parseLink(v)) { toast('Lien attendu : https://…/agenda/<code>.ics (Plateforme RH › Mon agenda).'); return; }
      const ok = await setRhLink(v); render();
      toast(!v ? 'Plateforme RH déliée.' : ok ? 'Plateforme RH reliée : congés et absences chargés.' : `Lien enregistré, mais : ${rhInfo()?.error || 'lecture impossible'}`);
      return;
    }
    if (e.target.matches('[data-cal]')) { ms.setCalendarId(e.target.value); toast('Calendrier choisi. Synchronisation…'); manualSync(); }
    if (e.target.matches('[data-clientid]')) { const v = e.target.value.trim(); if (v && !/^[0-9a-f-]{36}$/i.test(v)) { toast('Format attendu : 00000000-0000-0000-0000-000000000000.'); return; } ms.setClientId(v); render(); }
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
    const km = e.target.closest('[data-keepmail]');
    if (km) { const t = ms.keepIgnoredMail(km.dataset.keepmail); if (t) toast(`Tâche « ${t.title} » créée.`); render(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'login') {
      const email = root.querySelector('[data-msemail]').value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Saisissez votre adresse e-mail Office 365.'); return; }
      try { await ms.initMs(); await ms.login(email); } catch (err) { toast(err.message, { tone: 'danger' }); }
    }
    if (act === 'logout') ms.logout();
    if (act === 'reauth') ms.reconnect();
    if (act === 'sync') manualSync();
    if (act === 'ghsync') manualSync();
    if (act === 'ghoff') { ghDisconnect(); toast('Cet appareil n’est plus synchronisé.'); render(); }
    if (act === 'ghon') {
      const repo = root.querySelector('[data-ghrepo]').value.trim();
      const token = root.querySelector('[data-ghtoken]').value.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Nom du dépôt attendu sous la forme compte/depot.'); return; }
      if (token.length < 20) { toast('Collez la clé d’accès GitHub complète.'); return; }
      ghSetup(repo, token);
      try { await ghSync({ manual: true }); toast('Synchronisation activée : vos données sont partagées.'); }
      catch (err) { toast(err.message, { tone: 'danger', timeout: 7000 }); }
      render();
    }

    if (act === 'export') download(`gestion-plannings-${toDateStr(new Date())}.json`, exportJson());
    if (act === 'notif') { const p = await enableNotifications(); toast(p === 'granted' ? 'Notifications activées.' : 'Notifications refusées.'); render(); }
    if (act === 'nonotif') { disableNotifications(); render(); }
    if (act === 'rhsync') { const ok = await rhSync(true); render(); toast(ok ? 'Congés et absences actualisés.' : `Plateforme RH : ${rhInfo()?.error || 'lecture impossible'}`); }
    if (act === 'testnotif') show('Gestion des plannings', 'Les rappels fonctionnent 👍', 'test');
    if (act === 'install' && installEvent) { installEvent.prompt(); await installEvent.userChoice; installEvent = null; render(); }
    if (act === 'demo') { loadDemo(); toast('Exemple chargé : la moitié des tâches attend votre décision.'); location.hash = '#decision'; }
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
  // v3 : motivations d'exemple, et la moitié des tâches déjà tranchées (le reste dans l'onglet Décision)
  tasks().forEach((t, i) => { t.motivation = [3, 2, 4, 1, 3, 4, 2, 3][i % 8]; if (i % 2 === 0) t.decision = { key: decisionsFor(t)[0], at: Date.now() }; });
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
    refreshNative();
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
  resumeFocus();
  rhSync(true).then((ok) => { if (ok) rerender(); });
  setInterval(() => { if (!document.hidden) rhSync().then((ok) => { if (ok) rerender(); }); }, 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rhSync().then((ok) => { if (ok) rerender(); }); });

  // Synchronisation provisoire entre appareils (dépôt GitHub privé)
  if (ghConfigured()) ghSync();
  setInterval(() => { if (ghConfigured() && !document.hidden) ghSync(); }, 2 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ghConfigured()) ghSync(); });
  window.addEventListener('online', () => { if (ghConfigured()) ghSync(); });

  // Connexion Microsoft et synchronisation
  const ok = await ms.initMs();
  updateSyncIndicator();
  if (ok) {
    ms.syncAll();
    setInterval(() => { if (!document.hidden) ms.syncAll(); }, 2 * 60 * 1000);
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

// Dans l'iframe de reconnexion silencieuse Microsoft, on ne démarre pas l'application.
if (window.self === window.top) start();
