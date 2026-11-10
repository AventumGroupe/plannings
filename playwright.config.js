// Tests automatiques (Playwright) : logique de planification et parcours dans l'interface.
// Lancer : npm test   (le serveur statique est démarré automatiquement)
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8790/',
    trace: 'off',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'python3 -m http.server 8790',
    url: 'http://localhost:8790/index.html',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'ordinateur', use: { viewport: { width: 1280, height: 860 } } },
    { name: 'telephone', use: { viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true }, testMatch: /ui\.spec/ },
  ],
});
