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
  await expect(page.locator('.sheet [data-f="title"]')).toBeFocused(); // la fiche place le curseur dans le titre
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
  await expect(page.locator('.dc-advice')).toContainText('Conseil : Déléguer');
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

test('Décision : le salarié a tous les choix, et peut fractionner (3 séances, 1 jour d’écart)', async ({ page }) => {
  await openApp(page);
  await run(page, ({ store }) => {
    store.setSettings({ role: 'collaborateur' });
    store.putTask(store.newTask({ title: 'Rédiger le programme', urgency: 3, importance: 5, energy: 2, motivation: 2, estimate: 90 }));
  });
  await page.goto('/#decision');
  await expect(page.locator('.dc-grid .dc-chip')).toHaveCount(11);
  await expect(page.locator('.dc-grid [data-dec="deleguer"]')).toBeVisible();
  await page.click('.dc-grid [data-dec="decouper"]');
  await page.fill('[data-x="n"]', '3');
  await page.fill('[data-x="from"]', '2026-11-10');
  await expect(page.locator('[data-split-preview]')).toContainText('3 séances de 30 min');
  await page.click('[data-dec-ok]');
  const r = await run(page, ({ store }) => store.tasks().filter((t) => t.parentId).map((t) => `${t.start.slice(0, 10)} ${t.estimate}`).sort());
  expect(r).toEqual(['2026-11-10 30', '2026-11-11 30', '2026-11-12 30']);
  // séance du jour : dans « Aujourd'hui, à arbitrer » ; les cocher toutes termine la tâche d'origine
  await page.goto('/#journee');
  await expect(page.locator('.today-block')).toContainText('séance 1/3');
  const done = await run(page, async ({ store }) => {
    const l = await import('./js/list.js');
    store.tasks().filter((t) => t.parentId).forEach((t) => l.toggleDone(t));
    return store.tasks().find((t) => t.sessions)?.status;
  });
  expect(done).toBe('done');
});

test('case « terminée » : depuis la Décision et la Matrice ; plus jamais reproposée', async ({ page }) => {
  await openApp(page);
  await run(page, ({ store }) => {
    store.putTask(store.newTask({ title: 'Déjà réglé', motivation: 3 }));
    store.putTask(store.newTask({ title: 'Appel fournisseur', urgency: 5, importance: 5, energy: 4, motivation: 4, estimate: 10, decision: { key: 'prioriser', at: Date.now() } }));
  });
  await page.goto('/#decision');
  await page.click('[data-dc-done]');
  await expect(page.locator('.dc-empty')).toBeVisible();
  await page.goto('/#matrice');
  await page.locator('.mx-card', { hasText: 'Appel fournisseur' }).locator('[data-done-task]').click();
  await page.goto('/#journee');
  await expect(page.locator('.now-card .now-title')).toHaveCount(0);
  const r = await run(page, ({ store }) => store.tasks().map((t) => t.status));
  expect(r).toEqual(['done', 'done']);
});

test('propositions de Claude : accepter, refuser, modifier ; jamais reproposées', async ({ page }) => {
  const props = { items: [
    { id: 'p1', titre: 'Préparer la réunion OPCO de demain', source: 'Journée à venir', raison: 'Rendez-vous demain à 10 h sans document préparé.', echeance: '2026-11-11', estimation_min: 30, urgence: 4, importance: 4, energie: 3 },
    { id: 'p2', titre: 'Répondre au devis Durand', source: 'Journée passée', raison: 'Mail reçu hier, sans réponse.' },
    { id: 'p3', titre: 'Relancer le formateur', source: 'Journée passée' },
  ] };
  const b64 = Buffer.from(JSON.stringify(props)).toString('base64');
  await page.route('https://api.github.com/**', (r) => r.request().url().includes('propositions.json')
    ? r.fulfill({ json: { content: b64 } }) : r.fulfill({ status: 404, json: { message: 'Not Found' } }));
  await openApp(page);
  await run(page, async () => {
    const s = await import('./js/store.js'); s.local.set('ghToken', 'jeton-test'); s.local.set('ghRepo', 'AventumGroupe/plannings-donnees');
    const c = await import('./js/claudeprops.js'); await c.fetchProps(true);
  });
  await page.goto('/#journee');
  await expect(page.locator('.cl-props .sh-in')).toHaveCount(3);
  await page.click('[data-cp="ok"][data-cp-id="p1"]');
  await page.click('[data-cp="no"][data-cp-id="p2"]');
  await page.click('[data-cp="edit"][data-cp-id="p3"]');
  await page.locator('.sheet [data-f="title"]').fill('Relancer le formateur Martin');
  await page.click('.sheet [data-act="save"]');
  await expect(page.locator('.cl-props')).toHaveCount(0);
  const r = await run(page, ({ store }) => ({ titles: store.tasks().map((t) => t.title).sort(), refused: !!store.db.deleted['cl-p2'], needs: store.tasks().every(store.needsDecision) }));
  expect(r).toEqual({ titles: ['Préparer la réunion OPCO de demain', 'Relancer le formateur Martin'], refused: true, needs: true });
});
