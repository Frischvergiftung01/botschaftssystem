// Hinweise vom Platz — organisatorische Durchsagen auf der Stirnseite Mitte.
//
// Der Fall dahinter: waehrend der Runde faellt auf, dass etwas gesagt werden
// muss. "Letzte Runde um 22:30." "Bitte den Durchgang freihalten." Dafuer
// stehen vorbereitete Plaetze bereit, die man am Abend nur noch scharf stellt.
//
// Drei Entscheidungen, die den Rest erklaeren:
//
// 1. EIGENE TABELLE, nicht `botschaften`. Diese Texte kommen nicht aus dem
//    Publikum. Sie gehen durch keinen Filter, brauchen keine Moderation, haben
//    keinen Absender und keinen Statuszettel — und sie duerfen die Kennzahlen
//    des Abends nicht verfaelschen. Ein Flag auf botschaften haette jede
//    Abfrage im Haus mit einer Ausnahme belastet.
//
// 2. GENAU EINE FLAECHE. Die Stirnseite Mitte ist mit 2280 px die breiteste
//    und vom Vorplatz aus die am besten lesbare. Solange dort ein Hinweis
//    scharf steht, gehoert sie ihm; die Publikumsbotschaften verteilen sich
//    von selbst auf die uebrigen 32. Umleiten muss man dafuer nichts: der
//    Scheduler teilt nicht im Voraus zu, er sucht beim Belegen aus dem Vorrat.
//
// 3. NICHTS WIRD UNTERBROCHEN. Scharfstellen wirkt beim naechsten Wechsel der
//    Flaeche, nicht sofort — die laufende Botschaft laeuft aus. Und Rausnehmen
//    ebenso: der Hinweis steht seine Standzeit zu Ende, dann ist die Flaeche
//    wieder frei. Das ist im ganzen System so, vom Nachschub-Schalter bis zum
//    Sessionende, und soll hier keine Ausnahme werden.

const cfg = require('./config');
const { db, abfragen } = require('./db');
const { FLAECHEN } = require('./flaechen');
const { groesseFuer } = require('./text');

const FLAECHE = FLAECHEN.find(f => f.nr === cfg.hinweisFlaeche) || FLAECHEN[0];

let speicher = null;
function vergessen () { speicher = null; }

/** Alle Plaetze. Zwischengespeichert — der Scheduler fragt viermal je Sekunde. */
function alle () {
  if (!speicher) speicher = abfragen.hinweiseListe.all();
  return speicher;
}

/**
 * Beim ersten Aufschlag stehen noch keine Plaetze in der Datenbank. Sie hier
 * anzulegen statt in db.js haelt das Schema frei von Inhalt.
 */
const anlegenTx = db.transaction((anzahl) => {
  for (let i = 1; i <= anzahl; i++) {
    abfragen.hinweisEinfuegen.run({ nr: i, text: '', scharf: 0, anzahl_anzeigen: 0, zuletzt_gezeigt: null });
  }
});

function sicherstellen () {
  if (alle().length) return alle();
  anlegenTx(Math.max(1, cfg.hinweisPlaetze));
  vergessen();
  return alle();
}

/** Steht irgendein Hinweis scharf? Der Scheduler fragt das bei jedem Wechsel. */
function scharfeVorhanden () {
  return alle().some(h => h.scharf && h.text.trim());
}

/**
 * Der naechste Hinweis, der an die Wand soll. Reihum: wer am seltensten dran
 * war, kommt zuerst — dieselbe Regel wie im Botschaftsvorrat. Steht schon
 * einer auf der Flaeche, wird er nicht direkt wiederholt, solange es einen
 * zweiten gibt.
 * @param {number|null} zuletztId Hinweis, der gerade auf der Flaeche steht
 */
function naechster (zuletztId = null) {
  const scharfe = alle().filter(h => h.scharf && h.text.trim());
  if (!scharfe.length) return null;
  const sortiert = [...scharfe].sort((a, b) =>
    a.anzahl_anzeigen - b.anzahl_anzeigen ||
    (a.zuletzt_gezeigt || 0) - (b.zuletzt_gezeigt || 0) ||
    a.nr - b.nr);
  if (sortiert.length > 1 && sortiert[0].id === zuletztId) return sortiert[1];
  return sortiert[0];
}

/** Die scharfen Plaetze als Rohzeilen — fuer den Belegungsplan. */
function scharfeListe () {
  return alle().filter(h => h.scharf && h.text.trim());
}

/** Ein Platz nach seiner id. Der Plan bucht ids, nicht Nummern. */
function nachId (id) {
  return alle().find(h => h.id === id) || null;
}

/** Zaehlwerk nach einer Einblendung. */
function gezeigt (id, zeit) {
  abfragen.hinweisGezeigt.run({ id, zeit });
  vergessen();
}

// ------------------------------------------------------------------ Aendern

const speichernTx = db.transaction((zeilen) => {
  const alt = new Map(alle().map(h => [h.nr, h]));
  abfragen.hinweiseLeeren.run();
  for (const [i, z] of zeilen.entries()) {
    const nr = i + 1;
    const frueher = alt.get(nr);
    const text = z.text;
    // Ein leerer Platz kann nicht scharf sein — sonst stuende die Flaeche
    // gesperrt, ohne dass etwas darauf zu sehen waere.
    const scharf = text.trim() && z.scharf ? 1 : 0;
    abfragen.hinweisEinfuegen.run({
      nr, text, scharf,
      // Zaehler wandern mit, damit das Reihum nach einer Textkorrektur nicht
      // von vorn beginnt.
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
    if (text.length > cfg.maxZeichenHinweis) {
      throw new Error(`Platz ${zeilen.length + 1}: höchstens ${cfg.maxZeichenHinweis} Zeichen.`);
    }
    zeilen.push({ text, scharf: Boolean(r.scharf) });
  }
  const n = speichernTx(zeilen);
  vergessen();
  return n;
}

/** Einen Platz scharf stellen oder herausnehmen. */
function scharfSetzen (nr, wert) {
  const h = alle().find(x => x.nr === Number(nr));
  if (!h) throw new Error('Diesen Platz gibt es nicht.');
  if (wert && !h.text.trim()) throw new Error('Ein leerer Platz lässt sich nicht scharf stellen.');
  abfragen.hinweisScharf.run({ nr: h.nr, scharf: wert ? 1 : 0 });
  vergessen();
  return stand();
}

// ------------------------------------------------------------------ Auskunft

/**
 * Wie der Text auf der Stirnseite Mitte aussaehe — dieselbe Rechnung wie im
 * Wire-Patch, damit die Vorschau in der Moderation nicht luegt.
 */
function optik (text) {
  const g = groesseFuer(text, FLAECHE.breite, cfg.maxVersalhoehe);
  return {
    flaeche: FLAECHE.nr,
    flaecheName: FLAECHE.name,
    breite: FLAECHE.breite,
    versalhoehe: g.versalhoehe,
    schrifthoehe: g.schrifthoehe,
    yVersatz: g.yVersatz,
    // Unter der Mindesthoehe waere der Text auch auf der breitesten Flaeche
    // nicht mehr zu lesen. Dann lieber gar nicht scharf stellen.
    lesbar: g.versalhoehe >= cfg.minVersalhoehe
  };
}

function stand () {
  const zeilen = sicherstellen().map(h => ({
    nr: h.nr,
    text: h.text,
    scharf: Boolean(h.scharf),
    anzahlAnzeigen: h.anzahl_anzeigen,
    zuletztGezeigt: h.zuletzt_gezeigt,
    optik: h.text.trim() ? optik(h.text) : null
  }));
  return {
    flaeche: { nr: FLAECHE.nr, name: FLAECHE.name, breite: FLAECHE.breite },
    maxZeichen: cfg.maxZeichenHinweis,
    minVersalhoehe: cfg.minVersalhoehe,
    scharfe: zeilen.filter(z => z.scharf).length,
    zeilen
  };
}

module.exports = {
  stand, speichern, scharfSetzen, naechster, gezeigt, scharfeVorhanden,
  scharfeListe, nachId, sicherstellen, vergessen, optik, FLAECHE
};
