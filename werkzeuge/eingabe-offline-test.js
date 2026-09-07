// Die Eingabeseite im Funkloch — mit echtem Browser, echtem Offline-Zustand.
//   node werkzeuge/eingabe-offline-test.js
//
// Auf einem vollen Schlossplatz ist der wahrscheinlichste Fehler nicht ein
// Programmfehler, sondern ein weggebrochenes Mobilfunknetz im Moment des
// Absendens. Playwright kann den Browser wirklich offline schalten — damit
// laesst sich pruefen, was der Absender dann sieht und ob seine Botschaft
// ueberlebt.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/eingabe-offline-test.db';
process.env.PORT = process.env.PORT || '3995';
process.env.HOST = '127.0.0.1';
process.env.STANDZEIT = '25';
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { chromium } = require('playwright');
const { db } = require('../src/db');
const { fastify, start } = require('../src/server');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + zusatz : ''));
}
const BASIS = 'http://127.0.0.1:' + process.env.PORT;
const zaehlen = () => db.prepare('SELECT count(*) n FROM botschaften').get().n;

(async () => {
  await start();
  const browser = await chromium.launch();
  const kontext = await browser.newContext();
  const seite = await kontext.newPage();
  const konsole = [];
  seite.on('pageerror', e => konsole.push('Skriptfehler: ' + e.message));

  console.log('\nAbschicken ohne Netz');
  {
    await seite.goto(BASIS + '/', { waitUntil: 'networkidle' });
    await seite.fill('#text', 'Grüße vom Schlossplatz an alle');
    await kontext.setOffline(true);
    await seite.click('#senden');

    await seite.waitForFunction(() => /nachgeschickt/.test(document.getElementById('fehler').textContent));
    pruefe('der Absender sieht, dass nachgeschickt wird',
      /Versuch 2 von 4/.test(await seite.locator('#fehler').textContent()),
      await seite.locator('#fehler').textContent());
    pruefe('nichts ist angekommen', zaehlen() === 0, zaehlen());
    pruefe('der Entwurf liegt auf dem Gerät',
      await seite.evaluate(() => !!JSON.parse(localStorage.getItem('entwurf') || 'null')));
  }

  console.log('\nDas Netz kommt zurueck');
  {
    await kontext.setOffline(false);
    // Der Browser meldet online — die Seite schickt von selbst nach.
    await seite.waitForURL(/\/status\?t=/, { timeout: 20000 });
    pruefe('die Botschaft ist durch', zaehlen() === 1, zaehlen());
    pruefe('und der Absender steht auf seiner Statusseite', /\/status/.test(seite.url()), seite.url());
    pruefe('der Entwurf ist weggeräumt',
      await seite.evaluate(() => localStorage.getItem('entwurf') === null));
  }

  console.log('\nEin verlorener Rueckweg legt nichts doppelt an');
  {
    // Die Antwort des Servers unterwegs wegwerfen: fuer den Browser sieht das
    // aus wie ein Netzfehler, der Server hat die Botschaft aber schon.
    // Eigener Browserkontext: ein anderes Handy, also eigener Speicher und
    // keine Geraetesperre von vorhin.
    const kontext2 = await browser.newContext();
    const zweite = await kontext2.newPage();
    await zweite.goto(BASIS + '/', { waitUntil: 'networkidle' });

    let ersteAnfrage = true;
    await zweite.route('**/api/botschaft', async (weg) => {
      if (ersteAnfrage) {
        ersteAnfrage = false;
        await weg.fetch();          // Server bekommt sie
        await weg.abort('failed');  // Antwort geht "verloren"
        return;
      }
      await weg.continue();
    });

    const vorher = zaehlen();
    await zweite.fill('#text', 'Der Rueckweg geht verloren');
    await zweite.click('#senden');
    await zweite.waitForURL(/\/status\?t=/, { timeout: 20000 });
    pruefe('die Botschaft steht genau einmal da', zaehlen() === vorher + 1, zaehlen() - vorher);
    pruefe('und der Absender landet trotzdem auf seiner Statusseite',
      /\/status/.test(zweite.url()), zweite.url());
    pruefe('keine Sperrmeldung statt der Botschaft',
      !/Kurz durchatmen/.test(await zweite.content()));
  }

  console.log('\nKonsole');
  pruefe('keine Skriptfehler', konsole.length === 0, konsole.slice(0, 2).join(' | '));

  await browser.close();
  await fastify.close();
  console.log(fehler ? `\n${fehler} Fehler\n` : '\nAlles gruen\n');
  process.exit(fehler ? 1 : 0);
})();
