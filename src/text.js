// Textvermessung mit den echten Maßen der Hausschrift.
//
// Warum das hier liegt und nicht im Wire-Patch: Zeichenzählen taugt nicht.
// "WAHNSINN, WAS FÜR EIN ABEND" läuft über, wo gleich viele Kleinbuchstaben
// bequem passen. Wir messen deshalb die tatsächliche Breite in Schrifteinheiten
// und rechnen daraus die größte Schriftgröße, die auf eine Fläche passt.
//
// Zwei Dinge begrenzen die Größe:
//   1. die Breite der Fläche
//   2. die Höhe des Bandes (44 px) — und zwar über die *tatsächliche* Ober- und
//      Unterkante der Buchstaben, nicht über die Versalhöhe. Ein "Ä" ragt bei
//      Oswald bis 1042 Einheiten hoch (Versalhöhe: 810), ein "p" bis -190 hinunter.
//      Wer das ignoriert, schneidet Umlaute oben und Unterlängen unten ab.

const METRIK = require('./oswald-metrik.json');
const { BANDHOEHE } = require('./flaechen');

const UPEM = METRIK.unitsPerEm;      // 1000
const VERSALHOEHE = METRIK.capHeight; // 810

// Ersatzzeichen für alles, was nicht in der Tabelle steht (breitestes Zeichen,
// damit wir im Zweifel zu groß schätzen und nicht zu klein)
const ERSATZ = { a: 600, t: 810, b: -190 };

const RAND_SEITLICH = 2;   // px, entspricht dem Parameter "Sicherheitsrand" im Patch
const RAND_OBEN_UNTEN = 1; // px Luft über und unter den Buchstaben

/**
 * Misst einen Text in Schrifteinheiten (1000 = eine Geviertbreite).
 * @returns {{breite:number, oben:number, unten:number}}
 */
function vermessen (text) {
  let breite = 0;
  let oben = 0;      // höchster Punkt über der Grundlinie
  let unten = 0;     // tiefster Punkt unter der Grundlinie (negativ)
  for (const zeichen of text) {
    const g = METRIK.glyphs[zeichen] || ERSATZ;
    breite += g.a;
    if (g.t > oben) oben = g.t;
    if (g.b < unten) unten = g.b;
  }
  if (oben === 0) oben = VERSALHOEHE; // leerer Text: so tun als stünde ein Versal da
  return { breite, oben, unten };
}

/**
 * Passt der Text auf die Fläche — und wenn ja, wie groß?
 *
 * @param {string} text
 * @param {number} flaechenBreite  Breite der Fläche in px
 * @param {number} maxVersalhoehe  Obergrenze wie im Patch (Parameter "Schrifthoehe max")
 * @returns {{passt:boolean, versalhoehe:number, textbreite:number, schrifthoehe:number, yVersatz:number, auslastung:number}}
 */
function groesseFuer (text, flaechenBreite, maxVersalhoehe = 40) {
  const m = vermessen(text);
  const nutzbareBreite = flaechenBreite - 2 * RAND_SEITLICH;
  const nutzbareHoehe = BANDHOEHE - 2 * RAND_OBEN_UNTEN;

  // Geviertgröße (em) in px, die sich aus jeder der drei Grenzen ergibt
  const emAusBreite = m.breite > 0 ? (nutzbareBreite * UPEM) / m.breite : Infinity;
  const emAusHoehe = (nutzbareHoehe * UPEM) / (m.oben - m.unten);
  const emAusObergrenze = (maxVersalhoehe * UPEM) / VERSALHOEHE;

  const em = Math.min(emAusBreite, emAusHoehe, emAusObergrenze);
  const versalhoehe = (em * VERSALHOEHE) / UPEM;

  // Der Wire-Patch bekommt keine em-Größe, sondern seinen Parameter
  // "Schrifthoehe max". Gemessen: die tatsächliche Versalhöhe beträgt rund 96 %
  // des eingestellten Werts.
  const schrifthoehe = versalhoehe / 0.96;

  // Senkrechte Lage: Wire zentriert nicht die Buchstaben, sondern die Zeilenbox
  // der Schrift (Oberlänge 1193, Unterlänge -289 Einheiten) auf der Bandmitte.
  // Die Grundlinie liegt dadurch um (Oberlänge - Unterlänge) / 2 unter der Mitte.
  // Damit die *tatsächliche* Ober- und Unterkante des Textes mittig sitzt,
  // schickt das Backend dem Patch einen Versatz mit (positiv = nach oben).
  const obenPx = (em * m.oben) / UPEM;
  const untenPx = (em * -m.unten) / UPEM;
  const grundlinieJetzt = (em * (METRIK.ascent + METRIK.descent)) / (2 * UPEM);
  const grundlinieIdeal = (obenPx - untenPx) / 2;
  const yVersatz = grundlinieJetzt - grundlinieIdeal;

  return {
    passt: em >= 12 * UPEM / VERSALHOEHE, // unter ~12 px Versalhöhe ist es auf 44 px Band nicht mehr lesbar
    versalhoehe: runde(versalhoehe),
    textbreite: runde((em * m.breite) / UPEM),
    schrifthoehe: runde(schrifthoehe),
    yVersatz: runde(yVersatz),
    auslastung: runde(((em * m.breite) / UPEM) / nutzbareBreite, 3)
  };
}

/**
 * Welche der Flächen kommen für diesen Text in Frage?
 * Kriterium: die Botschaft erreicht dort mindestens die geforderte Versalhöhe.
 */
function passendeFlaechen (text, flaechen, minVersalhoehe = 22, maxVersalhoehe = 40) {
  return flaechen
    .map(f => ({ flaeche: f, groesse: groesseFuer(text, f.breite, maxVersalhoehe) }))
    .filter(x => x.groesse.versalhoehe >= minVersalhoehe);
}

function runde (n, stellen = 1) {
  const f = Math.pow(10, stellen);
  return Math.round(n * f) / f;
}

module.exports = { vermessen, groesseFuer, passendeFlaechen, VERSALHOEHE, UPEM };
