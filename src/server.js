// Fastify-Backend. Vier Aufgaben:
//   1. Botschaften annehmen        POST /api/botschaft
//   2. Status je Absender liefern  GET  /api/status/:token
//   3. Anzeigezustand ausliefern   GET  /api/anzeige      (Simulator und später die Bridge)
//   4. Die drei Seiten ausliefern  /  /status  /simulator

const path = require('path');
const crypto = require('crypto');
const fastify = require('fastify')({ logger: { level: process.env.LOG_LEVEL || 'info' } });
const cfg = require('./config');
const { FLAECHEN } = require('./flaechen');
const { abfragen } = require('./db');
const { groesseFuer, passendeFlaechen } = require('./text');
const scheduler = require('./scheduler');

fastify.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public') });

// ---------------------------------------------------------------- Botschaft annehmen

fastify.post('/api/botschaft', async (req, reply) => {
  const text = String(req.body?.text ?? '').replace(/\s+/g, ' ').trim();
  const name = cfg.nameErlaubt ? String(req.body?.name ?? '').replace(/\s+/g, ' ').trim() : '';

  if (text.length < 2) return reply.code(400).send({ fehler: 'Die Botschaft ist zu kurz.' });
  if (text.length > cfg.maxZeichenText) return reply.code(400).send({ fehler: `Höchstens ${cfg.maxZeichenText} Zeichen.` });
  if (name.length > cfg.maxZeichenName) return reply.code(400).send({ fehler: `Der Name darf höchstens ${cfg.maxZeichenName} Zeichen haben.` });

  // Spam-Sperre je Gerät. Die Kennung kommt vom Browser und wird nur gehasht
  // gespeichert — wir wollen wissen "schon wieder dasselbe Gerät", nicht "wer".
  const geraet = hash(String(req.body?.geraet ?? req.ip));
  const letzte = abfragen.letzteVomGeraet.get(geraet);
  if (letzte && Date.now() - letzte.erstellt_am < cfg.sperreProGeraetSekunden * 1000) {
    const wart = Math.ceil((cfg.sperreProGeraetSekunden * 1000 - (Date.now() - letzte.erstellt_am)) / 1000);
    return reply.code(429).send({ fehler: `Kurz durchatmen — in ${wart} Sekunden geht die nächste.` });
  }

  const token = crypto.randomBytes(9).toString('base64url');
  const jetzt = Date.now();
  // Solange die Filterkette (Block 4) fehlt, geht alles direkt in die Anzeige.
  const status = cfg.autoFreigabe ? 'freigegeben' : 'neu';
  const info = abfragen.einfuegen.run({
    text, name: name || null, status, token, geraet,
    erstellt_am: jetzt, entschieden_am: status === 'freigegeben' ? jetzt : null
  });

  const voll = name ? `${text} — ${name}` : text;
  const passend = passendeFlaechen(voll, FLAECHEN, cfg.minVersalhoehe, cfg.maxVersalhoehe);
  return { token, id: info.lastInsertRowid, status, passendeFlaechen: passend.length };
});

// ---------------------------------------------------------------- Status je Absender

fastify.get('/api/status/:token', async (req, reply) => {
  const b = abfragen.perToken.get(req.params.token);
  if (!b) return reply.code(404).send({ fehler: 'Unbekannt.' });

  const anzeigen = abfragen.anzeigenZuBotschaft.all(b.id);
  const jetzt = Date.now();
  const laufend = anzeigen.find(a => a.start <= jetzt && a.ende > jetzt);
  const naechste = abfragen.wartendeVor.get(b.erstellt_am).n;

  return {
    status: b.status,
    text: b.text,
    name: b.name,
    anzahlAnzeigen: b.anzahl_anzeigen,
    vorDir: b.anzahl_anzeigen > 0 ? 0 : naechste,
    // grobe Schätzung: 33 Flächen wechseln alle im Schnitt einmal je Standzeit
    geschaetzteWartezeitSekunden: b.anzahl_anzeigen > 0 ? 0
      : Math.round((naechste / FLAECHEN.length) * cfg.standzeitSekunden),
    jetztAuf: laufend ? flaecheInfo(laufend.flaeche) : null,
    zuletzt: anzeigen[0] ? { ...flaecheInfo(anzeigen[0].flaeche), start: anzeigen[0].start } : null
  };
});

// ---------------------------------------------------------------- Anzeige und Flächen

fastify.get('/api/anzeige', async () => ({
  zeit: Date.now(),
  blendeSekunden: cfg.blendeSekunden,
  flaechen: scheduler.anzeige()
}));

fastify.get('/api/flaechen', async () => FLAECHEN.map(f => ({
  nr: f.nr, name: f.name, breite: f.breite, gruppe: f.gruppe, band: f.band, fassade: f.fassade
})));

fastify.get('/api/kennzahlen', async () => {
  const nach = {};
  for (const r of abfragen.kennzahlen.all()) nach[r.status] = r.n;
  return { botschaften: nach, flaechen: FLAECHEN.length, standzeit: cfg.standzeitSekunden, autoFreigabe: cfg.autoFreigabe };
});

// Wie groß würde ein Text auf welcher Fläche? Nützlich beim Einrichten und für
// die spätere Vorschau in der Moderation.
fastify.get('/api/probe', async (req) => {
  const text = String(req.query.text ?? '');
  return {
    text,
    flaechen: FLAECHEN.map(f => ({ nr: f.nr, name: f.name, breite: f.breite, ...groesseFuer(text, f.breite, cfg.maxVersalhoehe) }))
  };
});

fastify.get('/api/gesundheit', async () => ({ ok: true, zeit: Date.now() }));

// ---------------------------------------------------------------- Seiten

fastify.get('/', (req, reply) => reply.sendFile('index.html'));
fastify.get('/status', (req, reply) => reply.sendFile('status.html'));
fastify.get('/simulator', (req, reply) => reply.sendFile('simulator.html'));

function flaecheInfo (nr) {
  const f = FLAECHEN.find(x => x.nr === nr);
  return f ? { nr: f.nr, name: f.name, gruppe: f.gruppe } : { nr };
}
function hash (s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32); }

async function start () {
  scheduler.starten();
  await fastify.listen({ port: cfg.port, host: cfg.host });
  fastify.log.info(`Botschaftssystem läuft — Eingabe: http://localhost:${cfg.port}/  Simulator: http://localhost:${cfg.port}/simulator`);
}

if (require.main === module) start().catch(e => { fastify.log.error(e); process.exit(1); });

module.exports = { fastify, start };
