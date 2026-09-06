// Fastify-Backend. Fünf Aufgaben:
//   1. Botschaften annehmen        POST /api/botschaft
//   2. Status je Absender liefern  GET  /api/status/:token
//   3. Anzeigezustand ausliefern   GET  /api/anzeige      (Simulator und später die Bridge)
//   4. Moderation bedienen         /moderation und /api/moderation/*   (Block 5)
//   5. Die Seiten ausliefern       /  /status  /simulator  /moderation

const path = require('path');
const crypto = require('crypto');
// Ohne IP im Log. Gebraucht wird sie nirgends: die Gerätesperre rechnet mit
// einer Prüfsumme, die Anmeldesperre hält die Herkunft nur im Arbeitsspeicher.
// Was nicht im Log steht, muss auch nicht erklärt und gelöscht werden.
const fastify = require('fastify')({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    serializers: {
      req (req) { return { method: req.method, url: req.url }; },
      res (res) { return { statusCode: res.statusCode }; }
    }
  }
});
const cfg = require('./config');
const { FLAECHEN } = require('./flaechen');
const { abfragen } = require('./db');
const { groesseFuer, passendeFlaechen } = require('./text');
const filter = require('./filter');
const mistral = require('./mistral');
const scheduler = require('./scheduler');
const auth = require('./auth');
const moderation = require('./moderation');
const einstellungen = require('./einstellungen');
const sessionen = require('./sessionen');

fastify.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public') });

// ---------------------------------------------------------------- Zugangsschutz
// Alles unter /moderation und /api/moderation/ ist geschlossen. Der Schutz sitzt
// bewusst hier als Torwächter und nicht in den einzelnen Routen — eine vergessene
// Route wäre eine offene Freigabeseite im Netz.

fastify.addHook('onRequest', async (req, reply) => {
  const pfad = (req.raw.url || '').split('?')[0];
  // Bewusst mit startsWith und ohne Schraegstrich: sonst laege die Seite unter
  // ihrem Dateinamen (/moderation.html) offen im Netz - @fastify/static liefert
  // alles aus public/ auch direkt aus.
  const geschuetzt = pfad.startsWith('/moderation') || pfad.startsWith('/api/moderation/');
  if (!geschuetzt) return;

  reply.header('x-robots-tag', 'noindex, nofollow');
  if (pfad === '/moderation/anmelden' || pfad === '/api/moderation/anmelden') return;
  if (auth.angemeldet(req)) return;

  if (pfad.startsWith('/api/')) return reply.code(401).send({ fehler: 'Nicht angemeldet.' });
  return reply.redirect('/moderation/anmelden');
});

// ---------------------------------------------------------------- Botschaft annehmen

fastify.post('/api/botschaft', async (req, reply) => {
  const text = String(req.body?.text ?? '').replace(/\s+/g, ' ').trim();
  const name = cfg.nameErlaubt ? String(req.body?.name ?? '').replace(/\s+/g, ' ').trim() : '';

  if (text.length < 2) return reply.code(400).send({ fehler: 'Die Botschaft ist zu kurz.' });
  if (text.length > cfg.maxZeichenText) return reply.code(400).send({ fehler: `Höchstens ${cfg.maxZeichenText} Zeichen.` });
  if (name.length > cfg.maxZeichenName) return reply.code(400).send({ fehler: `Der Name darf höchstens ${cfg.maxZeichenName} Zeichen haben.` });

  // Zeichen, die die Schrift nicht kennt, kann die Fassade nicht zeigen.
  // Das ist keine Moderationsfrage — hier darf der Grund genannt werden.
  const fremd = filter.nichtDarstellbar(text + name);
  if (fremd.length) {
    return reply.code(400).send({ fehler: `Diese Zeichen können wir auf der Fassade nicht darstellen: ${fremd.join(' ')}` });
  }

  // Wer an der Moderation angemeldet ist, sendet vom Haus aus: keine Gerätesperre
  // und das Filterergebnis kommt mit zurück. Das ist die Testseite
  // /moderation/eingabe und am Abend der Weg für eigene Botschaften.
  const vomPlatz = auth.angemeldet(req);

  // Spam-Sperre je Gerät. Die Kennung kommt vom Browser und wird nur gehasht
  // gespeichert — wir wollen wissen "schon wieder dasselbe Gerät", nicht "wer".
  const geraet = hash(String(req.body?.geraet ?? req.ip));
  const letzte = vomPlatz ? null : abfragen.letzteVomGeraet.get(geraet);
  if (letzte && Date.now() - letzte.erstellt_am < cfg.sperreProGeraetSekunden * 1000) {
    const wart = Math.ceil((cfg.sperreProGeraetSekunden * 1000 - (Date.now() - letzte.erstellt_am)) / 1000);
    return reply.code(429).send({ fehler: `Kurz durchatmen — in ${wart} Sekunden geht die nächste.`, wartenSekunden: wart });
  }

  const token = crypto.randomBytes(9).toString('base64url');
  const jetzt = Date.now();

  // Filterkette. Stufe 1a entscheidet sofort und ohne Netz; nur was sie nicht
  // schon abgelehnt hat, geht an das Sprachmodell. Es zaehlt immer das
  // strengere der beiden Urteile — 1b darf verschaerfen, nie freigeben.
  const stufe1a = filter.pruefen(text, name);
  const stufe1b = stufe1a.urteil === 'ABLEHNEN' ? null : await mistral.bewerten(text, name);
  const urteil = strengeres(stufe1a.urteil, stufe1b && stufe1b.urteil);
  const pruefung = { urteil, stufe1a, stufe1b };

  // Der Schalter steht seit Block 5 in der Datenbank und wird in der Moderation
  // umgelegt; die Umgebungsvariable ist nur der Startwert.
  const autoFreigabe = einstellungen.schalter().autoFreigabe;
  const status = urteil === 'ABLEHNEN' ? 'abgelehnt'
    : urteil === 'FREI' && autoFreigabe ? 'freigegeben'
      : 'neu';

  const info = abfragen.einfuegen.run({
    text, name: name || null, status, token, geraet,
    filter: JSON.stringify(pruefung),
    erstellt_am: jetzt,
    entschieden_am: status === 'neu' ? null : jetzt,
    // Grenzfälle stehen in der Moderationsqueue vorn und werden rot umrandet.
    unsicher: urteil === 'PRUEFEN' ? 1 : 0
  });

  // Abgelehntes wird protokolliert (Richtlinie 9), dem Absender aber als
  // Fehler im selben Fenster gezeigt — sein Text bleibt stehen und er kann
  // ihn umschreiben.
  if (status === 'abgelehnt') {
    req.log.info({ id: info.lastInsertRowid, pruefung }, 'Botschaft abgelehnt');
    return reply.code(422).send({ fehler: cfg.textAblehnung, ...(vomPlatz ? { pruefung } : {}) });
  }

  const voll = name ? `${text} — ${name}` : text;
  const passend = passendeFlaechen(voll, FLAECHEN, cfg.minVersalhoehe, cfg.maxVersalhoehe);
  // Die Sperrzeit geht mit zurueck: die Seiten zeigen daraus den Countdown und
  // halten den Knopf "noch eine Botschaft" so lange geschlossen.
  return { token, id: info.lastInsertRowid, status, passendeFlaechen: passend.length,
    sperreSekunden: vomPlatz ? 0 : cfg.sperreProGeraetSekunden,
    ...(vomPlatz ? { pruefung } : {}) };
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
      : Math.round((naechste / FLAECHEN.length) * einstellungen.standzeit()),
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
  return {
    botschaften: nach,
    flaechen: FLAECHEN.length,
    standzeit: einstellungen.standzeit(),
    autoFreigabe: einstellungen.schalter().autoFreigabe,
    schalter: einstellungen.schalter(),
    // Ohne den Plan: die Statusseite braucht nur, ob gerade gespielt wird und
    // wann es weitergeht. Die Zeilentabelle bleibt der Moderation vorbehalten.
    session: sessionKurz(),
    // Damit am Abend in einem Blick sichtbar ist, ob die Kette noch mitkommt.
    stufe1b: { aktiv: mistral.aktiv(), modell: cfg.mistralModell, ...mistral.kennzahlen() }
  };
});

// Wie groß würde ein Text auf welcher Fläche? Nützlich beim Einrichten und für
// die Vorschau in der Moderation.
fastify.get('/api/probe', async (req) => {
  const text = String(req.query.text ?? '');
  return {
    text,
    flaechen: FLAECHEN.map(f => ({ nr: f.nr, name: f.name, breite: f.breite, ...groesseFuer(text, f.breite, cfg.maxVersalhoehe) }))
  };
});

fastify.get('/api/gesundheit', async () => ({ ok: true, zeit: Date.now() }));

// ---------------------------------------------------------------- Moderation (Block 5)

fastify.post('/api/moderation/anmelden', async (req, reply) => {
  const herkunft = String(req.ip || 'unbekannt');
  if (!auth.kennwortGesetzt()) {
    return reply.code(503).send({ fehler: `Es ist kein Moderationskennwort gesetzt (MODERATION_KENNWORT, mindestens ${auth.MINDESTLAENGE} Zeichen).` });
  }
  if (auth.gesperrt(herkunft)) {
    return reply.code(429).send({ fehler: 'Zu viele Fehlversuche. Bitte in fünf Minuten noch einmal.' });
  }
  if (!auth.kennwortStimmt(String(req.body?.kennwort ?? ''))) {
    auth.fehlversuch(herkunft);
    await new Promise(r => setTimeout(r, 400));   // Raten unattraktiv machen
    return reply.code(401).send({ fehler: 'Kennwort stimmt nicht.' });
  }
  auth.versucheVergessen(herkunft);
  auth.anmelden(reply, req);
  req.log.info('Moderation angemeldet');
  return { ok: true };
});

fastify.post('/api/moderation/abmelden', async (req, reply) => {
  auth.abmelden(reply, req);
  return { ok: true };
});

fastify.get('/api/moderation/queue', async (req) => {
  const ansicht = String(req.query.ansicht ?? 'einzeln');
  const grenze = Math.min(200, Math.max(1, Number(req.query.grenze) || 60));
  return { ansicht, botschaften: moderation.queue(ansicht, grenze), kennzahlen: moderation.kennzahlen() };
});

fastify.get('/api/moderation/kennzahlen', async () => moderation.kennzahlen());

fastify.post('/api/moderation/entscheiden', async (req, reply) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [req.body?.id];
  const entscheidung = String(req.body?.entscheidung ?? '');
  if (!moderation.ZIEL[entscheidung]) return reply.code(400).send({ fehler: 'Unbekannte Entscheidung.' });
  const ergebnis = moderation.entscheiden(ids, entscheidung);
  req.log.info({ ids, entscheidung, ...ergebnis }, 'Moderationsentscheidung');
  return { ...ergebnis, kennzahlen: moderation.kennzahlen() };
});

fastify.post('/api/moderation/schalter', async (req, reply) => {
  const name = String(req.body?.name ?? '');
  if (!['autoFreigabe', 'nachschub'].includes(name)) return reply.code(400).send({ fehler: 'Unbekannter Schalter.' });
  const stand = einstellungen.setzen(name, Boolean(req.body?.wert));
  req.log.warn({ name, wert: Boolean(req.body?.wert) }, 'Schalter umgelegt');
  return { schalter: stand };
});

// ---------------------------------------------------------------- Spielzeiten
// Der Plan des Abends. Gestartet wird von Hand — faellt die Mapping-Show
// einmal spaeter, liefe ein automatischer Start mitten hinein.

fastify.get('/api/moderation/sessionen', async () => sessionen.stand());

fastify.post('/api/moderation/sessionen', async (req, reply) => {
  const zeilen = Array.isArray(req.body?.zeilen) ? req.body.zeilen : null;
  if (!zeilen) return reply.code(400).send({ fehler: 'Es fehlen die Zeilen.' });
  if (zeilen.length > 40) return reply.code(400).send({ fehler: 'Hoechstens 40 Runden.' });
  try {
    const n = sessionen.speichern(zeilen);
    req.log.info({ zeilen: n }, 'Spielzeiten gespeichert');
    return sessionen.stand();
  } catch (e) {
    return reply.code(400).send({ fehler: e.message });
  }
});

fastify.post('/api/moderation/session-starten', async (req, reply) => {
  try {
    const stand = sessionen.starten();
    req.log.warn({ nr: stand.aktuell && stand.aktuell.nr, endet: stand.aktuell && stand.aktuell.endeUhrzeit }, 'Session gestartet');
    return stand;
  } catch (e) {
    return reply.code(409).send({ fehler: e.message });
  }
});

fastify.post('/api/moderation/session-abbrechen', async (req, reply) => {
  try {
    const stand = sessionen.abbrechen();
    req.log.warn('Session abgebrochen');
    return stand;
  } catch (e) {
    return reply.code(409).send({ fehler: e.message });
  }
});

// Die Standzeit gehoert zu den Werten, die man am Abend anfassen koennen muss —
// aus demselben Grund wie die Schalter: kein Redeploy zur Unzeit.
fastify.post('/api/moderation/standzeit', async (req, reply) => {
  try {
    const sekunden = einstellungen.standzeitSetzen(req.body?.sekunden);
    req.log.warn({ sekunden }, 'Standzeit geaendert');
    return { standzeitSekunden: sekunden };
  } catch (e) {
    return reply.code(400).send({ fehler: e.message });
  }
});

fastify.post('/api/moderation/datenbank-leeren', async (req, reply) => {
  if (!cfg.datenbankLeerenErlaubt) return reply.code(403).send({ fehler: 'Auf diesem Stand abgeschaltet (DATENBANK_LEEREN=false).' });
  if (String(req.body?.bestaetigung ?? '') !== 'LEEREN') return reply.code(400).send({ fehler: 'Bitte LEEREN zur Bestätigung eintippen.' });
  const geloescht = moderation.datenbankLeeren();
  req.log.warn({ geloescht }, 'Datenbank geleert');
  return { geloescht };
});

// ---------------------------------------------------------------- Seiten

fastify.get('/', (req, reply) => reply.sendFile('index.html'));
fastify.get('/status', (req, reply) => reply.sendFile('status.html'));
fastify.get('/simulator', (req, reply) => reply.sendFile('simulator.html'));
fastify.get('/impressum', (req, reply) => reply.sendFile('impressum.html'));
fastify.get('/datenschutz', (req, reply) => reply.sendFile('datenschutz.html'));
fastify.get('/moderation', (req, reply) => reply.sendFile('moderation.html'));
fastify.get('/moderation/eingabe', (req, reply) => reply.sendFile('moderation-eingabe.html'));
fastify.get('/moderation/anmelden', (req, reply) => {
  if (auth.angemeldet(req)) return reply.redirect('/moderation');
  return reply.sendFile('anmeldung.html');
});

const RANG = { FREI: 0, PRUEFEN: 1, ABLEHNEN: 2 };
function strengeres (a, b) {
  if (!b) return a;
  return RANG[b] > RANG[a] ? b : a;
}

/** Sessionstand ohne die Zeilentabelle — fuer oeffentliche Auskuenfte. */
function sessionKurz () {
  const { zeilen, ...rest } = sessionen.stand();
  return { ...rest, geplant: zeilen.length };
}

function flaecheInfo (nr) {
  const f = FLAECHEN.find(x => x.nr === nr);
  return f ? { nr: f.nr, name: f.name, gruppe: f.gruppe } : { nr };
}
function hash (s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32); }

async function start () {
  scheduler.starten();
  if (!auth.kennwortGesetzt()) {
    fastify.log.warn('MODERATION_KENNWORT ist nicht gesetzt — die Moderationsoberfläche bleibt geschlossen.');
  }
  await fastify.listen({ port: cfg.port, host: cfg.host });
  fastify.log.info(`Botschaftssystem läuft — Eingabe: http://localhost:${cfg.port}/  Moderation: http://localhost:${cfg.port}/moderation`);
}

if (require.main === module) start().catch(e => { fastify.log.error(e); process.exit(1); });

module.exports = { fastify, start };
