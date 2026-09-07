// Prueft die Fuellsel — eigene Texte, die Luecken schliessen.
//   node werkzeuge/fuellsel-test.js
//
// Drei Dinge muessen stimmen, und zwei davon sind Verzicht:
//   1. Sie fuellen, was sonst dunkel bliebe.
//   2. Sie verdraengen nie eine Botschaft — auch nicht, wenn sie besser
//      passen wuerden.
//   3. Sie faerben die Kennzahlen des Abends nicht. Am Ende soll dastehen,
//      was wirklich aus dem Publikum kam.
// Dazu der Deckel: hoechstens ein Drittel der Wand.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/fuellsel-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
process.env.STANDZEIT = '5';
process.env.LOG_LEVEL = 'silent';
process.env.MISTRAL_API_KEY = '';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const cfg = require('../src/config');
const { db, abfragen } = require('../src/db');
const { FLAECHEN } = require('../src/flaechen');
const scheduler = require('../src/scheduler');
const fuellsel = require('../src/fuellsel');
const moderation = require('../src/moderation');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + zusatz : ''));
}
const schlaf = ms => new Promise(r => setTimeout(r, ms));
async function takte (n = 40) {
  for (let i = 0; i < n; i++) { scheduler.takt(); await schlaf(90); }
}
const zaehlen = t => db.prepare('SELECT count(*) n FROM ' + t).get().n;
const belegt = () => scheduler.anzeige().filter(f => f.text);

(async () => {
  console.log('\nVorbereitete Plaetze');
  {
    const stand = fuellsel.stand();
    pruefe('beim ersten Aufschlag stehen Vorschlaege bereit', stand.zeilen.length > 0, stand.zeilen.length);
    pruefe('und alle sind AUS — nichts erscheint versehentlich',
      stand.zeilen.every(z => !z.aktiv) && stand.aktive === 0);
    pruefe('der Deckel steht dabei', stand.deckel === cfg.fuellselDeckel, stand.deckel);
  }

  console.log('\nOhne Fuellsel bleibt die Wand leer');
  {
    await takte(12);
    pruefe('nichts freigegeben, nichts zu sehen', belegt().length === 0, belegt().length);
  }

  console.log('\nMit Fuellsel fuellt sich die Luecke — bis zum Deckel');
  {
    fuellsel.aktivSetzen(1, true);
    fuellsel.aktivSetzen(2, true);
    fuellsel.aktivSetzen(3, true);
    await takte(60);
    const f = belegt();
    pruefe('es steht etwas da', f.length > 0, f.length);
    pruefe('und es ist als Fuellsel gekennzeichnet', f.every(x => x.fuellsel === true));
    pruefe('hoechstens der Deckel', f.length <= cfg.fuellselDeckel, f.length);
    pruefe('keine Zeile in anzeigen', zaehlen('anzeigen') === 0, zaehlen('anzeigen'));
    pruefe('keine Botschaft entstanden', zaehlen('botschaften') === 0, zaehlen('botschaften'));
    pruefe('die Kennzahlen weisen es getrennt aus',
      moderation.kennzahlen().fuellsel.aufFlaechen === f.length,
      JSON.stringify(moderation.kennzahlen().fuellsel));
    pruefe('gezaehlt wird in der eigenen Tabelle',
      fuellsel.stand().zeilen.reduce((n, z) => n + z.anzahlAnzeigen, 0) > 0);
  }

  console.log('\nEine echte Botschaft geht vor');
  {
    for (let i = 0; i < 40; i++) {
      abfragen.einfuegen.run({
        text: 'Probebotschaft ' + i, name: null, status: 'freigegeben', filter: null,
        token: 'p-' + i, geraet: 'g' + i,
        erstellt_am: Date.now() - (100 - i), entschieden_am: Date.now(), unsicher: 0
      });
    }
    await takte(120);
    const f = belegt();
    const echte = f.filter(x => !x.fuellsel).length;
    pruefe('die Wand füllt sich mit Botschaften', echte > cfg.fuellselDeckel, echte);
    pruefe('Fuellsel weichen, sobald Botschaften da sind',
      f.filter(x => x.fuellsel).length < cfg.fuellselDeckel,
      f.filter(x => x.fuellsel).length);
    pruefe('jetzt zaehlen die Anzeigen wieder', zaehlen('anzeigen') > 0);
  }

  console.log('\nEin zu langer Text fuellt keine schmale Saeule');
  {
    const lang = 'Dies ist ein sehr langer Fuellseltext, der auf einer schmalen Kolonnadensaeule niemals lesbar sein kann';
    pruefe('er passt nirgends oder nur auf die breiten Flaechen',
      fuellsel.passendeFlaechen(lang) < FLAECHEN.length, fuellsel.passendeFlaechen(lang));
    const schmal = FLAECHEN.find(f => f.breite === 437);
    fuellsel.speichern([{ text: lang, aktiv: true }]);
    pruefe('und wird fuer die schmale Saeule nicht angeboten',
      fuellsel.naechsterFuer(schmal) === null);
    const breit = FLAECHEN.find(f => f.nr === 1);
    const treffer = fuellsel.naechsterFuer(breit);
    pruefe('fuer die Stirnseite Mitte dagegen schon', treffer !== null && treffer.text === lang);
  }

  console.log('\nLeere Plaetze lassen sich nicht aktivieren');
  {
    fuellsel.speichern([{ text: '', aktiv: false }]);
    let gemeckert = false;
    try { fuellsel.aktivSetzen(1, true); } catch { gemeckert = true; }
    pruefe('ein leerer Platz wird abgewiesen', gemeckert);
    let zuLang = false;
    try { fuellsel.speichern([{ text: 'x'.repeat(cfg.maxZeichenFuellsel + 1), aktiv: true }]); } catch { zuLang = true; }
    pruefe('und ein zu langer Text auch', zuLang);
  }

  console.log(fehler ? `\n${fehler} Fehler\n` : '\nAlles gruen\n');
  process.exit(fehler ? 1 : 0);
})();
