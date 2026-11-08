// Synchronisation des données via un dépôt GitHub privé (fichier JSON).
// Fonctionne à l'identique dans la version web et dans l'application Android.

import { db, local, mergeRemote } from './store.js';

const API = 'https://api.github.com';
const FILE = 'plannings.json';

let running = null;
const status = { state: 'off', last: local.get('ghLastSync', null), error: null };
const listeners = new Set();
export const onGhStatus = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const ghStatus = () => ({ ...status });
function setStatus(p) { Object.assign(status, p); listeners.forEach((f) => f(ghStatus())); }

export const ghRepo = () => local.get('ghRepo', 'AventumGroupe/plannings-donnees');
export const ghToken = () => local.get('ghToken', '');
export const ghConfigured = () => !!(ghToken() && ghRepo());
export function ghSetup(repo, token) {
  local.set('ghRepo', (repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, ''));
  local.set('ghToken', (token || '').trim());
  local.set('ghSha', null);
  local.set('ghLastPushed', null);
  setStatus({ state: ghConfigured() ? 'idle' : 'off', error: null });
}
export function ghDisconnect() { local.set('ghToken', ''); local.set('ghSha', null); setStatus({ state: 'off', error: null }); }

class GhError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function gh(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${ghToken()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch {}
    throw new GhError(res.status, msg);
  }
  return res.status === 204 ? null : res.json();
}

// Base64 <-> texte UTF-8 (accents compris)
const toB64 = (s) => { const b = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(bin); };
const fromB64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

function messageOf(e) {
  if (!navigator.onLine) return 'Hors connexion : la synchronisation reprendra au retour du réseau.';
  if (e.status === 401) return 'Clé d’accès refusée : vérifiez-la ou créez-en une nouvelle.';
  if (e.status === 403) return 'Accès refusé : la clé doit avoir l’autorisation « Contents : Read and write » sur ce dépôt.';
  if (e.status === 404) return 'Dépôt introuvable : vérifiez son nom et que la clé y donne accès.';
  return e.message || String(e);
}

async function pull() {
  const path = `/repos/${ghRepo()}/contents/${FILE}`;
  try {
    const r = await gh(path);
    local.set('ghSha', r.sha);
    const text = r.content ? fromB64(r.content) : await (await fetch(r.download_url, { cache: 'no-store' })).text();
    const remote = JSON.parse(text);
    mergeRemote(remote);
    // Si rien de local n'est plus récent, inutile de renvoyer le même contenu.
    const merged = JSON.stringify(db, null, 1);
    if (merged === JSON.stringify(remote, null, 1)) local.set('ghLastPushed', merged);
    return r.sha;
  } catch (e) {
    if (e.status === 404) {
      // Le dépôt existe-t-il ? (sinon c'est une vraie erreur)
      await gh(`/repos/${ghRepo()}`);
      local.set('ghSha', null);
      return null;
    }
    throw e;
  }
}

async function push(sha, retry = true) {
  const text = JSON.stringify(db, null, 1);
  if (text === local.get('ghLastPushed') && sha) return false; // rien de nouveau : pas de version inutile
  try {
    const r = await gh(`/repos/${ghRepo()}/contents/${FILE}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Mise à jour des plannings (${new Date().toLocaleString('fr-FR')})`,
        content: toB64(text),
        ...(sha ? { sha } : {}),
      }),
    });
    local.set('ghSha', r.content.sha);
    local.set('ghLastPushed', text);
    return true;
  } catch (e) {
    if ((e.status === 409 || e.status === 422) && retry) { // modifié entre-temps par un autre appareil
      const s = await pull();
      return push(s, false);
    }
    throw e;
  }
}

/** Récupère, fusionne puis enregistre. */
export function ghSync({ manual = false } = {}) {
  if (!ghConfigured()) return Promise.resolve(false);
  if (!navigator.onLine) { setStatus({ state: 'offline' }); return Promise.resolve(false); }
  if (running) return running;
  running = (async () => {
    setStatus({ state: 'syncing', error: null });
    try {
      const sha = await pull();
      const pushed = await push(sha);
      const now = Date.now();
      local.set('ghLastSync', now);
      setStatus({ state: 'idle', last: now, error: null });
      return { pushed };
    } catch (e) {
      console.error(e);
      setStatus({ state: 'error', error: messageOf(e) });
      if (manual) throw new Error(messageOf(e));
      return false;
    } finally {
      running = null;
    }
  })();
  return running;
}
