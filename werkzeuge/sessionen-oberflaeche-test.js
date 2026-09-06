// Rauchprobe der Moderationsoberflaeche mit echtem Browser.
//   node werkzeuge/sessionen-oberflaeche-test.js
//
// Die teuerste Panne dieses Umbaus waere ein Skriptfehler, der die ganze
// Moderationsseite lahmlegt — dann steht am Veranstaltungsabend die
// Warteschlange still. Deshalb wird hier vor allem darauf geachtet, dass die
// Seite ohne Fehler in der Konsole laedt und die Bedienung wirklich durchgeht:
// Zeiten erzeugen, speichern, starten, abbrechen.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/sessionen-oberflaeche-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
process.env.STANDZEIT = '25';
process.env.PORT = process.env.PORT || '3999';
process.env.HOST = '127.0.0.1';
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { chromium } = require('playwright');
const { fastify, start } = require('../src/server');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + zusatz : ''));
}

const BASIS = 'http://127.0.0.1:' + process.env.PORT;

/** Wartet, bis der Balken oben den erwarteten Text zeigt. */
async function balkenText (seite) {
  return (await seite.locator('#spielLage').textContent()).replace(/\s+/g, ' ').trim();
}

(async () => {
  await start();
  const browser = await chromium.launch();
  const kontext = await browser.newContext();
  const seite = await kontext.newPage();

  const konsole = [];
  seite.on('console', m => { if (m.type() === 'error') konsole.push(m.text()); });
  seite.on('pageerror', e => konsole.push('Skriptfehler: ' + e.message));
  seite.on('dialog', d => d.accept());

  console.log('\nAnmeldung und erster Aufschlag');
  {
    const a = await kontext.request.post(BASIS + '/api/moderation/anmelden', {
      data: { kennwort: 'probe-kennwort-2026' }
    });
    pruefe('Anmeldung klappt', a.ok(), a.status());

    await seite.goto(BASIS + '/moderation', { waitUntil: 'networkidle' });
    pruefe('die Seite ist die Moderation', await seite.locator('.marke').isVisible());
    pruefe('der Spielzeitenbalken ist da', await seite.locator('#spielbalken').isVisible());
    pruefe('ohne Plan sagt er das auch', /läuft durch/.test(await balkenText(seite)), await balkenText(seite));
    pruefe('kein Startknopf ohne Plan', await seite.locator('#spielStart').isHidden());
    pruefe('die Warteschlange steht noch', await seite.locator('#raster').isVisible());
  }

  console.log('\nZeiten erzeugen und speichern');
  {
    await seite.click('nav button[data-ansicht="spielzeiten"]');
    pruefe('der Reiter geht auf', await seite.locator('#spielzeiten').isVisible());
    pruefe('noch keine Zeile', (await seite.locator('.planzeile').count()) === 0);

    // Erste Runde endet in zwei Minuten, danach alle 30 Minuten.
    const jetzt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const ende = new Date(jetzt.getTime() + 2 * 60000);
    const hhmm = String(ende.getHours()).padStart(2, '0') + ':' + String(ende.getMinutes()).padStart(2, '0');

    await seite.fill('#genEnde', hhmm);
    await seite.fill('#genAnzahl', '3');
    await seite.fill('#genDauer', '17');
    await seite.click('#genKnopf');
    pruefe('drei Zeilen erzeugt', (await seite.locator('.planzeile').count()) === 3,
      await seite.locator('.planzeile').count());
    pruefe('Hinweis nennt den ungespeicherten Stand',
      /nicht gespeichert/.test(await seite.locator('#planStand').textContent()));

    await seite.click('#planSpeichern');
    await seite.waitForFunction(() => /gespeichert\./.test(document.getElementById('planStand').textContent));
    pruefe('gespeichert', /3 Runden gespeichert/.test(await seite.locator('#planStand').textContent()),
      await seite.locator('#planStand').textContent());

    const text = await balkenText(seite);
    pruefe('der Balken kennt jetzt die naechste Runde', /Runde 1/.test(text), text);
    pruefe('der Startknopf ist da', await seite.locator('#spielStart').isVisible());
    pruefe('er nennt die Restlaenge', /min\)/.test(await seite.locator('#spielStart').textContent()),
      await seite.locator('#spielStart').textContent());
  }

  console.log('\nGeaenderte Zeile ist als ungespeichert erkennbar');
  {
    // Der gemeldete Fall: Startzeit geaendert, der Balken zeigt weiter die
    // alte Zeit. Das ist richtig — er lebt vom gespeicherten Stand —, war
    // aber nicht zu sehen. Jetzt sagt es die Oberflaeche.
    const vorher = await balkenText(seite);
    // Neuer Anfang zehn Minuten vor dem Ende dieser Zeile — sonst laege er
    // dahinter und die Pruefung liefe in die Ablehnung statt in den Fall,
    // um den es hier geht.
    const bis = await seite.locator('.planzeile input').nth(1).inputValue();
    const [bh, bm] = bis.split(':').map(Number);
    const anfangMin = bh * 60 + bm - 10;
    const neuerAnfang = String(Math.floor(anfangMin / 60)).padStart(2, '0')
      + ':' + String(anfangMin % 60).padStart(2, '0');
    await seite.fill('.planzeile input >> nth=0', neuerAnfang);
    pruefe('Hinweis erscheint sofort',
      /nicht gespeichert/.test(await seite.locator('#planStand').textContent()),
      await seite.locator('#planStand').textContent());
    pruefe('der Speichernknopf faellt auf',
      await seite.locator('#planSpeichern.offen').count() === 1);
    pruefe('das Feld ist markiert',
      await seite.locator('.planzeile input.offen').count() >= 1);
    pruefe('der Balken zeigt noch den gespeicherten Stand', (await balkenText(seite)) === vorher);

    await seite.click('#planSpeichern');
    await seite.waitForFunction(() => /Runden gespeichert/.test(document.getElementById('planStand').textContent));
    pruefe('nach dem Speichern ist der Hinweis weg',
      await seite.locator('#planSpeichern.offen').count() === 0);
    const nachher = await balkenText(seite);
    pruefe('und der Balken zieht nach', nachher.includes(neuerAnfang), nachher + ' erwartet ' + neuerAnfang);
  }

  console.log('\nStandzeit laesst sich im Betrieb verstellen');
  {
    const feld = seite.locator('#standzeitFeld');
    pruefe('das Feld zeigt den laufenden Wert', (await feld.inputValue()) === '25', await feld.inputValue());
    await seite.fill('#standzeitFeld', '40');
    await seite.click('#standzeitKnopf');
    await seite.waitForFunction(() => /Übernommen/.test(document.getElementById('standzeitStand').textContent));
    pruefe('die Folge fuers Auslaufen steht dabei',
      /40 Sekunden vor dem eingetragenen Ende/.test(await seite.locator('#standzeitFolge').textContent()),
      await seite.locator('#standzeitFolge').textContent());

    await seite.fill('#standzeitFeld', '2');
    await seite.click('#standzeitKnopf');
    await seite.waitForFunction(() => /zwischen/.test(document.getElementById('standzeitStand').textContent));
    pruefe('Unsinn wird mit Grund abgewiesen',
      /zwischen 5 und 300/.test(await seite.locator('#standzeitStand').textContent()),
      await seite.locator('#standzeitStand').textContent());
    await seite.fill('#standzeitFeld', '25');
    await seite.click('#standzeitKnopf');
    await seite.waitForFunction(() => /Übernommen/.test(document.getElementById('standzeitStand').textContent));
  }

  console.log('\nFehlerhafte Eingabe wird abgefangen');
  {
    await seite.fill('.planzeile input >> nth=0', 'gleich');
    await seite.click('#planSpeichern');
    await seite.waitForFunction(() => /HH:MM/.test(document.getElementById('planStand').textContent));
    pruefe('lesbare Rueckmeldung statt stiller Fehler',
      /HH:MM/.test(await seite.locator('#planStand').textContent()),
      await seite.locator('#planStand').textContent());
    // wieder in Ordnung bringen
    await seite.click('nav button[data-ansicht="spielzeiten"]');
    await seite.waitForTimeout(300);
  }

  console.log('\nStarten und abbrechen');
  {
    await seite.click('#spielStart');
    await seite.waitForFunction(() => /läuft/.test(document.getElementById('spielLage').textContent));
    const text = await balkenText(seite);
    pruefe('der Balken meldet die laufende Runde', /Runde 1 läuft/.test(text), text);
    pruefe('Nachschub-Countdown steht da', await seite.locator('#spielLage .uhr').isVisible());
    pruefe('Abbruchknopf da', await seite.locator('#spielAbbruch').isVisible());
    pruefe('Startknopf weg', await seite.locator('#spielStart').isHidden());

    // Der Balken muss von selbst weiterzaehlen, ohne neue Abfrage.
    const vorher = await seite.locator('#spielLage .uhr').textContent();
    await seite.waitForTimeout(2200);
    const nachher = await seite.locator('#spielLage .uhr').textContent();
    pruefe('er zaehlt von selbst herunter', vorher !== nachher, vorher + ' -> ' + nachher);

    await seite.click('#spielAbbruch');
    await seite.waitForFunction(() => /Nächste Runde/.test(document.getElementById('spielLage').textContent));
    pruefe('nach dem Abbruch steht die naechste an', /Runde 2/.test(await balkenText(seite)),
      await balkenText(seite));
  }

  console.log('\nDie Moderation selbst ist unberuehrt');
  {
    await seite.click('nav button[data-ansicht="uebersicht"]');
    pruefe('Uebersicht kommt zurueck', await seite.locator('#raster').isVisible());
    pruefe('Spielzeiten sind weg', await seite.locator('#spielzeiten').isHidden());
    await seite.click('nav button[data-ansicht="werkzeuge"]');
    pruefe('Werkzeuge gehen noch auf', await seite.locator('#werkzeuge').isVisible());
  }

  console.log('\nDie Warteschlange fuellt sich weiter nach');
  {
    // Der Intervall dafuer wird als LETZTES in start() gesetzt. Bricht dort
    // vorher etwas ab, laeuft die Oberflaeche scheinbar normal weiter, holt
    // aber nie wieder Nachschub — das faellt am Abend erst auf, wenn die
    // Queue steht. Deshalb wird hier wirklich mitgezaehlt.
    // Zurueck auf die Uebersicht: auf dem Werkzeugreiter laesst der Intervall
    // die Warteschlange bewusst in Ruhe.
    await seite.click('nav button[data-ansicht="uebersicht"]');
    let abrufe = 0;
    seite.on('request', r => { if (r.url().includes('/api/moderation/queue')) abrufe++; });
    await seite.waitForTimeout(11500);
    pruefe('binnen 11 s wurde nachgeladen', abrufe > 0, abrufe + ' Abrufe');
  }

  console.log('\nKonsole');
  {
    // Der 400er weiter oben ist gewollt: er beweist, dass verdrehte Uhrzeiten
    // abgewiesen werden. Alles andere waere ein echter Fund.
    const echte = konsole.filter(t =>
      !/favicon|schrift|font|net::ERR_/i.test(t) &&
      !/status of 400 \(Bad Request\)/.test(t));
    pruefe('keine Skriptfehler', echte.length === 0, echte.join(' | '));
  }

  await browser.close();
  await fastify.close();
  console.log('\n' + (fehler ? fehler + ' Fehler' : 'Alles gruen') + '\n');
  process.exit(fehler ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
