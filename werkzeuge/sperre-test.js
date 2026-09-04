// Gerätesperre. Aufruf: npm test
//
// Die Seiten bauen ihren Countdown aus den Zahlen, die hier zurückkommen —
// fehlt eine davon, tippt jemand einen Text und bekommt erst beim Abschicken
// die Absage.
const assert = require('assert');
const fs = require('fs');

process.env.DB_PFAD = '/tmp/sperre-test.db';
process.env.SPERRE_SEKUNDEN = '120';
process.env.MISTRAL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { fastify } = require('../src/server');
const senden = (text, geraet) => fastify.inject({ method: 'POST', url: '/api/botschaft', payload: { text, geraet } });

(async () => {
  const erste = await senden('Grüße vom Schlossplatz', 'geraet-a');
  assert.strictEqual(erste.statusCode, 200);
  assert.strictEqual(erste.json().sperreSekunden, 120, 'Die Seite braucht die Sperrdauer für den Countdown');

  const zweite = await senden('Und noch eine', 'geraet-a');
  assert.strictEqual(zweite.statusCode, 429);
  const wart = zweite.json().wartenSekunden;
  assert.ok(wart > 0 && wart <= 120, 'Restzeit muss mitkommen, ist: ' + wart);

  const anderes = await senden('Von einem anderen Gerät', 'geraet-b');
  assert.strictEqual(anderes.statusCode, 200, 'Die Sperre gilt je Gerät, nicht für alle');

  console.log(`
  Gerätesperre: 120 s je Gerät, Restzeit (${wart} s) und Sperrdauer kommen an die Seite zurück.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
