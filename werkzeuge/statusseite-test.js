// Die Statusseite mit Fassadenplan.
//   node werkzeuge/statusseite-test.js
//
// Worum es geht: der Absender soll VORHER erfahren, wo seine Botschaft
// erscheint. "Laeuft jetzt" nuetzt niemandem, der am anderen Ende des
// Gebaeudes steht. Geprueft wird deshalb, dass die Buchung aus dem
// Belegungsplan durchkommt, dass sie in Menschensprache benannt ist und dass
// die Marke im Plan wirklich auf der richtigen Flaeche sitzt.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/statusseite-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
process.env.STANDZEIT = '5';
process.env.PLAN_HORIZONT = '20';
process.env.PORT = '3996';
process.env.HOST = '127.0.0.1';
process.env.SPERRE_SEKUNDEN = '0';
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { chromium } = require('playwright');
const { fastify, start } = require('../src/server');
const { FLAECHEN, ortsangabe } = require('../src/flaechen');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + JSON.stringify(zusatz) : ''));
}

const BASIS = 'http://127.0.0.1:' + process.env.PORT;
const schlaf = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await start();

  console.log('\nOrtsangaben sind fuer Menschen gemacht');
  {
    const alle = FLAECHEN.map(f => ortsangabe(f));
    pruefe('jede Flaeche hat eine', alle.every(o => o.kurz && o.kurz.length > 3));
    pruefe('keine nennt eine Technikbezeichnung',
      alle.every(o => !/Säule \d|Stirn /.test(o.kurz)), alle.filter(o => /Säule \d|Stirn /.test(o.kurz))[0]);
    pruefe('jede nennt eine Seite', alle.every(o => ['links', 'rechts', 'mitte'].includes(o.seite)));
    const links = FLAECHEN.filter(f => ortsangabe(f).seite === 'links').length;
    const rechts = FLAECHEN.filter(f => ortsangabe(f).seite === 'rechts').length;
    pruefe('links und rechts halten sich die Waage', Math.abs(links - rechts) <= 2, { links, rechts });
  }

  // Eine Botschaft einstellen — Auto-Freigabe ist an, sie geht direkt durch.
  const a = await fastify.inject({
    method: 'POST', url: '/api/botschaft',
    payload: { text: 'HECTOR GO', geraet: 'probe-status' }
  });
  const token = a.json().token;
  pruefe('Botschaft angenommen und freigegeben', a.statusCode === 200 && a.json().status === 'freigegeben',
    a.statusCode + ' ' + a.json().status);

  console.log('\nDie Auskunft nennt Ort und Zeit');
  let auskunft = null;
  {
    for (let i = 0; i < 40 && !auskunft; i++) {
      const d = (await fastify.inject({ url: '/api/status/' + token })).json();
      if (d.gebucht || d.jetztAuf) auskunft = d;
      else await schlaf(300);
    }
    pruefe('sie wird gebucht', Boolean(auskunft), 'nach 12 s noch keine Buchung');
    const wo = auskunft && (auskunft.gebucht || auskunft.jetztAuf);
    pruefe('mit Ortsangabe', Boolean(wo && wo.ort), wo);
    pruefe('mit Seite', wo && ['links', 'rechts', 'mitte'].includes(wo.seite), wo && wo.seite);
    pruefe('mit Fassadenkoordinate', wo && typeof wo.fassade.x === 'number', wo && wo.fassade);
    pruefe('der Sessionstand faehrt mit', Boolean(auskunft && auskunft.session));
  }

  console.log('\nDie Seite zeigt den Plan mit der Marke');
  const browser = await chromium.launch();
  // Handybreite: genau dort war die Uebersicht allein zu flach.
  const seite = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const konsole = [];
  seite.on('console', m => { if (m.type() === 'error') konsole.push(m.text()); });
  seite.on('pageerror', e => konsole.push('Skriptfehler: ' + e.message));
  {
    await seite.goto(BASIS + '/status?t=' + token, { waitUntil: 'networkidle' });
    await seite.waitForFunction(() => !document.getElementById('plankarte').hidden, null, { timeout: 15000 });
    pruefe('der Fassadenplan ist da', await seite.locator('#plankarte').isVisible());
    pruefe('die Marke steht drin', await seite.locator('#marke').isVisible());
    pruefe('der Ort steht darunter',
      (await seite.locator('#planOrt').textContent()).length > 3,
      await seite.locator('#planOrt').textContent());
    pruefe('die Gebaeudehaelfte auch',
      /Gebäude/.test(await seite.locator('#planSeite').textContent()),
      await seite.locator('#planSeite').textContent());

    // Sitzt die Marke wirklich ueber der gebuchten Flaeche?
    const messen = (rahmen, marke) => seite.evaluate(([r, m]) => {
      const a = document.getElementById(r).getBoundingClientRect();
      const b = document.getElementById(m).getBoundingClientRect();
      return { x: (b.left + b.width / 2 - a.left) / a.width,
        y: (b.top + b.height / 2 - a.top) / a.height, hoehe: a.height };
    }, [rahmen, marke]);

    const d = (await fastify.inject({ url: '/api/status/' + token })).json();
    const wo = d.gebucht || d.jetztAuf;
    const f = FLAECHEN.find(x => x.nr === wo.nr);
    const breit = f.fassade.gedreht ? 44 : f.breite;
    const hoch = f.fassade.gedreht ? f.breite : 44;
    const sollX = (f.fassade.x + breit / 2) / 7680;
    const sollY = (f.fassade.y + hoch / 2) / 1200;

    const ueber = await messen('uebersicht', 'marke');
    pruefe('in der Uebersicht sitzt die Marke waagerecht richtig', Math.abs(ueber.x - sollX) < 0.01,
      { ist: ueber.x.toFixed(4), soll: sollX.toFixed(4), flaeche: f.name });
    pruefe('und senkrecht auch', Math.abs(ueber.y - sollY) < 0.02,
      { ist: ueber.y.toFixed(4), soll: sollY.toFixed(4) });

    // Der Ausschnitt zeigt ein Drittel, also muss die Marke dort dreimal so
    // weit von der Mitte des Bildes weg liegen — beziehungsweise genau da,
    // wo der Ausschnitt sie hinlegt.
    const links = Math.max(0, Math.min(2 / 3, sollX - 1 / 6));
    const sollXgross = (sollX - links) / (1 / 3);
    const gross = await messen('ausschnitt', 'markeGross');
    pruefe('im Ausschnitt sitzt sie ebenfalls richtig', Math.abs(gross.x - sollXgross) < 0.02,
      { ist: gross.x.toFixed(4), soll: sollXgross.toFixed(4) });
    pruefe('der Ausschnitt ist deutlich hoeher als die Uebersicht',
      gross.hoehe > ueber.hoehe * 2.5, { uebersicht: Math.round(ueber.hoehe), ausschnitt: Math.round(gross.hoehe) });
    console.log('       (Uebersicht ' + Math.round(ueber.hoehe) + ' px, Ausschnitt '
      + Math.round(gross.hoehe) + ' px bei ' + (await seite.evaluate(() => innerWidth)) + ' px Breite)');

    pruefe('die Ueberschrift sagt wann oder dass es laeuft',
      /In \d+:\d\d|Gleich|Gerade auf der Fassade/.test(await seite.locator('#ueberschrift').textContent()),
      await seite.locator('#ueberschrift').textContent());
    pruefe('die Kernaussage ist der Ort',
      (await seite.locator('#kernaussage').textContent()).length > 3,
      await seite.locator('#kernaussage').textContent());
  }

  console.log('\nAn den Gebaeudeenden bleibt die Marke im Bild');
  {
    // Direkt in der Seite geprueft, mit erfundenen Flaechen ganz aussen: dort
    // darf nicht das Bild aus dem Rahmen wandern, sondern die Marke aus der Mitte.
    const faelle = await seite.evaluate(() => {
      const ergebnis = [];
      for (const [name, x] of [['ganz links', 30], ['links', 309], ['mitte', 3800], ['rechts', 7325], ['ganz rechts', 7600]]) {
        planZeigen({ nr: 1, ort: 'Probe', seite: 'mitte', breite: 44,
          fassade: { x, y: 629, gedreht: true } }, false);
        const a = document.getElementById('ausschnitt').getBoundingClientRect();
        const b = document.getElementById('markeGross').getBoundingClientRect();
        const l = document.getElementById('lupe');
        ergebnis.push({
          name,
          anteil: (b.left + b.width / 2 - a.left) / a.width,
          lupeLinks: parseFloat(l.style.left),
          lupeBreite: parseFloat(l.style.width)
        });
      }
      return ergebnis;
    });
    for (const fall of faelle) {
      pruefe('Marke im Bild: ' + fall.name, fall.anteil >= -0.01 && fall.anteil <= 1.01,
        fall.anteil.toFixed(3));
    }
    pruefe('die Lupe bleibt im Gebaeude',
      faelle.every(f => f.lupeLinks >= -0.01 && f.lupeLinks + f.lupeBreite <= 100.01),
      faelle.map(f => f.lupeLinks.toFixed(1)));
    pruefe('ganz links sitzt die Marke links im Ausschnitt', faelle[0].anteil < 0.2, faelle[0].anteil.toFixed(3));
    pruefe('in der Mitte sitzt sie mittig', Math.abs(faelle[2].anteil - 0.5) < 0.05, faelle[2].anteil.toFixed(3));
    pruefe('ganz rechts sitzt sie rechts', faelle[4].anteil > 0.8, faelle[4].anteil.toFixed(3));
  }

  console.log('\nOhne Buchung kein Plan');
  {
    const b = await fastify.inject({
      method: 'POST', url: '/api/botschaft',
      payload: { text: 'NOCH EINE PROBE', geraet: 'probe-status-2' }
    });
    const t2 = b.json().token;
    // Von Hand zurueckstellen: dann ist sie nicht spielbar und nicht gebucht.
    const id = b.json().id;
    require('../src/db').abfragen.statusSetzen.run({ id, status: 'neu', zeit: Date.now() });
    require('../src/scheduler').planStreichen([id]);
    const seite2 = await (await browser.newContext()).newPage();
    await seite2.goto(BASIS + '/status?t=' + t2, { waitUntil: 'networkidle' });
    await seite2.waitForFunction(() => /Wird geprüft/.test(document.getElementById('ueberschrift').textContent),
      null, { timeout: 10000 });
    pruefe('Plan bleibt ausgeblendet', await seite2.locator('#plankarte').isHidden());
    pruefe('und die Seite sagt, dass geprueft wird',
      /Wird geprüft/.test(await seite2.locator('#ueberschrift').textContent()));
  }

  console.log('\nKonsole');
  pruefe('keine Skriptfehler', konsole.length === 0, konsole.join(' | '));

  await browser.close();
  await fastify.close();
  console.log('\n' + (fehler ? fehler + ' Fehler' : 'Alles gruen') + '\n');
  process.exit(fehler ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
