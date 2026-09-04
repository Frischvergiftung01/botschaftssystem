// Füllt die Moderationsqueue für die Durchsatzprobe (Abnahme Block 5:
// 500 Entscheidungen je Stunde mit einer Person).
//
// Aufruf: node werkzeuge/queue-fuellen.js 300
//
// Die Botschaften gehen NICHT durch die Filterkette — es geht um das Tempo der
// Oberfläche, nicht um die Trefferquote des Filters. Etwa jede fünfte ist als
// Grenzfall markiert, damit die Mischung dem Abend ähnelt.
const crypto = require('crypto');
const { abfragen } = require('../src/db');

const anzahl = Number(process.argv[2] || 200);

const ANFAENGE = ['Grüße an', 'Alles Liebe für', 'Danke an', 'Hallo', 'Ein Hoch auf', 'Wir denken an'];
const ZIELE = ['Oma und Opa', 'die Nachtschicht', 'alle daheim', 'Mama', 'die Kickers-Fans', 'Stuttgart',
  'meine Schwester', 'das Team vom Schlossplatz', 'Lena und Ben', 'die beste Klasse 7b'];
const NAMEN = [null, 'Lena', 'Ben', 'Mia', 'Jörg', null, 'Sara', null];
const zufall = a => a[Math.floor(Math.random() * a.length)];

let n = 0;
const jetzt = Date.now();
for (let i = 0; i < anzahl; i++) {
  const unsicher = Math.random() < 0.2 ? 1 : 0;
  abfragen.einfuegen.run({
    text: `${zufall(ANFAENGE)} ${zufall(ZIELE)}`,
    name: zufall(NAMEN),
    status: 'neu',
    filter: JSON.stringify({
      urteil: unsicher ? 'PRUEFEN' : 'FREI',
      stufe1a: { urteil: unsicher ? 'PRUEFEN' : 'FREI', gruende: unsicher ? [{ regel: 'probe', rang: 'weich', treffer: 'Übungsfall' }] : [] },
      stufe1b: null
    }),
    token: crypto.randomBytes(9).toString('base64url'),
    geraet: 'probe',
    erstellt_am: jetzt - Math.round(Math.random() * 900000),
    entschieden_am: null,
    unsicher
  });
  n++;
}
console.log(`${n} Botschaften in die Moderationsqueue gelegt. Jetzt /moderation öffnen und die Stoppuhr laufen lassen.`);
