# Gestion des plannings

Application de planification (urgence, importance, énergie) : liste, matrice, calendrier, Gantt, ressources.
Synchronisation avec Microsoft 365 (agenda Outlook, Microsoft To Do, mails marqués d'un drapeau).

Fonctions principales : « Ma journée » (énergie du moment, tâche conseillée, proposition de journée),
minuteur de concentration ludique, délégation suivie (retour attendu, relances), revue de la semaine,
modèles de projets (rétroplanning), sous-tâches avec temps passé, PERT, notifications Android natives.

- **Version web** (GitHub Pages) : https://aventumgroupe.github.io/plannings/
- **Application Android** (dernière version) : https://github.com/AventumGroupe/plannings/releases/latest/download/gestion-plannings.apk

## Organisation du dépôt
- Racine : l'application web (`index.html`, `css/`, `js/`, `icons/`, `vendor/`, `sw.js`), publiée telle quelle par GitHub Pages.
- `android/`, `capacitor.config.json`, `package.json`, `scripts/` : application Android (Capacitor) qui embarque la même application web.
- `.github/workflows/android.yml` : à chaque modification de `main`, construit l'APK et le publie dans « Releases ».
  Signature : secrets `SIGNING_KEYSTORE` (clé .jks en base64) et `SIGNING_PASSWORD` (*Settings → Secrets and variables → Actions*).
  La clé doit rester la même pour que les mises à jour s'installent par-dessus l'application existante.
- `tests/`, `playwright.config.js`, `.github/workflows/tests.yml` : tests automatiques (Playwright), lancés à chaque modification.
  En local : `npm ci`, `npx playwright install chromium`, puis `npm test`.
