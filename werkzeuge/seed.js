// Füllt die Datenbank mit Beispielbotschaften, damit der Simulator etwas zu tun hat.
// Aufruf: npm run seed
const crypto = require('crypto');
const { abfragen } = require('../src/db');

const beispiele = [
  ['Hallo Stuttgart!', null],
  ['Beste Stimmung hier, ich liebe es.', null],
  ['Grüße an Oma und Opa in Bad Cannstatt', 'Lena'],
  ['Wir feiern heute unseren zehnten Jahrestag', 'Tim'],
  ['Danke, Papa', 'Mia'],
  ['WAHNSINN, WAS FÜR EIN ABEND', null],
  ['Alles Gute zum Geburtstag, Jörg!', null],
  ['Ich liebe dich, Mama', 'Paul'],
  ['Stuttgart, du leuchtest', null],
  ['Grüße vom Schlossplatz an alle daheim', 'Sara'],
  ['Für Püppi — du fehlst uns', null],
  ['Endlich wieder hier', 'Ben'],
  ['Wir schicken euch Licht vom Schlossplatz und ganz viel Liebe an alle, die heute nicht dabei sein können', null],
  ['Danke an alle, die diesen Abend möglich machen', null],
  ['Hallo Oma!', null],
  ['Guten Abend, Königsbau', null]
];

let n = 0;
for (const [text, name] of beispiele) {
  const jetzt = Date.now() - Math.round(Math.random() * 600000);
  abfragen.einfuegen.run({
    text, name, status: 'freigegeben',
    token: crypto.randomBytes(9).toString('base64url'),
    geraet: 'seed', erstellt_am: jetzt, entschieden_am: jetzt
  });
  n++;
}
console.log(`${n} Beispielbotschaften eingetragen.`);
