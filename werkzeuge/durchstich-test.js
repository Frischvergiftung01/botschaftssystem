// Durchstich-Test: Botschaft absenden -> Scheduler -> Fläche -> Status.
// Aufruf: npm test   (der Server darf dabei NICHT laufen, der Test startet einen eigenen)
const assert = require('assert');
const fs = require('fs');

process.env.DB_PFAD = '/tmp/durchstich-test.db';
process.env.STANDZEIT = '3';
process.env.SPERRE_SEKUNDEN = '0';
fs.rmSync(process.env.DB_PFAD, { force: true });
fs.rmSync(process.env.DB_PFAD + '-wal', { force: true });
fs.rmSync(process.env.DB_PFAD + '-shm', { force: true });

const { fastify } = require('../src/server');
const scheduler = require('../src/scheduler');
const { groesseFuer } = require('../src/text');

(async () => {
  // 1. Textvermessung trifft den Erfahrungswert von 2025
  const kalib = groesseFuer('Beste Stimmung hier, ich liebe es.', 437, 40);
  assert.ok(kalib.versalhoehe > 26 && kalib.versalhoehe < 31,
    `Kalibriersatz sollte bei ~29 px landen, ist ${kalib.versalhoehe}`);

  // 2. Botschaft annehmen
  const senden = await fastify.inject({
    method: 'POST', url: '/api/botschaft',
    payload: { text: 'Hallo Oma!', name: 'Lena', geraet: 'test-1' }
  });
  assert.strictEqual(senden.statusCode, 200, senden.body);
  const { token } = senden.json();
  assert.ok(token);

  // 3. Scheduler läuft: die Botschaft landet auf einer Fläche
  scheduler.takt();
  const belegt = scheduler.anzeige().filter(f => f.text);
  assert.ok(belegt.length >= 1, 'Nach einem Takt sollte mindestens eine Fläche belegt sein');
  assert.ok(belegt[0].text.includes('Hallo Oma!'), 'Der Text sollte auf der Fläche stehen');
  assert.ok(belegt[0].text.includes('Lena'), 'Der Vorname gehört zum angezeigten Text');
  assert.ok(belegt[0].schrifthoehe > 0 && belegt[0].yVersatz !== null, 'Größe und Versatz gehören mitgeliefert');

  // 4. Status sagt korrekt, wo sie steht
  const status = (await fastify.inject({ url: '/api/status/' + token })).json();
  assert.strictEqual(status.status, 'freigegeben');
  assert.ok(status.jetztAuf && status.jetztAuf.nr, 'Status muss die laufende Fläche nennen');
  assert.strictEqual(status.anzahlAnzeigen, 1);

  // 5. Eine sehr lange Botschaft passt nur auf wenige Flächen
  const lang = 'Wir schicken euch Licht vom Schlossplatz und ganz viel Liebe an alle daheim, die heute nicht dabei sein können';
  const probe = (await fastify.inject({ url: '/api/probe?text=' + encodeURIComponent(lang) })).json();
  const passen = probe.flaechen.filter(f => f.versalhoehe >= 22).length;
  assert.ok(passen > 0 && passen < 10, `Lange Botschaft sollte nur auf wenige Flächen passen, passt auf ${passen}`);

  // 6. Spam-Sperre greift
  process.env.SPERRE_SEKUNDEN = '30';
  console.log(`
  Kalibriersatz auf einer 437er Säule : ${kalib.versalhoehe} px Versalhöhe
  Fläche der Testbotschaft            : ${belegt[0].nr} ${belegt[0].name}
  Schrifthöhe / Y-Versatz für Resolume: ${belegt[0].schrifthoehe} / ${belegt[0].yVersatz}
  Lange Botschaft passt auf           : ${passen} von 33 Flächen

  Durchstich steht: Handy -> Backend -> Scheduler -> Fläche -> Status.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
