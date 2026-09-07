// Prueft die Bridge gegen eine Arena-Attrappe.
//   node werkzeuge/bridge-test.js
//
// Die echte Arena hoert nur auf localhost des Medien-PCs; von hier aus ist sie
// nicht erreichbar. Was sich trotzdem ohne sie pruefen laesst, ist das
// Verhalten der Bridge — und das ist der Teil, der am Veranstaltungsabend
// unbeaufsichtigt laufen muss:
//
//   * findet sie die Parameter selbst (auch wenn Arena den Weg zu ihnen
//     verschiebt),
//   * ist die Reihenfolge eines Wechsels richtig (aus, warten, Text, ein),
//   * bleibt die Wand stehen, wenn der Server weg ist,
//   * findet sie sich wieder zurecht, wenn Arena neu geladen wird und alle
//     IDs neu vergibt.
//
// Was hier NICHT geprueft werden kann: ob es an der echten Wand flackert und
// wie schnell Arena wirklich reagiert. Das ist die Vollprobe vor Ort.

const fs = require('fs');
const http = require('http');

process.env.DB_PFAD = '/tmp/bridge-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
process.env.STANDZEIT = '5';          // kurz, damit im Test ueberhaupt gewechselt wird
process.env.PORT = process.env.PORT || '3997';
process.env.HOST = '127.0.0.1';
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { abfragen } = require('../src/db');
const { FLAECHEN } = require('../src/flaechen');
const { start, fastify } = require('../src/server');
const bridge = require('../bridge/bridge');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + zusatz : ''));
}
const schlaf = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------- Arena-Attrappe
//
// Sie tut so wenig wie moeglich: Komposition ausliefern, Parameter annehmen,
// mitschreiben. `weg` bestimmt, unter welchem Pfad sie die Parameter anbietet
// — damit laesst sich die Pfadprobe der Bridge nachstellen.

function attrappe ({ weg = 'composition/parameter/by-id', idVersatz = 0 } = {}) {
  const zustand = { weg, idVersatz, ereignisse: [], kompositionAbrufe: 0 };

  const komposition = () => ({
    name: { value: 'Königsbau_2026' },
    // Ein bisschen Beiwerk, damit die Suche etwas zu unterscheiden hat.
    master: { id: 1, value: 1 },
    layers: [
      { name: { value: 'MESSAGES' },
        clips: [ { video: { effects: [
          { name: { value: 'FVG Message Wall v2' },
            params: Object.fromEntries([
              ...FLAECHEN.map(f => [
                String(f.nr).padStart(2, '0') + ' ' + f.name,
                { id: 5000 + zustand.idVersatz + f.nr, value: '' }
              ]),
              ...FLAECHEN.map(f => [
                'Blende ' + String(f.nr).padStart(2, '0'),
                { id: 6000 + zustand.idVersatz + f.nr, value: 1 }
              ]),
              ['Schrifthoehe max', { id: 7001, value: 40 }],
              ['Opacity', { id: 7002, value: 1 }]
            ]) }
        ] } } ] }
    ]
  });

  const dienst = http.createServer((anfrage, antwort) => {
    const url = anfrage.url.replace(/^\/api\/v1\//, '');
    if (url === 'composition') {
      zustand.kompositionAbrufe++;
      antwort.writeHead(200, { 'content-type': 'application/json' });
      return antwort.end(JSON.stringify(komposition()));
    }
    const treffer = new RegExp('^' + zustand.weg + '/(\\d+)$').exec(url);
    if (!treffer) { antwort.writeHead(404); return antwort.end(); }
    const id = Number(treffer[1]);
    // Nach einem Neuladen des Effekts gibt es die alten IDs nicht mehr.
    const bekannt = (id > 6000 ? id - 6000 : id - 5000) - zustand.idVersatz;
    if (bekannt < 1 || bekannt > FLAECHEN.length) { antwort.writeHead(404); return antwort.end(); }
    if (anfrage.method === 'GET') {
      antwort.writeHead(200, { 'content-type': 'application/json' });
      return antwort.end(JSON.stringify({ id, value: 1 }));
    }
    let rumpf = '';
    anfrage.on('data', d => { rumpf += d; });
    anfrage.on('end', () => {
      zustand.ereignisse.push({ zeit: Date.now(), id, wert: JSON.parse(rumpf || '{}').value });
      antwort.writeHead(200, { 'content-type': 'application/json' });
      antwort.end('{}');
    });
  });

  zustand.starten = () => new Promise(r => dienst.listen(0, '127.0.0.1', () => r(dienst.address().port)));
  zustand.schliessen = () => new Promise(r => dienst.close(r));
  zustand.textIdFuer = nr => 5000 + zustand.idVersatz + nr;
  zustand.blendeIdFuer = nr => 6000 + zustand.idVersatz + nr;
  return zustand;
}

const BASIS = 'http://127.0.0.1:' + process.env.PORT;

(async () => {
  // Vorrat, damit der Scheduler etwas zu verteilen hat.
  for (let i = 0; i < 60; i++) {
    abfragen.einfuegen.run({
      text: 'Probebotschaft ' + i, name: null, status: 'freigegeben', filter: null,
      token: 'probe-' + i, geraet: 'g' + i,
      erstellt_am: Date.now() - (100 - i), entschieden_am: Date.now(), unsicher: 0
    });
  }
  await start();

  console.log('\nErstabgleich: alles einmal hinschreiben');
  const arena = attrappe();
  const arenaPort = await arena.starten();
  const lauf = bridge.starten({
    server: BASIS, arena: `http://127.0.0.1:${arenaPort}/api/v1`,
    taktMs: 200, blendeMs: 350, ruhig: true
  });
  await schlaf(1500);
  {
    const texte = arena.ereignisse.filter(e => e.id > 5000 && e.id < 6000);
    const blenden = arena.ereignisse.filter(e => e.id > 6000);
    pruefe('jede Flaeche hat einen Text bekommen',
      new Set(texte.map(e => e.id)).size === FLAECHEN.length, new Set(texte.map(e => e.id)).size);
    pruefe('und jede eine Blende', new Set(blenden.map(e => e.id)).size === FLAECHEN.length,
      new Set(blenden.map(e => e.id)).size);
    pruefe('belegte Flaechen stehen auf sichtbar',
      blenden.some(e => e.wert === 1) && texte.some(e => e.wert !== ''));
    pruefe('leere Flaechen bleiben dunkel statt weiss zu blitzen',
      arena.ereignisse.filter(e => e.id > 6000 && e.wert === 0).length ===
      arena.ereignisse.filter(e => e.id > 5000 && e.id < 6000 && e.wert === '').length);
    pruefe('die Komposition wurde genau einmal gelesen', arena.kompositionAbrufe === 1,
      arena.kompositionAbrufe);
  }

  console.log('\nEin Wechsel: aus, warten, Text, ein');
  {
    // Warten, bis der Erstabgleich wirklich durch ist — er schreibt 66 Werte
    // nacheinander und wuerde sich sonst mit dem ersten Wechsel mischen.
    while (arena.ereignisse.length < FLAECHEN.length * 2) await schlaf(100);
    const vorher = arena.ereignisse.length;
    await schlaf(6000);   // eine Standzeit — der Scheduler wechselt von selbst
    const neu = arena.ereignisse.slice(vorher);
    pruefe('es wurde ueberhaupt gewechselt', neu.length > 0, neu.length);

    // Ein Wechsel beginnt immer mit einer Blende auf 0 — daran ist er zu
    // erkennen, und nur dahinter darf der neue Text stehen.
    const aus = neu.find(e => e.id > 6000 && e.wert === 0);
    const nr = aus ? aus.id - 6000 - arena.idVersatz : 0;
    const danach = neu.filter(e => e.zeit >= (aus ? aus.zeit : 0) &&
      (e.id === arena.textIdFuer(nr) || e.id === arena.blendeIdFuer(nr)));
    const text = danach.find(e => e.id === arena.textIdFuer(nr));
    const ein = danach.find(e => e.id === arena.blendeIdFuer(nr) && e.wert === 1);
    pruefe('erst ausgeblendet, dann Text, dann eingeblendet',
      aus && text && ein && aus.zeit <= text.zeit && text.zeit <= ein.zeit,
      JSON.stringify(danach.map(e => [e.id, e.wert])));
    pruefe('zwischen Ausblenden und Textwechsel liegt die Blendenzeit',
      text && text.zeit - aus.zeit >= 340, text && text.zeit - aus.zeit);
    pruefe('der Text wird nur einmal geschrieben',
      danach.filter(e => e.id === arena.textIdFuer(nr)).length === 1,
      JSON.stringify(danach.map(e => [e.id, e.wert])));
  }

  console.log('\nServer weg: die Wand behaelt ihren Stand');
  {
    const tot = bridge.starten({
      server: 'http://127.0.0.1:1', arena: `http://127.0.0.1:${arenaPort}/api/v1`,
      taktMs: 200, ruhig: true
    });
    await schlaf(1200);
    pruefe('die Bridge laeuft weiter statt zu sterben', tot.zahlen.serverFehler > 0,
      tot.zahlen.serverFehler);
    pruefe('und schreibt nichts nach Arena', tot.zahlen.wechsel === 0);
    await tot.stoppen();
  }

  console.log('\nArena neu geladen: neue IDs, alte laufen ins Leere');
  {
    const vorher = arena.ereignisse.length;
    arena.idVersatz = 100;                   // wie nach "effect add/remove" in Arena
    await schlaf(4000);
    const neu = arena.ereignisse.slice(vorher);
    pruefe('die Komposition wurde erneut gelesen', arena.kompositionAbrufe > 1,
      arena.kompositionAbrufe);
    pruefe('es kommt wieder etwas an', neu.length > 0, neu.length);
    pruefe('und zwar unter den neuen IDs', neu.every(e => e.id > 5100),
      JSON.stringify(neu.slice(0, 3)));
  }

  await lauf.stoppen();
  await arena.schliessen();

  console.log('\nArena bietet die Parameter unter dem anderen Weg an');
  {
    const zweite = attrappe({ weg: 'parameter/by-id' });
    const port = await zweite.starten();
    const lauf2 = bridge.starten({
      server: BASIS, arena: `http://127.0.0.1:${port}/api/v1`,
      taktMs: 200, ruhig: true
    });
    await schlaf(1500);
    pruefe('die Bridge findet den Weg selbst', zweite.ereignisse.length > 0,
      zweite.ereignisse.length);
    await lauf2.stoppen();
    await zweite.schliessen();
  }

  await fastify.close();
  console.log(fehler ? `\n${fehler} Fehler\n` : '\nAlles gruen\n');
  process.exit(fehler ? 1 : 0);
})();
