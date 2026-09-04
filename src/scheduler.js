// Der Scheduler teilt freigegebene Botschaften auf die 33 Flächen zu.
//
// Zwei Dinge macht er bewusst anders, als man es zuerst schreiben würde:
//
// 1. Er entscheidet über die *gemessene Textbreite*, nicht über die Zeichenzahl.
//    Eine Botschaft landet nur dort, wo sie mindestens die Mindest-Versalhöhe
//    erreicht. Lange Botschaften kommen deshalb seltener dran — das ist gewollt
//    und steht so auch auf der Eingabeseite.
//
// 2. Die Flächen wechseln *versetzt*. Alle 33 gleichzeitig umzuschalten sähe aus
//    wie ein Bildschirmwechsel; einzeln wechselnd wirkt die Fassade lebendig.
//    Jede Fläche hat dafür ihren eigenen Zeitversatz.
//
// Seit Block 5 kann die Moderation eingreifen: `entfernen` nimmt eine Botschaft
// sofort von der Fassade (Ablehnen oder Sperren einer laufenden Botschaft), und
// der Schalter `nachschub` hält die Zuteilung an, ohne den Dienst zu stoppen.
// Der harte Abbruch ist das nicht — der passiert in Resolume an den Ebenen.

const cfg = require('./config');
const { FLAECHEN } = require('./flaechen');
const { groesseFuer } = require('./text');
const { abfragen } = require('./db');
const einstellungen = require('./einstellungen');

// Laufender Zustand je Fläche — das ist genau das, was Simulator und Bridge lesen.
const zustand = new Map();
for (const [i, f] of FLAECHEN.entries()) {
  zustand.set(f.nr, {
    nr: f.nr,
    name: f.name,
    breite: f.breite,
    gruppe: f.gruppe,
    botschaftId: null,
    text: '',
    absender: null,
    start: 0,
    ende: 0,
    // Versatz, damit nicht alle gleichzeitig wechseln: gleichmäßig über die Standzeit verteilt
    versatz: Math.round((i * cfg.standzeitSekunden * 1000) / FLAECHEN.length)
  });
}

let gestartet = false;
let letzterWechsel = 0;

function jetzt () { return Date.now(); }

/** Eine Runde: jede abgelaufene Fläche bekommt eine neue Botschaft. */
function takt () {
  if (!einstellungen.schalter().nachschub) return; // angehalten: Laufendes läuft aus
  const t = jetzt();
  // Nie zwei Wechsel im selben Augenblick — sonst flackert die halbe Fassade auf einmal.
  const mindestabstand = Math.max(200, Math.round((cfg.standzeitSekunden * 1000) / FLAECHEN.length / 2));
  for (const f of zustand.values()) {
    if (t < f.ende) continue;
    if (t - letzterWechsel < mindestabstand) break;
    if (belegen(f, t)) letzterWechsel = t;
  }
}

/** Sucht die nächste passende Botschaft für eine Fläche und trägt sie ein. */
function belegen (f, t) {
  const kandidaten = abfragen.spielbar.all();
  if (kandidaten.length === 0) return false;

  const laufendeIds = new Set([...zustand.values()].filter(x => x.nr !== f.nr && x.ende > t).map(x => x.botschaftId));

  for (const b of kandidaten) {
    if (laufendeIds.has(b.id)) continue;           // nicht zweimal gleichzeitig an der Fassade
    if (b.id === f.botschaftId) continue;          // nicht direkt wiederholen
    const voll = vollerText(b);
    const g = groesseFuer(voll, f.breite, cfg.maxVersalhoehe);
    if (g.versalhoehe < cfg.minVersalhoehe) continue; // passt hier nicht lesbar drauf

    const ende = t + cfg.standzeitSekunden * 1000;
    f.botschaftId = b.id;
    f.text = voll;
    f.absender = b.name || null;
    f.start = t;
    f.ende = ende;
    f.groesse = g;

    abfragen.anzeigeEintragen.run({
      botschaft_id: b.id, flaeche: f.nr, start: t, ende,
      versalhoehe: g.versalhoehe, schrifthoehe: g.schrifthoehe, y_versatz: g.yVersatz
    });
    abfragen.anzeigeGezaehlt.run(t, b.id);
    return true;
  }
  return false;
}

/**
 * Nimmt Botschaften sofort von der Fassade — für Ablehnen und Sperren aus der
 * Moderation. Die Fläche wird frei und bekommt im nächsten Takt eine andere.
 * @param {Iterable<number>} ids
 * @returns {number} Anzahl geräumter Flächen
 */
function entfernen (ids) {
  const menge = new Set([...ids].map(Number));
  let geraeumt = 0;
  for (const f of zustand.values()) {
    if (f.botschaftId === null || !menge.has(f.botschaftId)) continue;
    raeumen(f);
    geraeumt++;
  }
  return geraeumt;
}

/** Alle Flächen räumen — nach dem Leeren der Datenbank. */
function alleEntfernen () {
  for (const f of zustand.values()) raeumen(f);
}

function raeumen (f) {
  f.botschaftId = null;
  f.text = '';
  f.absender = null;
  f.start = 0;
  f.ende = 0;
  f.groesse = null;
}

/** Botschaft plus Absender, so wie es auf der Fassade steht. */
function vollerText (b) {
  return b.name ? `${b.text} — ${b.name}` : b.text;
}

function starten () {
  if (gestartet) return;
  gestartet = true;
  setInterval(takt, cfg.taktMillisekunden).unref();
}

/** Momentaufnahme für Simulator und Bridge. */
function anzeige () {
  const t = jetzt();
  return [...zustand.values()].map(f => ({
    nr: f.nr,
    name: f.name,
    breite: f.breite,
    gruppe: f.gruppe,
    text: f.ende > t ? f.text : '',
    absender: f.ende > t ? f.absender : null,
    restSekunden: f.ende > t ? Math.round((f.ende - t) / 100) / 10 : 0,
    schrifthoehe: f.groesse ? f.groesse.schrifthoehe : null,
    versalhoehe: f.groesse ? f.groesse.versalhoehe : null,
    yVersatz: f.groesse ? f.groesse.yVersatz : null
  }));
}

module.exports = { starten, takt, anzeige, zustand, vollerText, entfernen, alleEntfernen };
