// Zugangsschutz der Moderation.
//
// Ein gemeinsames Kennwort, keine Benutzerkonten: am Abend sitzt eine Person am
// Moderationsplatz, eine zweite springt ein, und beide sollen sich auf einem
// fremden Gerät in zehn Sekunden anmelden können. Das Kennwort steht in Coolify
// unter Environment Variables (MODERATION_KENNWORT) und niemals im Repository.
//
// Ist kein Kennwort gesetzt, bleibt die Moderation geschlossen — lieber keine
// Oberfläche als eine offene Freigabeseite im Netz.
//
// Das Cookie enthält nur Ablaufzeitpunkt und Unterschrift. Der Schlüssel dafür
// ist vom Kennwort abgeleitet: wird das Kennwort gewechselt, sind alle
// Sitzungen sofort ungültig.

const crypto = require('crypto');
const cfg = require('./config');

const COOKIE = 'moderation';
const MINDESTLAENGE = 8;
const VERSUCHE_MAX = 8;
const SPERRE_MS = 5 * 60 * 1000;

const versuche = new Map(); // Herkunft -> { n, bis }

const kennwortGesetzt = () => cfg.moderationKennwort.length >= MINDESTLAENGE;

function hash (s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest(); }

function kennwortStimmt (eingabe) {
  if (!kennwortGesetzt()) return false;
  return crypto.timingSafeEqual(hash(eingabe), hash(cfg.moderationKennwort));
}

const sitzungsSchluessel = () => hash('sitzung|' + cfg.moderationKennwort);

function unterschrift (ablauf) {
  return crypto.createHmac('sha256', sitzungsSchluessel()).update(String(ablauf)).digest('base64url');
}

function ausstellen () {
  const ablauf = Date.now() + cfg.moderationSitzungStunden * 3600 * 1000;
  return ablauf + '.' + unterschrift(ablauf);
}

function gueltig (wert) {
  if (!wert || !kennwortGesetzt()) return false;
  const [ablauf, sig] = String(wert).split('.');
  if (!/^\d+$/.test(ablauf || '') || !sig) return false;
  if (Number(ablauf) < Date.now()) return false;
  const soll = Buffer.from(unterschrift(ablauf));
  const ist = Buffer.from(sig);
  return soll.length === ist.length && crypto.timingSafeEqual(soll, ist);
}

function ausCookie (req) {
  const roh = req.headers.cookie;
  if (!roh) return null;
  for (const teil of roh.split(';')) {
    const i = teil.indexOf('=');
    if (i < 0) continue;
    if (teil.slice(0, i).trim() === COOKIE) return decodeURIComponent(teil.slice(i + 1).trim());
  }
  return null;
}

const angemeldet = req => gueltig(ausCookie(req));

// Hinter dem Coolify-Proxy kommt die Anfrage als http an; ob der Browser https
// spricht, steht im Weiterleitungskopf. Secure nur dann setzen, sonst legt der
// Browser das Cookie beim Testen auf localhost gar nicht erst an.
function ueberHttps (req) {
  return (req.headers['x-forwarded-proto'] || req.protocol || '') === 'https';
}

function keksZeile (wert, maxAlterSekunden, req) {
  const teile = [`${COOKIE}=${wert}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAlterSekunden}`];
  if (ueberHttps(req)) teile.push('Secure');
  return teile.join('; ');
}

function anmelden (reply, req) {
  reply.header('set-cookie', keksZeile(ausstellen(), cfg.moderationSitzungStunden * 3600, req));
}

function abmelden (reply, req) {
  reply.header('set-cookie', keksZeile('', 0, req));
}

// Rateversuche: acht Fehlversuche, dann fünf Minuten Ruhe für diese Herkunft.
// Reicht gegen stures Durchprobieren und stört niemanden, der sich vertippt.
function gesperrt (herkunft) {
  const e = versuche.get(herkunft);
  return Boolean(e && e.n >= VERSUCHE_MAX && e.bis > Date.now());
}

function fehlversuch (herkunft) {
  const e = versuche.get(herkunft) || { n: 0, bis: 0 };
  if (e.bis < Date.now()) e.n = 0;
  e.n++;
  e.bis = Date.now() + SPERRE_MS;
  versuche.set(herkunft, e);
}

function versucheVergessen (herkunft) { versuche.delete(herkunft); }

module.exports = {
  kennwortGesetzt, kennwortStimmt, angemeldet, anmelden, abmelden,
  gesperrt, fehlversuch, versucheVergessen, MINDESTLAENGE
};
