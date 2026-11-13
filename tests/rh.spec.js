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
