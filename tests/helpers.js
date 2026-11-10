// Outils communs aux tests.
const { expect } = require('@playwright/test');

/** Ouvre l'application à une date fixe (mardi 10 novembre 2026, 9 h 40 par défaut), données vides. */
async function openApp(page, { at = '2026-11-10T09:40:00', hash = '' } = {}) {
  await page.clock.setFixedTime(new Date(at));
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/vibrate|favicon/i.test(m.text())) page.errors.push(m.text()); });
  await page.goto('/' + hash);
  await page.waitForSelector('#view');
}

/** Exécute une fonction dans la page avec les modules de l'application chargés. */
function run(page, fn, arg) {
  return page.evaluate(async ({ src, arg }) => {
    const m = {};
    for (const n of ['store', 'sched', 'util', 'templates', 'delegation', 'today', 'notify', 'focus', 'review', 'advice', 'suggest']) m[n] = await import(`./js/${n}.js`);
    // eslint-disable-next-line no-new-func
    return new Function('m', 'arg', `return (${src})(m, arg);`)(m, arg);
  }, { src: fn.toString(), arg });
}

const noErrors = (page) => expect(page.errors, 'erreurs JavaScript').toEqual([]);

module.exports = { openApp, run, noErrors };
