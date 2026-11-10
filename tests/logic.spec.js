// Logique métier : catégories, durées, modèles, délégation, journée, notifications, fusion, cascade.
const { test, expect } = require('@playwright/test');
const { openApp, run, noErrors } = require('./helpers');

test.beforeEach(async ({ page }) => { await openApp(page); });
test.afterEach(async ({ page }) => { noErrors(page); });

test('les 6 catégories (urgence × importance × énergie)', async ({ page }) => {
  const r = await run(page, ({ store }) => [
    [5, 5, 4], [5, 5, 1], [5, 2, 3], [2, 5, 4], [2, 5, 1], [2, 2, 2],
  ].map(([urgency, importance, energy]) => store.category({ urgency, importance, energy })));
  expect(r).toEqual(['priorite', 'deleguer', 'cote', 'planifier', 'collaborer', 'reste']);
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
    const mk = (title, energy, estimate, urgency = 4, importance = 4) => store.putTask(store.newTask({ title, energy, estimate, urgency, importance }));
    mk('Bilan', 1, 120, 5, 5); mk('Relecture', 2, 60); mk('Appel', 3, 15); mk('Idées', 4, 45, 2, 4);
    return today.proposeDay().map((p) => ({ title: p.t.title, energy: p.t.energy, h: p.s.getHours(), m: (p.e - p.s) / 60000 }));
  });
  expect(r[0].title).toBe('Bilan');
  expect(r[0].h).toBeLessThan(12);
  expect(r[0].m).toBe(25); // séance plombante
  for (let i = 1; i < r.length; i++) expect(r[i - 1].energy <= 2 && r[i].energy <= 2).toBe(false);
});

test('notifications à venir : rappel, relance, revue du vendredi', async ({ page }) => {
  const r = await run(page, ({ store, util, delegation, notify }) => {
    const st = new Date('2026-11-10T14:00:00');
    store.putTask(store.newTask({ title: 'Réunion', start: util.toLocal(st), end: util.toLocal(new Date(st.getTime() + 3600e3)), reminder: 15 }));
    const p = store.newResource({ name: 'Claire' }); store.putResource(p);
    const t = store.newTask({ title: 'Salle' }); store.putTask(t); delegation.delegateTo(t, p.id, { followUp: '2026-11-12' });
    return notify.upcoming().map((n) => n.key.split(':')[0].split('@')[0].replace(/^[a-z0-9]{10,}$/, 'task') + ' ' + new Date(n.at).toISOString().slice(0, 16));
  });
  expect(r.some((x) => x.startsWith('task 2026-11-10T12:45'))).toBe(true); // 14 h - 15 min (heure de Paris = UTC+1)
  expect(r.some((x) => x.startsWith('fu '))).toBe(true);
  expect(r.some((x) => x.startsWith('review 2026-11-13T15:00'))).toBe(true);
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
