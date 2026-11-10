// Parcours dans l'interface, sur ordinateur et sur téléphone.
const { test, expect } = require('@playwright/test');
const { openApp, run, noErrors } = require('./helpers');

test.afterEach(async ({ page }) => { noErrors(page); });

test('chaque onglet s’affiche sans erreur (avec les données d’exemple)', async ({ page }) => {
  await openApp(page, { hash: '#reglages' });
  page.on('dialog', (d) => d.accept());
  await page.click('[data-act="demo"]');
  for (const tab of ['taches', 'journee', 'matrice', 'calendrier', 'gantt', 'ressources', 'reglages']) {
    await page.goto('/#' + tab);
    await expect(page.locator('#view')).not.toBeEmpty();
  }
});

test('créer une tâche avec le bouton +', async ({ page }) => {
  await openApp(page);
  await page.locator('.fab, [data-fab], button[aria-label="Nouvelle tâche"]').first().click();
  await page.locator('.sheet [data-f="title"]').fill('Préparer le comité de pilotage');
  await page.click('.sheet [data-act="save"]');
  // Critères par défaut (3/3) : la tâche arrive dans « Le reste », groupe replié par défaut
  await page.click('.grp.c-reste .grp-head');
  await expect(page.locator('.task-row', { hasText: 'Préparer le comité de pilotage' })).toBeVisible();
});

test('Ma journée : minuteur, temps enregistré et tomate', async ({ page }) => {
  await openApp(page);
  await run(page, ({ store }) => { store.putTask(store.newTask({ title: 'Rapport annuel', urgency: 5, importance: 5, energy: 1, estimate: 120 })); });
  await page.goto('/#journee');
  await expect(page.locator('.now-title')).toContainText('Rapport annuel');
  await page.click('.now-acts [data-focus]');
  await expect(page.locator('.focus-time b')).toHaveText('25:00');
  await page.clock.setFixedTime(new Date('2026-11-10T09:52:00'));
  await page.click('[data-fend]');
  await expect(page.locator('.focus.done')).toBeVisible();
  const r = await run(page, ({ store }) => { const t = store.tasks().find((x) => x.title === 'Rapport annuel'); return { spent: store.spentOf(t), status: t.status, stats: JSON.parse(localStorage.getItem('gp:local:v1')).focusStats.total }; });
  expect(r.spent).toBe(12);
  expect(r.status).toBe('doing');
  expect(r.stats).toBe(1);
  await page.click('[data-fclose]');
});

test('revue du vendredi : bandeau puis assistant en 5 étapes', async ({ page }) => {
  await openApp(page, { at: '2026-11-13T15:30:00', hash: '#journee' });
  await page.click('.review-banner');
  for (let i = 0; i < 4; i++) await page.click('[data-rvnext]');
  await expect(page.locator('.rv-end')).toBeVisible();
  await page.click('[data-rvnext]');
  await expect(page.locator('.review-banner')).toHaveCount(0);
});

test('nouveau projet depuis un modèle', async ({ page }) => {
  await openApp(page, { hash: '#ressources' });
  await page.click('[data-fromtpl]');
  await page.fill('.sheet [data-k="name"]', 'Formation managers');
  await page.fill('.sheet [data-k="date"]', '2027-03-15');
  await page.click('[data-create]');
  await expect(page).toHaveURL(/#gantt/);
  const n = await run(page, ({ store }) => store.tasks().length);
  expect(n).toBe(12);
});

test('délégation : bloc « En attente de… » et relance', async ({ page }) => {
  await openApp(page);
  await run(page, ({ store, delegation }) => {
    const p = store.newResource({ name: 'Yanis Martin' }); store.putResource(p);
    const t = store.newTask({ title: 'Devis fournisseurs' }); store.putTask(t);
    delegation.delegateTo(t, p.id, { followUp: '2026-11-09' });
  });
  await page.goto('/#taches');
  await expect(page.locator('.card.wait')).toContainText('Yanis Martin');
  await expect(page.locator('.card.wait .badge.danger')).toContainText('1 à relancer');
  await page.locator('[data-nudge]').evaluate((a) => a.removeAttribute('href'));
  await page.click('[data-nudge]');
  const n = await run(page, ({ store }) => store.tasks()[0].nudges.length);
  expect(n).toBe(1);
});
