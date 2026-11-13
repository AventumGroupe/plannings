// Plateforme RH (simulée) : absences et assistant.
const { test, expect } = require('@playwright/test');
const { openApp, run, noErrors } = require('./helpers');

const BASE = 'https://rh.example.com';
const LINK = `${BASE}/agenda/12-3-${'a'.repeat(40)}.ics`;

async function mockRh(page, calls = []) {
  await page.route(`${BASE}/api/plannings/**`, async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ url: req.url(), jeton: req.headers()['x-plannings-jeton'], body: req.postDataJSON?.() || null });
    if (req.headers()['x-plannings-jeton'] !== `12-3-${'a'.repeat(40)}`) return route.fulfill({ status: 401, headers: cors, json: { erreur: 'Lien inconnu' } });
    if (req.url().endsWith('/absences')) {
      return route.fulfill({ headers: cors, json: { compte: { role: 'gerant', nom: 'Stéphane Gely' }, evenements: [
        { id: 'conge-1', debut: '2026-11-11', fin: '2026-11-11', titre: 'Congés payés', type: 'conge' },
        { id: 'conge-2', debut: '2026-11-09', fin: '2026-11-20', titre: 'Congés — Yanis Martin', type: 'conge' },
      ] } });
    }
    if (req.url().endsWith('/equipe')) return route.fulfill({ headers: cors, json: { moi: { id: 1, nom: 'Stéphane Gely', role: 'gerant', dirigeant: true }, equipe: [] } });
    if (req.url().includes('/partage')) return route.fulfill({ headers: cors, json: { taches: [] } });
    return route.fulfill({ headers: cors, json: { reponse: 'Commencez par le rapport demain matin.', actions: [
      { type: 'planifier', tache_id: req.postDataJSON().contexte.taches[0].id, titre: null, debut: '2026-11-12T08:00', duree_min: 25, echeance: null, personne: null, urgence: null, importance: null, energie: null, justification: 'Plombant : le matin.' },
    ] } });
  });
}

test.afterEach(async ({ page }) => { noErrors(page); });

test('relier la plateforme RH : congés chargés, jour de congé sans proposition', async ({ page }) => {
  const calls = [];
  await openApp(page, { hash: '#reglages' });
  await mockRh(page, calls);
  await page.fill('[data-rhlink]', LINK);
  await page.locator('[data-rhlink]').dispatchEvent('change');
  await expect(page.locator('[data-rh-card] .ok-text')).toContainText('Stéphane Gely');
  expect(calls[0].jeton).toBe(`12-3-${'a'.repeat(40)}`);
  const r = await run(page, ({ store, sched, rh }) => ({
    ownTomorrow: store.ownAbsentOn('2026-11-11'),
    busy: sched.busyOn(new Date('2026-11-11T10:00')).length,
    slot: sched.findFreeSlot(new Date('2026-11-11T00:00'), 60, 8, 18),
    yanis: !!rh.absenceOf('Yanis Martin'),
  }), null);
  expect(r).toEqual({ ownTomorrow: true, busy: 1, slot: null, yanis: true });
});

test('déléguer à une personne absente : alerte', async ({ page }) => {
  await openApp(page);
  await mockRh(page);
  await run(page, async ({ store, rh, delegation }) => {
    await rh.setRhLink(arg);
    const p = store.newResource({ name: 'Yanis Martin' }); store.putResource(p);
    const t = store.newTask({ title: 'Commande matériel' }); store.putTask(t);
    delegation.delegateTo(t, p.id);
  }, LINK);
  await page.goto('/#journee');
  await expect(page.locator('.card.wait')).toContainText('absent(e) du 9 nov. au 20 nov.');
});

test('assistant : question, réponse, action appliquée', async ({ page }) => {
  const calls = [];
  await openApp(page);
  await mockRh(page, calls);
  await run(page, async ({ store, rh }) => {
    await rh.setRhLink(arg);
    store.putTask(store.newTask({ title: 'Rapport annuel', urgency: 5, importance: 5, energy: 1, estimate: 120 }));
  }, LINK);
  await page.click('[data-assistant]');
  await page.fill('[data-q]', 'Que faire maintenant ?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.as-msg.assistant .as-bubble')).toContainText('Commencez par le rapport');
  const body = calls.find((c) => c.url.endsWith('/assistant')).body;
  expect(body.question).toBe('Que faire maintenant ?');
  expect(body.contexte.taches[0].titre).toBe('Rapport annuel');
  expect(body.contexte.taches[0]).not.toHaveProperty('notes');
  await page.click('[data-apply="1:0"]');
  await expect(page.locator('.as-acts li.done')).toHaveCount(1);
  const start = await run(page, ({ store }) => store.tasks()[0].start);
  expect(start).toBe('2026-11-12T08:00');
});

test('équipe : proposition reçue, acceptée, puis faite ; profil venu du rôle RH', async ({ page }) => {
  const calls = [];
  let statut = 'proposee';
  await openApp(page);
  await page.route(`${BASE}/api/plannings/**`, async (route) => {
    const req = route.request(); const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const u = req.url(); calls.push(req.method() + ' ' + u.replace(BASE, '') + (req.postData() ? ' ' + req.postData() : ''));
    if (u.endsWith('/absences')) return route.fulfill({ headers: cors, json: { compte: { id: 2, role: 'salarie', nom: 'Claire Dupont' }, evenements: [] } });
    if (u.endsWith('/equipe')) return route.fulfill({ headers: cors, json: { moi: { id: 2, nom: 'Claire Dupont', role: 'salarie', dirigeant: false }, equipe: [{ id: 1, nom: 'Stéphane Gely', dirigeant: true, confiable: false }, { id: 3, nom: 'Yanis Martin', dirigeant: false, confiable: true }] } });
    if (u.includes('/statut')) { statut = req.postDataJSON().statut; return route.fulfill({ headers: cors, json: { ok: true } }); }
    return route.fulfill({ headers: cors, json: { taches: [{ id: 'abc123', statut, titre: 'Bilan Qualiopi', description: '', projet: '', echeance: '2026-11-27', estimation_min: 120, urgence: 4, importance: 5, energie: 2, motif: null, de: { id: 1, nom: 'Stéphane Gely' }, a: { id: 2, nom: 'Claire Dupont' }, moi: 'a', maj: Date.now() }] } });
  });
  await run(page, async ({ rh }) => { await rh.setRhLink(arg); const t = await import('./js/team.js'); await t.teamSync(true); }, LINK);
  await page.goto('/#journee');
  await expect(page.locator('.sh-in')).toContainText('Bilan Qualiopi');
  await expect(page.locator('.sh-motif')).toBeHidden();
  await page.click('[data-sh-accept]');
  await expect(page.locator('.sh-in')).toHaveCount(0);
  const r = await run(page, ({ store }) => { const t = store.db.tasks['sh-abc123']; return { role: store.db.settings.role, title: t?.title, needs: store.needsDecision(t), motivation: t?.motivation }; });
  expect(r).toEqual({ role: 'collaborateur', title: 'Bilan Qualiopi', needs: true, motivation: null });
  // terminée ici -> signalée « faite » à la plateforme ; la motivation n'est jamais envoyée
  await run(page, async ({ store }) => { const l = await import('./js/list.js'); const t = store.db.tasks['sh-abc123']; t.motivation = 3; t.decision = { key: 'planifier', at: Date.now() }; store.putTask(t); l.toggleDone(t); });
  await expect.poll(() => statut).toBe('faite');
  expect(calls.some((c) => /motivation/.test(c))).toBe(false);
});
