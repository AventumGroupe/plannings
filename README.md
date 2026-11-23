# Gestion des plannings

Application de planification (urgence, importance, énergie) : liste, matrice, calendrier, Gantt, ressources.
Synchronisation avec Microsoft 365 (agenda Outlook, Microsoft To Do, mails marqués d'un drapeau).

Onglets : **Journée** (énergie du moment, tâche conseillée qui tient dans le temps libre avant le prochain
rendez-vous, tâches du jour à arbitrer, propositions de Claude), **Décision** (scores Eisenhower U×I et
énergie × motivation, conseil ; 11 décisions ouvertes à tous, dont « Fractionner » en séances espacées),
**Liste** (tableau par décision), **Matrice**, **Calendrier 360°**, **Gantt / PERT**, **Ressources / Équipe**, **Réglages**.

Aussi : case « terminée » partout, délégation suivie et tâches confiées en ligne (plateforme RH), modèles de
projets, minuteur de concentration, revue du lundi, journal des renoncements, absences RH, assistant Claude,
notifications Android natives, mails marqués d'un drapeau (seulement ceux qui appellent une réponse).

**Propositions de Claude** : le « Brief du matin » (recherche planifiée sur claude.ai, connecteur Microsoft 365)
dépose dans l'agenda Outlook des entrées « [Proposition Plannings] … » (7 h, 5 min, disponible ; 1re ligne du
corps = critères en JSON, puis « Pourquoi : … »). Plannings les affiche dans « Claude vous propose » ; acceptées,
modifiées ou refusées, elles sont retirées d'Outlook. (Un fichier `propositions.json` du dépôt de données est aussi lu.)

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
