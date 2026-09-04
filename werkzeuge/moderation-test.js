// Test der Moderation (Block 5). Aufruf: npm test
//
// Geprüft wird, was am Abend teuer wäre: dass die Oberfläche ohne Anmeldung zu
// bleibt, dass Grenzfälle vorn stehen, dass eine Sammelfreigabe wirklich alle
// zwölf erwischt und dass eine gesperrte Botschaft SOFORT von der Fassade geht
// und nicht erst nach Ablauf der Standzeit.
const assert = require('assert');
const fs = require('fs');

process.env.DB_PFAD = '/tmp/moderation-test.db';
process.env.STANDZEIT = '60';
process.env.SPERRE_SEKUNDEN = '0';
process.env.AUTO_FREIGABE = 'false';          // alles geht durch die Moderation
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';             // Stufe 1b stillgelegt, kein Netz im Test
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { fastify } = require('../src/server');
const scheduler = require('../src/scheduler');
const einstellungen = require('../src/einstellungen');

const senden = (text, nr, name) => fastify.inject({
  method: 'POST', url: '/api/botschaft',
  payload: { text, name, geraet: 'test-mod-' + nr }
});

let keks = null;
const mit = (url, payload) => fastify.inject({
  method: payload ? 'POST' : 'GET', url, payload, headers: keks ? { cookie: keks } : {}
});

(async () => {
  // 1. Ohne Anmeldung ist zu — API mit 401, Seite mit Umleitung
  assert.strictEqual((await fastify.inject({ url: '/api/moderation/queue' })).statusCode, 401);
  const seite = await fastify.inject({ url: '/moderation' });
  assert.strictEqual(seite.statusCode, 302, 'Die Seite muss zur Anmeldung umleiten');
  assert.strictEqual(seite.headers.location, '/moderation/anmelden');
  // Die Seite darf auch nicht unter ihrem Dateinamen offen liegen
  assert.strictEqual((await fastify.inject({ url: '/moderation.html' })).statusCode, 302);

  // 2. Falsches Kennwort kommt nicht durch, richtiges setzt ein Cookie
  const falsch = await fastify.inject({ method: 'POST', url: '/api/moderation/anmelden', payload: { kennwort: 'daneben' } });
  assert.strictEqual(falsch.statusCode, 401);
  const richtig = await fastify.inject({ method: 'POST', url: '/api/moderation/anmelden', payload: { kennwort: 'probe-kennwort-2026' } });
  assert.strictEqual(richtig.statusCode, 200);
  const gesetzt = [].concat(richtig.headers['set-cookie'])[0];
  assert.ok(/^moderation=/.test(gesetzt), 'Anmeldung muss ein Cookie setzen');
  assert.ok(/HttpOnly/i.test(gesetzt), 'Das Cookie gehört auf HttpOnly');
  keks = gesetzt.split(';')[0];
  assert.strictEqual((await mit('/api/moderation/queue')).statusCode, 200);

  // 3. Ein Grenzfall und fünfzehn unauffällige Botschaften
  await senden('Grüße an alle Fans vom BVB', 1);          // PRUEFEN -> unsicher
  const WORTE = ['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht',
    'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn'];
  for (let i = 0; i < WORTE.length; i++) await senden('Grüße vom Schlossplatz, Runde ' + WORTE[i], 10 + i);

  const queue = (await mit('/api/moderation/queue?ansicht=einzeln')).json();
  assert.strictEqual(queue.botschaften.length, 16);
  assert.ok(queue.botschaften[0].unsicher, 'Der Grenzfall muss vorn stehen');
  assert.ok(queue.botschaften[0].gruende.length, 'Der Grund gehört in die Oberfläche');
  assert.ok(!queue.botschaften[1].unsicher);
  assert.strictEqual(queue.kennzahlen.offen.unsicher, 1);
  assert.strictEqual(queue.kennzahlen.offenGesamt, 16);
  // Projektionsoptik: die Vorschau kennt Fläche, Versalhöhe und Y-Versatz
  const o = queue.botschaften[1].optik;
  assert.ok(o.versalhoehe > 0 && o.breite > 0 && o.passendeFlaechen > 0, 'Optik unvollständig: ' + JSON.stringify(o));

  // 4. Das Raster zeigt nur Unauffälliges — und eine Sammelfreigabe erwischt alle
  const raster = (await mit('/api/moderation/queue?ansicht=raster')).json();
  assert.strictEqual(raster.botschaften.length, 12, 'Rastergröße sind zwölf Kacheln');
  assert.ok(raster.botschaften.every(b => !b.unsicher), 'Ins Raster gehört nichts Unsicheres');
  const zwoelf = raster.botschaften.map(b => b.id);
  const frei = (await mit('/api/moderation/entscheiden', { ids: zwoelf, entscheidung: 'freigeben' })).json();
  assert.strictEqual(frei.geaendert, 12);
  assert.strictEqual(frei.kennzahlen.offenGesamt, 4);

  // 5. Rückgängig holt sie zurück in die Queue
  const zurueck = (await mit('/api/moderation/entscheiden', { ids: zwoelf, entscheidung: 'zurueckholen' })).json();
  assert.strictEqual(zurueck.geaendert, 12);
  assert.strictEqual(zurueck.kennzahlen.offenGesamt, 16);
  await mit('/api/moderation/entscheiden', { ids: zwoelf, entscheidung: 'freigeben' });

  // 6. Sperren nimmt eine laufende Botschaft SOFORT von der Fassade
  // Der Scheduler laesst bewusst mindestens 0,9 s zwischen zwei Wechseln, damit
  // die Fassade nicht auf einen Schlag umspringt — im Test reicht deshalb eine
  // belegte Flaeche.
  scheduler.takt();
  const laufend = scheduler.anzeige().filter(f => f.text);
  assert.ok(laufend.length >= 1, 'Nach einem Takt sollte eine Flaeche belegt sein');
  const opfer = [...scheduler.zustand.values()].find(f => f.botschaftId);
  const opferNr = opfer.nr, opferText = opfer.text, opferId = opfer.botschaftId;
  const gesperrt = (await mit('/api/moderation/entscheiden', { ids: [opferId], entscheidung: 'sperren' })).json();
  assert.ok(gesperrt.geraeumt >= 1, 'Die Fläche muss sofort geräumt werden');
  const danach = scheduler.anzeige().find(f => f.nr === opferNr);
  assert.notStrictEqual(danach.text, opferText, 'Die gesperrte Botschaft darf nicht stehen bleiben');
  assert.strictEqual(danach.text, '', 'Die Fläche ist bis zum nächsten Takt leer');

  // 7. Nachschub aus: der Scheduler teilt nichts mehr zu
  await mit('/api/moderation/schalter', { name: 'nachschub', wert: false });
  assert.strictEqual(einstellungen.schalter().nachschub, false);
  for (const f of scheduler.zustand.values()) f.ende = 0;   // alle Standzeiten abgelaufen
  scheduler.takt();
  assert.strictEqual(scheduler.anzeige().filter(f => f.text).length, 0,
    'Bei angehaltenem Nachschub darf nichts Neues belegt werden');
  await mit('/api/moderation/schalter', { name: 'nachschub', wert: true });

  // 8. Der Schalter überlebt einen Neustart (er steht in der Datenbank)
  einstellungen.vergessen();
  assert.strictEqual(einstellungen.schalter().nachschub, true);

  // 9. Datenbank leeren nur mit Bestätigung
  assert.strictEqual((await mit('/api/moderation/datenbank-leeren', { bestaetigung: 'ja' })).statusCode, 400);
  const geleert = (await mit('/api/moderation/datenbank-leeren', { bestaetigung: 'LEEREN' })).json();
  assert.strictEqual(geleert.geloescht, 16);
  assert.strictEqual(scheduler.anzeige().filter(f => f.text).length, 0, 'Nach dem Leeren ist die Fassade leer');
  assert.strictEqual((await mit('/api/moderation/kennzahlen')).json().offenGesamt, 0);

  // 10. Abmelden macht das Cookie ungültig
  const ab = await mit('/api/moderation/abmelden', {});
  assert.ok(/Max-Age=0/.test([].concat(ab.headers['set-cookie'])[0]));

  console.log(`
  Moderation geprüft: Zugang zu ohne Kennwort, Grenzfall vorn, Sammelfreigabe über zwölf,
  Rückgängig, Sperren räumt die belegte Fläche ${opferNr} sofort,
  Nachschub-Schalter übersteht den Neustart, Datenbank leeren nur mit Bestätigung.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
