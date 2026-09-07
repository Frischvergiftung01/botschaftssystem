// Prueft die Monitoring-Seite fuer den FOH mit echtem Browser.
//   node werkzeuge/monitor-test.js
//
// Die Seite selbst kann nichts kaputt machen — sie zeigt nur an. Ihr Wert
// haengt deshalb an genau zwei Dingen: dass sie ohne Anmeldung NICHT zu sehen
// ist, und dass sie im Ernstfall das Richtige sagt. Beides wird hier
// nachgestellt, indem der Zustand des Systems veraendert und nachgesehen
// wird, was auf den Kacheln steht.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/monitor-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
process.env.STANDZEIT = '25';
process.env.PORT = process.env.PORT || '3996';
process.env.HOST = '127.0.0.1';
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { chromium } = require('playwright');
const { fastify, start } = require('../src/server');
const einstellungen = require('../src/einstellungen');
const puls = require('../src/puls');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + zusatz : ''));
}
const BASIS = 'http://127.0.0.1:' + process.env.PORT;
const text = (seite, w) => seite.locator(w).textContent();
const klasse = (seite, w) => seite.locator(w).getAttribute('class');

(async () => {
  await start();
  const browser = await chromium.launch();
  const kontext = await browser.newContext();
  const seite = await kontext.newPage();
  const konsole = [];
  seite.on('console', m => { if (m.type() === 'error') konsole.push(m.text()); });
  seite.on('pageerror', e => konsole.push('Skriptfehler: ' + e.message));

  console.log('\nOhne Anmeldung bleibt sie zu');
  {
    const roh = await kontext.request.get(BASIS + '/moderation/monitor', { maxRedirects: 0 });
    pruefe('Aufruf ohne Kennwort fuehrt nicht zur Seite', roh.status() >= 300 && roh.status() < 400,
      roh.status());
  }

  await kontext.request.post(BASIS + '/api/moderation/anmelden', { data: { kennwort: 'probe-kennwort-2026' } });

  console.log('\nDer Normalfall vor dem Abend');
  {
    await seite.goto(BASIS + '/moderation/monitor', { waitUntil: 'networkidle' });
    await seite.waitForFunction(() => document.getElementById('wFassade').textContent !== '–');
    pruefe('die Fassade wird gezaehlt', /\d+ \/ 33/.test(await text(seite, '#wFassade')),
      await text(seite, '#wFassade'));
    pruefe('leere Wand faellt auf', (await klasse(seite, '#kFassade')).includes('schlecht'),
      await klasse(seite, '#kFassade'));
    pruefe('und sagt, was zu tun ist', /Füllsel|Runde|freigegeben/.test(await text(seite, '#rFassade')),
      await text(seite, '#rFassade'));
    pruefe('ohne Bridge steht "keine"', (await text(seite, '#wBridge')) === 'keine',
      await text(seite, '#wBridge'));
    pruefe('mit dem Rat, sie zu starten', /start-bridge/.test(await text(seite, '#rBridge')),
      await text(seite, '#rBridge'));
    pruefe('ohne Spielzeiten heisst es "kein Plan"', (await text(seite, '#wRunde')) === 'kein Plan',
      await text(seite, '#wRunde'));
  }

  console.log('\nEin Puls der Bridge kommt an');
  {
    puls.melden({ wechsel: 12, arenaFehler: 0, serverFehler: 0, layer: 6, spalte: 1, clipLaeuft: true, flaechen: 33 });
    await seite.waitForFunction(() => document.getElementById('wBridge').textContent === 'läuft');
    pruefe('die Kachel wird gruen', (await klasse(seite, '#kBridge')).includes('gut'),
      await klasse(seite, '#kBridge'));
    pruefe('Wechsel und Lage stehen dabei',
      /12 Wechsel/.test(await text(seite, '#dBridge')) && /Layer 6/.test(await text(seite, '#dBridge')),
      await text(seite, '#dBridge'));
  }

  console.log('\nEntriggerter Clip ist ein Hinweis, kein Alarm');
  {
    puls.melden({ wechsel: 20, arenaFehler: 0, serverFehler: 0, layer: 6, spalte: 1, clipLaeuft: false, flaechen: 33 });
    await seite.waitForFunction(() => document.getElementById('wBridge').textContent === 'Clip aus');
    pruefe('gelb statt rot', (await klasse(seite, '#kBridge')).includes('gold'),
      await klasse(seite, '#kBridge'));
    pruefe('und der Grund steht dabei', /während der Show normal/.test(await text(seite, '#rBridge')),
      await text(seite, '#rBridge'));
  }

  console.log('\nUmgelegte Schalter faellt man ins Auge');
  {
    einstellungen.setzen('nachschub', false);
    await seite.waitForFunction(() => /angehalten/.test(document.getElementById('rSchalter').textContent));
    pruefe('die Schalterkachel wird rot', (await klasse(seite, '#kSchalter')).includes('schlecht'),
      await klasse(seite, '#kSchalter'));
    einstellungen.setzen('nachschub', true);

    einstellungen.setzen('einrichtung', true);
    await seite.waitForFunction(() => /Einrichtungsmodus läuft/.test(document.getElementById('rSchalter').textContent));
    pruefe('der Einrichtungsmodus wird ausdruecklich genannt',
      /Flächennamen/.test(await text(seite, '#rSchalter')), await text(seite, '#rSchalter'));
    einstellungen.setzen('einrichtung', false);
  }

  console.log('\nKonsole');
  {
    await seite.waitForTimeout(2500);   // zwei Abfragezyklen
    pruefe('keine Skriptfehler', konsole.length === 0, konsole.slice(0, 3).join(' | '));
  }

  await browser.close();
  await fastify.close();
  console.log(fehler ? `\n${fehler} Fehler\n` : '\nAlles gruen\n');
  process.exit(fehler ? 1 : 0);
})();
