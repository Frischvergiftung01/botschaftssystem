// Fuellsel — eigene Texte, die Luecken schliessen.
//
// DER FALL. Um 18 Uhr ist noch nichts eingegangen; die Fassade stuende leer,
// waehrend die ersten Besucher davorstehen und ueberlegen, ob das Ding
// ueberhaupt laeuft. Dasselbe passiert in Loechern zwischendurch und auf den
// schmalen Saeulen, auf die eine lange Botschaft nicht lesbar passt.
//
// VIER ENTSCHEIDUNGEN:
//
// 1. EIGENE TABELLE, wie bei den Hinweisen. Diese Texte kommen nicht aus dem
//    Publikum. Sie duerfen nicht in der Moderationsqueue auftauchen und die
//    Kennzahlen des Abends nicht faerben — am Ende soll dastehen, wie viele
//    Botschaften WIRKLICH eingegangen und gezeigt worden sind.
//
// 2. NUR IN DIE LUECKE. Ein Fuellsel kommt erst, wenn der Scheduler fuer eine
//    Flaeche sonst nichts findet. Es verdraengt nie eine Botschaft, es wartet
//    auch nicht auf seinen Turnus — es ist das, was statt Dunkelheit kommt.
//
// 3. MIT DECKEL. Hoechstens ein Drittel der Flaechen (Vorgabe 11 von 33) darf
//    gleichzeitig Fuellsel zeigen. Sonst steht am leeren Anfang eine volle
//    Wand eigener Saetze da, und das sieht aus wie eine Werbetafel statt wie
//    eine Wand, die auf Botschaften wartet.
//
// 4. VORBEREITET, ABER AUS. Die Vorschlagstexte werden beim ersten Aufschlag
//    angelegt und sind alle INAKTIV. Was auf der Fassade steht, entscheidet
//    niemand versehentlich.

const cfg = require('./config');
const { db, abfragen } = require('./db');
const { groesseFuer } = require('./text');

// Vorschlaege fuer den Anfang. Kurz gehalten: sie sollen auch auf eine
// Kolonnadensaeule (437 px) noch lesbar passen.
const VORSCHLAEGE = [
  'Willkommen am Königsbau',
  'Deine Botschaft hier — QR-Code am Stand',
  'Stuttgart leuchtet',
  'Schreib etwas Schönes',
  'Gleich geht es weiter',
  'Grüße an alle auf dem Schlossplatz',
  'Schön, dass ihr da seid',
  'Die Wand wartet auf dich'
];

let speicher = null;
function vergessen () { speicher = null; }

/** Alle Plaetze. Zwischengespeichert — der Scheduler fragt viermal je Sekunde. */
function alle () {
  if (!speicher) speicher = abfragen.fuellselListe.all();
  return speicher;
}

const anlegenTx = db.transaction((texte) => {
  for (const [i, text] of texte.entries()) {
    abfragen.fuellselEinfuegen.run({
      nr: i + 1, text, aktiv: 0, anzahl_anzeigen: 0, zuletzt_gezeigt: null
    });
  }
});

function sicherstellen () {
  if (alle().length) return alle();
  anlegenTx(VORSCHLAEGE.slice(0, Math.max(1, cfg.fuellselPlaetze)));
  vergessen();
  return alle();
}

function aktive () {
  return alle().filter(f => f.aktiv && f.text.trim());
}

/** Ist ueberhaupt etwas aktiv? Spart dem Scheduler die weitere Rechnerei. */
function aktiveVorhanden () { return aktive().length > 0; }

/**
 * Der naechste Fuellsel fuer eine bestimmte Flaeche.
 *
 * Reihum wie im Botschaftsvorrat: wer am seltensten dran war, kommt zuerst.
 * Zwei Ausschluesse: was gerade auf dieser Flaeche steht, und was auf der
 * Flaeche nicht lesbar waere — ein zu kleiner Text ist keine Fuellung,
 * sondern ein Schmutzfleck.
 *
 * @param {object} flaeche  Flaeche aus FLAECHEN (braucht `breite`)
 * @param {number|null} zuletztId  was dort gerade steht
 * @param {Set<number>} laufende   Fuellsel, die auf anderen Flaechen stehen
 */
function naechsterFuer (flaeche, zuletztId = null, laufende = new Set()) {
  const passend = aktive()
    .filter(f => f.id !== zuletztId)
    .filter(f => !laufende.has(f.id))
    .map(f => ({ zeile: f, g: groesseFuer(f.text, flaeche.breite, cfg.maxVersalhoehe) }))
    .filter(x => x.g.versalhoehe >= cfg.minVersalhoehe)
    .sort((a, b) =>
      a.zeile.anzahl_anzeigen - b.zeile.anzahl_anzeigen ||
      (a.zeile.zuletzt_gezeigt || 0) - (b.zeile.zuletzt_gezeigt || 0) ||
      a.zeile.nr - b.zeile.nr);
  return passend.length ? { ...passend[0].zeile, groesse: passend[0].g } : null;
}

/** Zaehlwerk nach einer Einblendung — nur in dieser Tabelle. */
function gezeigt (id, zeit) {
  abfragen.fuellselGezeigt.run({ id, zeit });
  vergessen();
}

// ------------------------------------------------------------------ Aendern

const speichernTx = db.transaction((zeilen) => {
  const alt = new Map(alle().map(f => [f.nr, f]));
  abfragen.fuellselLeeren.run();
  for (const [i, z] of zeilen.entries()) {
    const nr = i + 1;
    const frueher = alt.get(nr);
    abfragen.fuellselEinfuegen.run({
      nr,
      text: z.text,
      // Ein leerer Platz kann nicht aktiv sein.
      aktiv: z.text.trim() && z.aktiv ? 1 : 0,
      anzahl_anzeigen: frueher ? frueher.anzahl_anzeigen : 0,
      zuletzt_gezeigt: frueher ? frueher.zuletzt_gezeigt : null
    });
  }
  return zeilen.length;
});

function speichern (rohzeilen) {
  const zeilen = [];
  for (const r of rohzeilen || []) {
    const text = String(r.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > cfg.maxZeichenFuellsel) {
      throw new Error(`Platz ${zeilen.length + 1}: höchstens ${cfg.maxZeichenFuellsel} Zeichen.`);
    }
    zeilen.push({ text, aktiv: Boolean(r.aktiv) });
  }
  const n = speichernTx(zeilen);
  vergessen();
  return n;
}

function aktivSetzen (nr, wert) {
  const f = alle().find(x => x.nr === Number(nr));
  if (!f) throw new Error('Diesen Platz gibt es nicht.');
  if (wert && !f.text.trim()) throw new Error('Ein leerer Platz lässt sich nicht aktivieren.');
  abfragen.fuellselAktiv.run({ nr: f.nr, aktiv: wert ? 1 : 0 });
  vergessen();
  return stand();
}

// ------------------------------------------------------------------ Auskunft

/**
 * Auf wie vielen der 33 Flaechen waere dieser Text lesbar? Die Zahl steht in
 * der Moderation neben jedem Platz: ein langer Fuellsel passt nur auf die
 * Stirnseiten und fuellt die schmalen Saeulen dann eben nicht.
 */
function passendeFlaechen (text) {
  const { FLAECHEN } = require('./flaechen');
  return FLAECHEN.filter(f =>
    groesseFuer(text, f.breite, cfg.maxVersalhoehe).versalhoehe >= cfg.minVersalhoehe).length;
}

function stand () {
  const zeilen = sicherstellen().map(f => ({
    nr: f.nr,
    text: f.text,
    aktiv: Boolean(f.aktiv),
    anzahlAnzeigen: f.anzahl_anzeigen,
    zuletztGezeigt: f.zuletzt_gezeigt,
    passendeFlaechen: f.text.trim() ? passendeFlaechen(f.text) : 0
  }));
  return {
    maxZeichen: cfg.maxZeichenFuellsel,
    deckel: cfg.fuellselDeckel,
    aktive: zeilen.filter(z => z.aktiv).length,
    zeilen
  };
}

module.exports = {
  stand, speichern, aktivSetzen, naechsterFuer, gezeigt, aktive, aktiveVorhanden,
  sicherstellen, vergessen, passendeFlaechen, VORSCHLAEGE
};
