// Parcours dans l'interface, sur ordinateur et sur téléphone.
const { test, expect } = require('@playwright/test');
const { openApp, run, noErrors } = require('./helpers');

test.afterEach(async ({ page }) => { noErrors(page); });

test('chaque onglet s’affiche sans erreur (avec les données d’exemple)', async ({ page }) => {
  await openApp(page, { hash: '#reglages' });
  page.on('dialog', (d) => d.accept());
  await page.locator('.adv-set summary').click();
  await page.click('[data-act="demo"]');
  for (const tab of ['journee', 'decision', 'liste', 'matrice', 'calendrier', 'gantt', 'ressources', 'reglages']) {
    await page.goto('/#' + tab);
    await expect(page.locator('#view')).not.toBeEmpty();
  }
  await expect(page.locator('.set-top .badge')).toContainText('Version');
});

test('créer une tâche avec un nouveau projet, puis la trancher', async ({ page }) => {
  await openApp(page, { hash: '#decision' });
  await page.locator('.fab').click();
  await page.locator('.sheet [data-f="title"]').fill('Préparer le comité de pilotage');
  await page.locator('.sheet [data-f="projectName"]').fill('Comité 2027');
  await page.click('.sheet [data-act="save"]');
  // nouvelle tâche : à trancher (onglet Décision), projet créé à l'enregistrement
  await expect(page.locator('.dc-title')).toHaveValue('Préparer le comité de pilotage');
  await expect(page.locator('.dc-meta')).toContainText('Comité 2027');
  await page.click('.dc-chip[data-dec="planifier"]');
  await expect(page.locator('.dc-empty')).toBeVisible();
  await page.goto('/#liste');
  await expect(page.locator('.lt-row', { hasText: 'Préparer le comité de pilotage' })).toBeVisible();
});

test('Décision : noter la motivation, déléguer à une personne', async ({ page }) => {
  await openApp(page);
  await run(page, ({ store }) => {
    store.putResource(store.newResource({ name: 'Claire Dupont' }));
    store.putTask(store.newTask({ title: 'Déclaration de TVA', urgency: 5, importance: 5, energy: 1 }));
  });
  await page.goto('/#decision');
  await page.click('[data-moti="2"]');
  await expect(page.locator('.dc-situ')).toContainText('Déléguer');
  await page.click('.dc-main');
  await page.click('[data-dec-ok]');
  const r = await run(page, ({ store }) => { const t = store.tasks()[0]; return { d: t.decision.key, who: store.db.resources[t.delegate]?.name, m: t.motivation }; });
  expect(r).toEqual({ d: 'deleguer', who: 'Claire Dupont', m: 2 });
});

test('Ma journée : minuteur, temps enregistré et tomate', async ({ page }) => {
  await openApp(page);
  await run(page, ({ store }) => { store.putTask(store.newTask({ title: 'Rapport annuel', urgency: 5, importance: 5, energy: 1, motivation: 3, decision: { key: 'prioriser', at: Date.now() }, estimate: 120 })); });
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

test('revue du lundi : bandeau puis assistant en 5 étapes', async ({ page }) => {
  await openApp(page, { at: '2026-11-16T09:30:00', hash: '#journee' });
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
  await page.goto('/#journee');
  await expect(page.locator('.card.wait')).toContainText('Yanis Martin');
  await expect(page.locator('.card.wait .badge.danger')).toContainText('1 à relancer');
  await page.locator('[data-nudge]').evaluate((a) => a.removeAttribute('href'));
  await page.click('[data-nudge]');
  const n = await run(page, ({ store }) => store.tasks()[0].nudges.length);
  expect(n).toBe(1);
});

test('calendrier : cliquer sur un rendez-vous ouvre son détail sans casser la vue', async ({ page }) => {
  await openApp(page);
  await run(page, ({ store }) => {
    store.local.set('outlookEvents', [{ id: 'e1', subject: 'Rendez-vous client', start: '2026-11-10T10:00', end: '2026-11-10T11:00', location: 'Salle A' }]);
    store.putTask(store.newTask({ title: 'Dossier', due: '2026-11-12', motivation: 3, decision: { key: 'planifier', at: Date.now() } }));
  });
  await page.goto('/#calendrier/semaine/2026-11-10');
  await page.locator('[data-ext="e1"]').click();
  await expect(page.locator('.ev-detail')).toContainText('Salle A');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cal-title')).toContainText('Semaine');
  await expect(page.locator('[data-col]')).toHaveCount(7);
  await expect(page.locator('.chip-ev.due')).toContainText('Dossier');
  await expect(page.locator('.cal-360')).toContainText('1 rendez-vous');
});

test('matrice : 8 cases, déplacer une tâche la renvoie dans Décision', async ({ page }) => {
  await openApp(page);
  await run(page, ({ store }) => { store.putTask(store.newTask({ title: 'Audit', urgency: 2, importance: 5, energy: 4, motivation: 4, decision: { key: 'planifier', at: Date.now() } })); });
  await page.goto('/#matrice');
  await expect(page.locator('[data-cell]')).toHaveCount(8);
  await expect(page.locator('.mx-cell.c-planifier .mx-card')).toContainText('Audit');
  const r = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    return { cat: s.category(s.tasks()[0]) };
  });
  expect(r.cat).toBe('planifier');
});

test('Gantt : « Nouveau projet » propose projet vide ou modèle', async ({ page }) => {
  await openApp(page, { hash: '#gantt' });
  await page.locator('[data-newproj-choose]').first().click();
  await expect(page.locator('.np-choice')).toHaveCount(2);
  await page.click('[data-np="tpl"]');
  await expect(page.locator('.tpl-item')).toHaveCount(1);
});
