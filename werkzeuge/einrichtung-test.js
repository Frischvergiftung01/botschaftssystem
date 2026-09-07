// Prueft den Einrichtungsmodus.
//   node werkzeuge/einrichtung-test.js
//
// Die eigentliche Anforderung ist nicht, dass Namen erscheinen — das waere
// leicht. Sie ist, dass dabei NICHTS entsteht: keine Botschaft, keine Zeile in
// `anzeigen`, keine hochgezaehlte Anzeige. Sonst stuenden am Ende des Abends
// Botschaften in der Statistik, die nie jemand gesehen hat, und im
// schlimmsten Fall waeren Einrichtungstexte selbst Botschaften geworden.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/einrichtung-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
process.env.STANDZEIT = '5';
process.env.LOG_LEVEL = 'silent';
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { db, abfragen } = require('../src/db');
const { FLAECHEN, einrichtungName } = require('../src/flaechen');
const scheduler = require('../src/scheduler');
const einstellungen = require('../src/einstellungen');
const { fastify } = require('../src/server');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + zusatz : ''));
}
const schlaf = ms => new Promise(r => setTimeout(r, ms));
const anzeige = async () => (await fastify.inject({ method: 'GET', url: '/api/anzeige' })).json();
const zaehlen = t => db.prepare('SELECT count(*) n FROM ' + t).get().n;
async function takte (n = 6) {
  for (let i = 0; i < n; i++) { scheduler.takt(); await schlaf(420); }
}

for (let i = 0; i < 40; i++) {
  abfragen.einfuegen.run({
    text: 'Probebotschaft ' + i, name: null, status: 'freigegeben', filter: null,
    token: 'probe-' + i, geraet: 'g' + i,
    erstellt_am: Date.now() - (100 - i), entschieden_am: Date.now(), unsicher: 0
  });
}

(async () => {
  console.log('\nNormalbetrieb zuerst');
  await takte();
  const belegtVorher = (await anzeige()).flaechen.filter(f => f.text).length;
  pruefe('die Fassade zeigt Botschaften', belegtVorher > 0, belegtVorher);

  const botschaftenVorher = zaehlen('botschaften');
  const anzeigenVorher = zaehlen('anzeigen');

  console.log('\nEinrichtungsmodus an');
  einstellungen.setzen('einrichtung', true);
  {
    const a = await anzeige();
    pruefe('die Auslieferung sagt es an', a.einrichtung === true);
    pruefe('alle 33 Flächen sind beschriftet',
      a.flaechen.length === FLAECHEN.length && a.flaechen.every(f => f.text), a.flaechen.length);
    pruefe('und zwar mit dem eigenen Namen',
      a.flaechen.every(f => f.text === einrichtungName(FLAECHEN.find(x => x.nr === f.nr))),
      JSON.stringify(a.flaechen.slice(0, 2).map(f => f.text)));
    pruefe('die Kolonnaden heißen wie im Patch',
      a.flaechen.find(f => f.nr === 17).text === '17 Mitte 01',
      a.flaechen.find(f => f.nr === 17).text);
    pruefe('Schriftmaße kommen mit — der Simulator zeigt dasselbe',
      a.flaechen.every(f => typeof f.versalhoehe === 'number' && f.versalhoehe > 0));
    pruefe('der Nachschub ruht', scheduler.nachladenErlaubt() === false);
  }

  console.log('\nEs entsteht nichts');
  await takte(8);
  {
    pruefe('keine neue Botschaft', zaehlen('botschaften') === botschaftenVorher,
      zaehlen('botschaften') + ' statt ' + botschaftenVorher);
    pruefe('keine neue Anzeige gezählt', zaehlen('anzeigen') === anzeigenVorher,
      zaehlen('anzeigen') + ' statt ' + anzeigenVorher);
    pruefe('kein Flächenname taucht als Botschaft auf',
      !db.prepare("SELECT 1 FROM botschaften WHERE text LIKE '%Mitte 01%'").get());
    const a = await anzeige();
    pruefe('und die Fassade zeigt weiterhin Namen',
      a.flaechen.every(f => /^\d\d /.test(f.text)));
  }

  console.log('\nEinrichtungsmodus aus');
  einstellungen.setzen('einrichtung', false);
  scheduler.planVerwerfen();
  {
    const a = await anzeige();
    pruefe('die Auslieferung ist wieder normal', a.einrichtung === false);
    pruefe('der Nachschub läuft wieder', scheduler.nachladenErlaubt() === true);
    // Was vor dem Einrichten stand, ist inzwischen abgelaufen — waehrend des
    // Einrichtens wird ja nichts nachgeladen. Verlangt ist deshalb nicht, dass
    // die alten Botschaften wieder auftauchen, sondern dass sich die Fassade
    // von selbst wieder fuellt.
    await takte(8);
    const b = await anzeige();
    const echte = b.flaechen.filter(f => f.text && !/^\d\d /.test(f.text)).length;
    pruefe('die Fassade füllt sich von selbst wieder mit Botschaften',
      echte >= belegtVorher, echte + ' belegt, vorher ' + belegtVorher);
    pruefe('und kein Flächenname ist mehr dabei',
      !b.flaechen.some(f => /^\d\d /.test(f.text || '')));
  }

  console.log('\nDer Schalter überlebt einen Neustart');
  {
    einstellungen.setzen('einrichtung', true);
    einstellungen.vergessen();               // wie ein frischer Prozess
    pruefe('er steht in der Datenbank', einstellungen.schalter().einrichtung === true);
    einstellungen.setzen('einrichtung', false);
  }

  await fastify.close();
  console.log(fehler ? `\n${fehler} Fehler\n` : '\nAlles gruen\n');
  process.exit(fehler ? 1 : 0);
})();
