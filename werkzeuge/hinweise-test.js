// Hinweise vom Platz: Tabelle, Vorrang auf der Stirnseite Mitte, Endpunkte.
//   node werkzeuge/hinweise-test.js
//
// Die drei Zusagen, die hier zaehlen:
//   - ein scharfer Hinweis unterbricht nichts, er kommt beim naechsten Wechsel
//   - solange er scharf steht, gehoert ihm die Flaeche; die Botschaften
//     verteilen sich von selbst auf die uebrigen 32
//   - er taucht nirgends in den Botschaftszahlen auf

const fs = require('fs');

process.env.DB_PFAD = '/tmp/hinweise-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
process.env.STANDZEIT = '25';
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const cfg = require('../src/config');
const { abfragen } = require('../src/db');
const { fastify } = require('../src/server');
const scheduler = require('../src/scheduler');
const hinweise = require('../src/hinweise');
const moderation = require('../src/moderation');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + JSON.stringify(zusatz) : ''));
}

const schlaf = ms => new Promise(r => setTimeout(r, ms));
const MITTE = cfg.hinweisFlaeche;
const flaeche = () => scheduler.zustand.get(MITTE);
const belegt = () => scheduler.anzeige().filter(f => f.text).length;

async function takte (n = 4) {
  for (let i = 0; i < n; i++) { scheduler.takt(); await schlaf(420); }
}

let keks = null;
const ruf = (url, payload) => fastify.inject({
  method: payload ? 'POST' : 'GET', url, payload, headers: keks ? { cookie: keks } : {}
});

for (let i = 0; i < 40; i++) {
  abfragen.einfuegen.run({
    text: 'Probebotschaft ' + i, name: null, status: 'freigegeben', filter: null,
    token: 'probe-' + i, geraet: 'g' + i,
    erstellt_am: Date.now() - (100 - i), entschieden_am: Date.now(), unsicher: 0
  });
}

(async () => {
  console.log('\nOhne Anmeldung ist alles zu');
  for (const [pfad, nutzlast] of [
    ['/api/moderation/hinweise', null],
    ['/api/moderation/hinweise', { zeilen: [] }],
    ['/api/moderation/hinweis-scharf', { nr: 1, wert: true }]
  ]) {
    const a = await ruf(pfad, nutzlast);
    pruefe(`${nutzlast ? 'POST' : 'GET '} ${pfad} gibt 401`, a.statusCode === 401, a.statusCode);
  }
  const an = await fastify.inject({
    method: 'POST', url: '/api/moderation/anmelden', payload: { kennwort: 'probe-kennwort-2026' }
  });
  keks = Array.isArray(an.headers['set-cookie']) ? an.headers['set-cookie'][0] : an.headers['set-cookie'];

  console.log('\nPlaetze stehen von selbst bereit');
  {
    const d = (await ruf('/api/moderation/hinweise')).json();
    pruefe('fuenf leere Plaetze', d.zeilen.length === cfg.hinweisPlaetze, d.zeilen.length);
    pruefe('keiner scharf', d.scharfe === 0);
    pruefe('die Flaeche ist die Stirnseite Mitte', d.flaeche.nr === MITTE && /Stirn/.test(d.flaeche.name), d.flaeche);
    pruefe('leere Plaetze haben keine Optik', d.zeilen.every(z => z.optik === null));
  }

  console.log('\nLeere Plaetze lassen sich nicht scharf stellen');
  {
    const a = await ruf('/api/moderation/hinweis-scharf', { nr: 1, wert: true });
    pruefe('abgewiesen mit Grund', a.statusCode === 400 && /leer/.test(a.json().fehler), a.json());
  }

  console.log('\nText speichern');
  {
    const a = await ruf('/api/moderation/hinweise', {
      zeilen: [{ text: 'Letzte Runde um 22:30' }, { text: 'Bitte den Durchgang freihalten' }]
    });
    pruefe('gespeichert', a.statusCode === 200, a.statusCode);
    const d = a.json();
    pruefe('zwei Plaetze', d.zeilen.length === 2, d.zeilen.length);
    pruefe('Optik wird mitgeliefert', d.zeilen[0].optik && d.zeilen[0].optik.versalhoehe > 0, d.zeilen[0].optik);
    pruefe('und ist auf der breitesten Flaeche gut lesbar', d.zeilen[0].optik.lesbar === true, d.zeilen[0].optik);

    const b = await ruf('/api/moderation/hinweise', { zeilen: [{ text: 'x'.repeat(cfg.maxZeichenHinweis + 1) }] });
    pruefe('zu langer Text wird abgewiesen', b.statusCode === 400, b.statusCode);
  }

  console.log('\nScharfstellen unterbricht nichts');
  {
    scheduler.alleEntfernen();
    await takte(6);
    // Die Stirnseite Mitte mit einer Botschaft belegen.
    scheduler.takt();
    let versuche = 0;
    while (!flaeche().text && versuche++ < 40) { scheduler.takt(); await schlaf(420); }
    pruefe('auf der Stirnseite Mitte steht eine Botschaft',
      Boolean(flaeche().text) && flaeche().hinweisId === null, flaeche().text);
    const lief = flaeche().text;

    await ruf('/api/moderation/hinweis-scharf', { nr: 1, wert: true });
    pruefe('der Hinweis steht scharf', hinweise.stand().scharfe === 1);
    scheduler.takt();
    pruefe('die laufende Botschaft steht noch', flaeche().text === lief, flaeche().text);
  }

  console.log('\nBeim naechsten Wechsel kommt er dran');
  {
    const f = flaeche();
    f.ende = Date.now() - 1;               // Standzeit abgelaufen
    await takte(2);
    pruefe('jetzt steht der Hinweis dort', f.text === 'Letzte Runde um 22:30', f.text);
    pruefe('als Hinweis gekennzeichnet', f.hinweisId !== null);
    pruefe('ohne Absender', f.absender === null);
    const a = scheduler.anzeige().find(x => x.nr === MITTE);
    pruefe('die Anzeige weist ihn aus', a.hinweis === true, a);
  }

  console.log('\nDie Flaeche gehoert ihm, solange er scharf steht');
  {
    const f = flaeche();
    for (let i = 0; i < 3; i++) { f.ende = Date.now() - 1; await takte(2); }
    pruefe('immer noch ein Hinweis', f.hinweisId !== null, f.text);
    pruefe('keine Botschaft dazwischen', f.botschaftId === null);
    pruefe('die uebrigen Flaechen laufen normal weiter', belegt() > 5, belegt());
  }

  console.log('\nMehrere scharfe kommen reihum');
  {
    await ruf('/api/moderation/hinweis-scharf', { nr: 2, wert: true });
    const f = flaeche();
    const gesehen = new Set();
    for (let i = 0; i < 4; i++) { f.ende = Date.now() - 1; await takte(2); gesehen.add(f.text); }
    pruefe('beide waren dran', gesehen.size === 2, [...gesehen]);
  }

  console.log('\nHerausnehmen gibt die Flaeche wieder frei');
  {
    await ruf('/api/moderation/hinweis-scharf', { nr: 1, wert: false });
    await ruf('/api/moderation/hinweis-scharf', { nr: 2, wert: false });
    pruefe('keiner mehr scharf', hinweise.stand().scharfe === 0);
    const f = flaeche();
    const standNoch = f.text;
    scheduler.takt();
    pruefe('das Laufende laeuft aus, nichts wird gekappt', f.text === standNoch, f.text);
    f.ende = Date.now() - 1;
    await takte(3);
    pruefe('danach wieder eine Botschaft', Boolean(f.text) && f.botschaftId !== null, f.text);
    pruefe('und sie gilt nicht mehr als Durchsage', f.hinweisId === null, f.hinweisId);
    const a = scheduler.anzeige().find(x => x.nr === MITTE);
    pruefe('auch in der Anzeige nicht', a.hinweis === false, a);
  }

  console.log('\nHinweise verfaelschen die Zahlen des Abends nicht');
  {
    const k = moderation.kennzahlen();
    const z = (await ruf('/api/kennzahlen')).json();
    pruefe('nicht in der Moderationsqueue', moderation.queue('einzeln', 60)
      .every(b => !/Letzte Runde|Durchgang/.test(b.text)));
    pruefe('nicht in den Botschaftszahlen',
      Object.values(z.botschaften).reduce((a, b) => a + b, 0) === 40,
      z.botschaften);
    pruefe('kein Eintrag in der Anzeigenhistorie',
      abfragen.anzeigenZuBotschaft.all(1).every(a => a.flaeche !== undefined));
    pruefe('aber der Zaehler im Kopf stimmt', k.hinweiseScharf === 0, k.hinweiseScharf);
  }

  await fastify.close();
  console.log('\n' + (fehler ? fehler + ' Fehler' : 'Alles gruen') + '\n');
  process.exit(fehler ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
