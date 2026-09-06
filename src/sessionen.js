// Die Spielzeiten des Abends.
//
// Die Mapping-Shows laufen zur vollen und zur halben Stunde; die rund
// siebzehn Minuten davor gehoeren den Botschaften. Jede dieser Runden ist
// hier eine Session.
//
// Zwei Zeiten je Zeile, und sie wiegen verschieden schwer:
//
//   geplant_start   unverbindlich. Er speist den Countdown in der Moderation
//                   und die Auskunft an den Absender ("kommt ab ca. 19:43").
//                   Gestartet wird von Hand: faellt die Show einmal spaeter,
//                   liefe ein automatischer Start mitten hinein.
//
//   geplant_ende    verbindlich, und es bedeutet: DANN IST DIE WAND LEER.
//                   Der Nachschub hoert deshalb eine Standzeit frueher auf,
//                   damit die letzte Botschaft punktgenau ausgelaufen ist.
//                   Die Blende von 0,35 s wird bewusst nicht eingerechnet.
//
// Keine Session laeuft ueber Mitternacht. Deshalb genuegen Minuten seit
// Mitternacht als Planwert. Der echte Start und das echte Ende werden beim
// Starten gegen den laufenden Tag aufgeloest und stehen als Zeitstempel in
// der Datenbank — so uebersteht eine laufende Session einen Neustart des
// Dienstes oder einen Redeploy mitten am Abend.

const cfg = require('./config');
const { db, abfragen } = require('./db');
const einstellungen = require('./einstellungen');

// ------------------------------------------------------------------ Zeitzone
// Der Dienst laeuft in Coolify, also sehr wahrscheinlich auf UTC. Die
// eingetragenen Uhrzeiten meinen aber Ortszeit am Koenigsbau. Ohne diese
// Umrechnung laege der ganze Abend um eine Stunde daneben.

/** Versatz der Veranstaltungszeitzone gegen UTC in Minuten, zum Zeitpunkt t. */
function versatzMinuten (t) {
  const teile = new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.zeitzone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(t));
  const g = {};
  for (const teil of teile) g[teil.type] = teil.value;
  const alsWaereEsUtc = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour % 24, +g.minute, +g.second);
  return Math.round((alsWaereEsUtc - t) / 60000);
}

/** Zeitstempel fuer "heute um HH:MM" in der Veranstaltungszeitzone. */
function heuteUm (minuten, bezug = Date.now()) {
  const v = versatzMinuten(bezug);
  const ortsMitternacht = Math.floor((bezug + v * 60000) / 86400000) * 86400000 - v * 60000;
  return ortsMitternacht + minuten * 60000;
}

/** "19:29" -> 1169. Gibt null zurueck, wenn es keine Uhrzeit ist. */
function ausUhrzeit (s) {
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const std = Number(m[1]);
  const min = Number(m[2]);
  if (std > 23 || min > 59) return null;
  return std * 60 + min;
}

/** 1169 -> "19:29" */
function alsUhrzeit (minuten) {
  const m = ((Math.round(minuten) % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

// ------------------------------------------------------------------ Zustand
// Der Scheduler fragt viermal je Sekunde, ob er nachladen darf. Deshalb liegen
// die Planzeilen im Zwischenspeicher — wie bei den Schaltern. Ausgewertet wird
// jedes Mal frisch gegen die Uhr; das ist eine Handvoll Zeilen und kostet nichts.

let zeilenSpeicher = null;
function vergessen () { zeilenSpeicher = null; }

function alleZeilen () {
  if (!zeilenSpeicher) zeilenSpeicher = abfragen.sessionenListe.all();
  return zeilenSpeicher;
}

/** Steht ueberhaupt ein Plan? Ohne Plan gelten keine Spielzeiten. */
function geplant () { return alleZeilen().length > 0; }

/**
 * Die laufende Session, oder null.
 * Laufend heisst: gestartet, nicht abgebrochen, und das Ende ist noch nicht da.
 */
function laufende (jetzt = Date.now()) {
  return alleZeilen().find(s =>
    s.start !== null && s.ende !== null && s.ende > jetzt && !s.abgebrochen) || null;
}

/**
 * Die naechste Session, die noch gestartet werden kann: noch nicht gestartet,
 * nicht abgebrochen, und ihr geplantes Ende liegt noch in der Zukunft.
 * Verpasste Runden fallen damit von selbst heraus — kein eigenes Kennzeichen
 * noetig, und keine Zeile, die man am Abend noch aufraeumen muesste.
 */
function naechste () {
  const jetzt = Date.now();
  return alleZeilen().find(s =>
    s.start === null && !s.abgebrochen && heuteUm(s.geplant_ende) > jetzt) || null;
}

/**
 * Darf der Scheduler nachladen?
 *
 * Steht kein Plan, laeuft das System wie vor den Spielzeiten einfach durch.
 * Das ist die wichtige Zeile in dieser Datei: ohne sie waere ein Deploy an
 * einem Tag ohne eingetragene Zeiten eine dunkle Wand, und an Probetagen
 * muesste man Zeiten pflegen, die niemanden interessieren.
 *
 * Steht ein Plan, dann genau solange eine Runde laeuft und bis zu ihrem Ende
 * noch eine volle Standzeit passt — so ist die letzte Botschaft punktgenau
 * zum eingetragenen Ende ausgelaufen.
 */
function nachschubErlaubt (jetzt = Date.now()) {
  if (!geplant()) return true;
  const l = laufende(jetzt);
  if (!l) return false;
  return jetzt < l.ende - einstellungen.standzeit() * 1000;
}

/**
 * Zeitpunkt, ab dem nichts mehr nachgeladen wird — Sessionende minus eine
 * Standzeit. Der Belegungsplan bucht nicht darueber hinaus. Ohne Plan des
 * Abends gibt es keine Grenze.
 */
function nachschubBis () {
  if (!geplant()) return null;
  const l = laufende();
  return l ? l.ende - einstellungen.standzeit() * 1000 : null;
}

// ------------------------------------------------------------------ Aendern

/**
 * Ersetzt die Planung. Die Oberflaeche schickt immer die ganze Tabelle —
 * einzelne Zeilen zu wandern waere mehr Buchhaltung als es wert ist.
 *
 * Gestartete Sessions behalten ihre echten Zeitstempel: wer waehrend des
 * Abends eine spaetere Runde verschiebt, soll die laufende nicht verlieren.
 */
const speichernTx = db.transaction((zeilen) => {
  const jetzt = Date.now();
  const alt = new Map(alleZeilen().map(s => [s.nr, s]));
  abfragen.sessionenLeeren.run();
  let n = 0;
  for (const [i, z] of zeilen.entries()) {
    const nr = i + 1;
    const frueher = alt.get(nr);
    // Nur eine GERADE LAUFENDE Runde zieht ein geaendertes Ende mit — genau
    // dafuer schiebt man am Abend eine Zeit. Eine bereits gelaufene bleibt,
    // wie sie war: sonst weckt eine spaetere Planaenderung eine
    // abgeschlossene Runde wieder auf, und die Wand geht unvermittelt an.
    const laeuftGerade = Boolean(frueher && frueher.start !== null &&
      !frueher.abgebrochen && frueher.ende !== null && frueher.ende > jetzt);
    abfragen.sessionEinfuegen.run({
      nr,
      geplant_start: z.geplantStart,
      geplant_ende: z.geplantEnde,
      start: frueher ? frueher.start : null,
      ende: laeuftGerade ? heuteUm(z.geplantEnde, jetzt) : (frueher ? frueher.ende : null),
      abgebrochen: frueher ? frueher.abgebrochen : 0
    });
    n++;
  }
  return n;
});

function speichern (rohzeilen) {
  const zeilen = [];
  for (const r of rohzeilen || []) {
    const a = typeof r.geplantStart === 'number' ? r.geplantStart : ausUhrzeit(r.geplantStart);
    const e = typeof r.geplantEnde === 'number' ? r.geplantEnde : ausUhrzeit(r.geplantEnde);
    if (a === null || e === null) throw new Error('Bitte Uhrzeiten als HH:MM eintragen.');
    if (e <= a) throw new Error(`Zeile ${zeilen.length + 1}: Das Ende liegt vor dem Anfang.`);
    zeilen.push({ geplantStart: a, geplantEnde: e });
  }
  zeilen.sort((x, y) => x.geplantStart - y.geplantStart);
  const n = speichernTx(zeilen);
  vergessen();
  return n;
}

/**
 * Startet die naechste Runde. Das Ende kommt aus der Planung und nicht aus der
 * Dauer: die Fassadenshow folgt einem festen Takt, ein spaeter Start verkuerzt
 * die Runde. Wie kurz sie dadurch wird, steht in der Antwort — die Oberflaeche
 * sagt es vor dem Klick an.
 */
function starten () {
  if (laufende()) throw new Error('Es laeuft bereits eine Session.');
  const s = naechste();
  if (!s) throw new Error('Keine weitere Session geplant.');
  const jetzt = Date.now();
  const ende = heuteUm(s.geplant_ende);
  abfragen.sessionStarten.run({ id: s.id, start: jetzt, ende });
  vergessen();
  return stand();
}

/** Bricht die laufende Runde sofort ab. Laufendes blendet aus, Neues kommt nicht. */
function abbrechen () {
  const l = laufende();
  if (!l) throw new Error('Es laeuft keine Session.');
  abfragen.sessionAbbrechen.run({ id: l.id, ende: Date.now() });
  vergessen();
  return stand();
}

// ------------------------------------------------------------------ Auskunft

function zeileNachAussen (s, jetzt) {
  const geplantEndeStempel = heuteUm(s.geplant_ende, jetzt);
  return {
    nr: s.nr,
    geplantStart: alsUhrzeit(s.geplant_start),
    geplantEnde: alsUhrzeit(s.geplant_ende),
    start: s.start,
    ende: s.ende,
    abgebrochen: Boolean(s.abgebrochen),
    gelaufen: s.start !== null,
    verpasst: s.start === null && !s.abgebrochen && geplantEndeStempel <= jetzt
  };
}

/**
 * Der Sessionstand, wie ihn Moderation und Statusseite brauchen.
 *
 * `phase` unterscheidet drei Lagen, die sich unterschiedlich anfuehlen:
 *   laeuft     — es wird nachgeladen
 *   laeuftAus  — die letzten Botschaften stehen noch, Neues kommt nicht mehr
 *   pause      — zwischen zwei Runden
 */
function stand (jetzt = Date.now()) {
  const l = laufende();
  const n = naechste();
  const zeilen = alleZeilen().map(s => zeileNachAussen(s, jetzt));

  let aktuell = null;
  if (l) {
    const nachschubBis = l.ende - einstellungen.standzeit() * 1000;
    aktuell = {
      nr: l.nr,
      start: l.start,
      ende: l.ende,
      // Ab hier kommt nichts Neues mehr an die Wand. Absolut, damit die
      // Oberflaeche sekuendlich mitzaehlen kann, ohne sekuendlich zu fragen.
      nachschubBis,
      endeUhrzeit: alsUhrzeit(l.geplant_ende),
      phase: jetzt < nachschubBis ? 'laeuft' : 'laeuftAus',
      restSekunden: Math.max(0, Math.round((l.ende - jetzt) / 1000)),
      nachschubRestSekunden: Math.max(0, Math.round((nachschubBis - jetzt) / 1000))
    };
  }

  let kommend = null;
  if (n) {
    const startStempel = heuteUm(n.geplant_start, jetzt);
    const endeStempel = heuteUm(n.geplant_ende, jetzt);
    kommend = {
      nr: n.nr,
      geplantStart: alsUhrzeit(n.geplant_start),
      geplantEnde: alsUhrzeit(n.geplant_ende),
      startStempel,
      endeStempel,
      // Negativ, wenn der geplante Start schon vorbei ist. Die Oberflaeche
      // zaehlt dann rot weiter — vergessen soll man den Knopf nicht.
      sekundenBisStart: Math.round((startStempel - jetzt) / 1000),
      // Wie lang die Runde noch waere, wenn man jetzt startet. Steht auf dem
      // Knopf: ein spaeter Start verkuerzt die Runde, und das soll man im
      // Moment des Klickens sehen und nicht hinterher merken.
      laengeBeiSofortstartSekunden: Math.max(0, Math.round((endeStempel - jetzt) / 1000))
    };
  }

  return {
    // Serveruhr, damit die Oberflaeche ihren eigenen Versatz herausrechnen
    // und die Zeitstempel oben selbst herunterzaehlen kann.
    zeit: jetzt,
    // ohnePlan heisst: die Spielzeiten sind gar nicht in Betrieb, das System
    // laeuft durch. Fuer die Oberflaeche ein anderer Zustand als eine Pause
    // zwischen zwei Runden, und er soll auch anders aussehen.
    phase: aktuell ? aktuell.phase : (geplant() ? 'pause' : 'ohnePlan'),
    nachschubErlaubt: nachschubErlaubt(jetzt),
    aktuell,
    kommend,
    zeilen,
    anzahl: zeilen.length
  };
}

module.exports = {
  stand, speichern, starten, abbrechen, laufende, naechste, geplant,
  nachschubErlaubt, nachschubBis, vergessen, alsUhrzeit, ausUhrzeit, heuteUm
};
