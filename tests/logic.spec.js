// Logique métier : catégories, durées, modèles, délégation, journée, notifications, fusion, cascade.
const { test, expect } = require('@playwright/test');
const { openApp, run, noErrors } = require('./helpers');

test.beforeEach(async ({ page }) => { await openApp(page); });
test.afterEach(async ({ page }) => { noErrors(page); });

test('les 8 situations : Eisenhower (U×I) × énergie × motivation', async ({ page }) => {
  const r = await run(page, ({ store }) => [
    [5, 5, 4], [5, 5, 1], [2, 5, 4], [2, 5, 1], [5, 2, 4], [5, 2, 1], [2, 2, 4], [2, 2, 1],
  ].map(([urgency, importance, energy]) => store.category({ urgency, importance, energy, motivation: 3 })));
  expect(r).toEqual(['prioriser', 'urg_lourd', 'planifier', 'imp_lourd', 'expedier', 'urg_second', 'plustard', 'abandon']);
});

test('décision recommandée selon le profil', async ({ page }) => {
  const r = await run(page, ({ store }) => {
    const t = (u, i, e, m) => ({ urgency: u, importance: i, energy: e, motivation: m, estimate: 60 });
    const pick = () => [t(5, 5, 1, 2), t(2, 5, 1, 2), t(5, 2, 1, 2), t(2, 2, 1, 2), t(2, 5, 4, 4)].map((x) => store.decisionsFor(x)[0]);
    store.setSettings({ role: 'dirigeant' }); const lead = pick();
    store.setSettings({ role: 'collaborateur' }); const collab = pick();
    return { lead, collab, ui: store.uiScore(t(5, 4, 1, 1)), em: store.emScore(t(1, 1, 3, 4)) };
  });
  expect(r.lead).toEqual(['deleguer', 'deleguer', 'refuser', 'abandon', 'planifier']);
  expect(r.collab).toEqual(['manager', 'decouper', 'valider', 'abandon', 'planifier']);
  expect(r.ui).toBe(20);
  expect(r.em).toBe(12);
});

test('l’urgence monte à l’approche de l’échéance ; tâche urgente et courte = tout de suite', async ({ page }) => {
  const r = await run(page, ({ store }) => {
    const t = (due, estimate = 60) => ({ urgency: 1, importance: 3, energy: 3, motivation: 3, due, estimate, status: 'todo' });
    return { d1: store.effUrgency(t('2026-11-11')), d3: store.effUrgency(t('2026-11-13')), d7: store.effUrgency(t('2026-11-16')), far: store.effUrgency(t('2026-12-20')),
      quick: store.decisionsFor({ ...t('2026-11-11', 10), importance: 5 })[0] };
  });
  expect(r).toEqual({ d1: 5, d3: 4, d7: 3, far: 1, quick: 'expedier' });
});

test('anciennes tâches : motivation 2 et décision déduite ; nouvelles : à trancher', async ({ page }) => {
  const r = await run(page, ({ store }) => {
    store.mergeRemote({ tasks: { old1: { id: 'old1', title: 'Ancienne', urgency: 3, importance: 3, energy: 3, start: '2026-11-12T09:00', end: '2026-11-12T10:00', updatedAt: Date.now() } }, projects: {}, resources: {}, deleted: {} });
    const n = store.newTask({ title: 'Nouvelle' }); store.putTask(n);
    const o = store.db.tasks.old1;
    return { m: o.motivation, d: o.decision?.key, oldNeeds: store.needsDecision(o), newNeeds: store.needsDecision(n) };
  });
  expect(r).toEqual({ m: 2, d: 'planifier', oldNeeds: false, newNeeds: true });
});

test('abandonner : tâche supprimée, trace dans le journal des renoncements', async ({ page }) => {
  const r = await run(page, ({ store }) => {
    const t = store.newTask({ title: 'Veille concurrentielle', motivation: 1 }); store.putTask(t);
    store.abandonTask(t, 'Plus d’actualité');
    return { exists: !!store.db.tasks[t.id], journal: store.abandons().map((a) => a.title + ' / ' + a.reason) };
  });
  expect(r).toEqual({ exists: false, journal: ['Veille concurrentielle / Plus d’actualité'] });
});

test('saisie des durées', async ({ page }) => {
  const r = await run(page, ({ store }) => ['1h30', '45', '2,5', '1 h 15', ''].map(store.parseDuration));
  expect(r).toEqual([90, 45, 150, 75, 0]);
});

test('modèle « Session de formation » : rétroplanning en jours ouvrés', async ({ page }) => {
  const r = await run(page, ({ store, templates }) => {
    const { project, count } = templates.instantiate('tpl-session', { name: 'Session test', anchorDate: '2027-03-15' });
    const list = store.tasks().filter((t) => t.projectId === project.id);
    const days = list.map((t) => new Date(t.start).getDay());
    const anim = list.find((t) => t.title === 'Animation de la session');
    return { count, n: list.length, weekend: days.filter((d) => d === 0 || d === 6).length, anim: anim.start.slice(0, 10), preds: list.filter((t) => t.preds.length).length, deadline: project.deadline };
  });
  expect(r.count).toBe(12);
  expect(r.n).toBe(12);
  expect(r.weekend).toBe(0);
  expect(r.anim).toBe('2027-03-15');
  expect(r.preds).toBe(11);
});

test('enregistrer un projet comme modèle puis le réutiliser', async ({ page }) => {
  const r = await run(page, ({ store, templates }) => {
    const { project } = templates.instantiate('tpl-session', { name: 'Source', anchorDate: '2027-03-15' });
    const tpl = templates.saveAsTemplate(project.id, 'Mon modèle');
    const again = templates.instantiate(tpl.id, { name: 'Copie', anchorDate: '2027-06-14' });
    return { steps: tpl.steps.length, count: again.count, saved: store.templates().length };
  });
  expect(r).toEqual({ steps: 12, count: 12, saved: 1 });
});

test('délégation : retour attendu, relance, liste « à relancer »', async ({ page }) => {
  const r = await run(page, ({ store, delegation }) => {
    const p = store.newResource({ name: 'Yanis' }); store.putResource(p);
    const t = store.newTask({ title: 'Commande' }); store.putTask(t);
    delegation.delegateTo(t, p.id);
    const first = t.followUp;
    const due1 = delegation.followUpDue().length;
    t.followUp = '2026-11-09'; store.putTask(t);
    const due2 = delegation.followUpDue().length;
    delegation.recordNudge(t);
    return { first, due1, due2, nudges: t.nudges.length, next: t.followUp, waiting: delegation.waiting().length };
  });
  expect(r.first).toBe('2026-11-13'); // mardi + 3 jours ouvrés
  expect(r.due1).toBe(0);
  expect(r.due2).toBe(1);
  expect(r.nudges).toBe(1);
  expect(r.next).toBe('2026-11-12');
  expect(r.waiting).toBe(1);
});

test('proposition de journée : plombantes le matin, jamais deux d’affilée', async ({ page }) => {
  const r = await run(page, ({ store, today }) => {
    const mk = (title, energy, estimate, urgency = 4, importance = 4) => store.putTask(store.newTask({ title, energy, estimate, urgency, importance, motivation: 3, decision: { key: 'prioriser', at: Date.now() } }));
    mk('Bilan', 1, 120, 5, 5); mk('Relecture', 2, 60); mk('Appel', 3, 15); mk('Idées', 4, 45, 2, 4);
    return today.proposeDay().map((p) => ({ title: p.t.title, energy: p.t.energy, h: p.s.getHours(), m: (p.e - p.s) / 60000 }));
  });
  expect(r[0].title).toBe('Bilan');
  expect(r[0].h).toBeLessThan(12);
  expect(r[0].m).toBe(25); // séance plombante
  for (let i = 1; i < r.length; i++) expect(r[i - 1].energy <= 2 && r[i].energy <= 2).toBe(false);
});

test('notifications à venir : rappel, relance, revue du lundi', async ({ page }) => {
  const r = await run(page, ({ store, util, delegation, notify }) => {
    const st = new Date('2026-11-10T14:00:00');
    store.putTask(store.newTask({ title: 'Réunion', start: util.toLocal(st), end: util.toLocal(new Date(st.getTime() + 3600e3)), reminder: 15 }));
    const p = store.newResource({ name: 'Claire' }); store.putResource(p);
    const t = store.newTask({ title: 'Salle' }); store.putTask(t); delegation.delegateTo(t, p.id, { followUp: '2026-11-12' });
    return notify.upcoming().map((n) => n.key.split(':')[0].split('@')[0].replace(/^[a-z0-9]{10,}$/, 'task') + ' ' + new Date(n.at).toISOString().slice(0, 16));
  });
  expect(r.some((x) => x.startsWith('task 2026-11-10T12:45'))).toBe(true); // 14 h - 15 min (heure de Paris = UTC+1)
  expect(r.some((x) => x.startsWith('fu '))).toBe(true);
  expect(r.some((x) => x.startsWith('review 2026-11-16T08:00'))).toBe(true); // lundi 9 h (Paris)
});

test('fusion entre appareils : la version la plus récente gagne, suppressions comprises', async ({ page }) => {
  const r = await run(page, ({ store }) => {
    const a = store.newTask({ title: 'Local' }); store.putTask(a);
    const b = store.newTask({ title: 'À supprimer' }); store.putTask(b);
    const remote = { tasks: { [a.id]: { ...a, title: 'Distant plus récent', updatedAt: Date.now() + 1000 } }, projects: {}, resources: {}, deleted: { [b.id]: { at: Date.now() + 1000, kind: 'task' } } };
    store.mergeRemote(remote);
    return { title: store.db.tasks[a.id].title, gone: !store.db.tasks[b.id] };
  });
  expect(r).toEqual({ title: 'Distant plus récent', gone: true });
});

test('dépendances : un retard décale les successeurs', async ({ page }) => {
  const r = await run(page, ({ store, sched, util }) => {
    const a = store.newTask({ title: 'A', allDay: true, start: '2026-11-16T00:00', end: '2026-11-18T00:00' }); store.putTask(a);
    const b = store.newTask({ title: 'B', allDay: true, start: '2026-11-18T00:00', end: '2026-11-19T00:00', preds: [{ id: a.id, lag: 0 }] }); store.putTask(b);
    sched.shiftTo(a, new Date('2026-11-19T00:00')); store.putTask(a); sched.propagate([a.id]);
    return { a: a.start.slice(0, 10), b: store.db.tasks[b.id].start.slice(0, 10) };
  });
  expect(r.a).toBe('2026-11-19');
  expect(r.b >= '2026-11-21').toBe(true);
});

test('tri des mails marqués : seuls ceux qui appellent une réponse', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { classifyMail } = await import('./js/mailfilter.js');
    return [
      ["Keynote Live - Création d'un écosystème business", 'Inscrivez-vous gratuitement. Se désinscrire'],
      ['RE: Devis formation management', 'Pouvez-vous me confirmer les dates ?'],
      ['Votre commande n°12345 a été expédiée', 'Suivi de colis'],
      ['Facture disponible - Octobre', 'Ne pas répondre à ce message'],
      ['-30% sur toutes nos formations', 'Offre limitée'],
      ['Demande de devis formation Excel', 'Nous souhaiterions un devis.'],
      ['Votre code de vérification', 'Votre code est 123456'],
      ['Relance facture impayée F2026-102', 'Merci de procéder au règlement.'],
    ].map(([s, p]) => classifyMail(s, p).kind);
  });
  expect(r).toEqual(['promo', 'reponse', 'auto', 'auto', 'promo', 'reponse', 'auto', 'reponse']);
});
