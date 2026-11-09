// Copie l'application web (racine du dépôt, aussi publiée par GitHub Pages) dans www/,
// le dossier embarqué dans l'application Android.
const fs = require('fs');
const path = require('path');
const items = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'vendor'];
fs.rmSync('www', { recursive: true, force: true });
fs.mkdirSync('www', { recursive: true });
for (const it of items) fs.cpSync(it, path.join('www', it), { recursive: true });
console.log('www/ prêt :', items.join(', '));
