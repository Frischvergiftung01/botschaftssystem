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
//
// Dazu kommen die Spielzeiten: die Mapping-Shows laufen zur vollen und halben
// Stunde, die Minuten davor gehören den Botschaften. Nachgeladen wird deshalb
// nur, solange eine Session läuft. Ist gar kein Plan eingetragen, verhält sich
// alles wie vorher — sonst wäre ein Abend ohne gepflegte Zeiten eine dunkle
// Wand, und an Probetagen will man die Zeiten nicht pflegen müssen.

const cfg = require('./config');
const { FLAECHEN } = require('./flaechen');
const { groesseFuer } = require('./text');
const { abfragen } = require('./db');
const einstellungen = require('./einstellungen');
const sessionen = require('./sessionen');
const hinweise = require('./hinweise');
const belegungsplan = require('./belegungsplan');

// Laufender Zustand je Fläche — das ist genau das, was Simulator und Bridge lesen.
const zustand = new Map();
for (const [i, f] of FLAECHEN.entries()) {
  zustand.set(f.nr, {
    nr: f.nr,
    name: f.name,
    breite: f.breite,
    gruppe: f.gruppe,
    botschaftId: null,
    hinweisId: null,     // steht statt einer Botschaft ein Hinweis vom Platz hier?
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

// Der Belegungsplan: wer wann auf welche Fläche kommt, ein paar Minuten im
// Voraus. Er ist eine VORSCHALTUNG, keine Ablösung — findet sich für eine
// Fläche keine gültige Buchung, entscheidet der Scheduler wie eh und je.
// Damit degradiert ein Fehler im Plan zur alten Funktion und nicht zu einer
// dunklen Wand. Abschalten geht ohne Redeploy über den Schalter.
let plan = null;

function planAn () { return einstellungen.schalter().belegungsplan !== false; }

/** Ganz verwerfen — nur wenn sich die Lage grob ändert (Standzeit, Leeren). */
function planVerwerfen () { plan = null; }

/** Buchungen einzelner Botschaften streichen. Der Rest der Zusagen bleibt. */
function planStreichen (ids) { return belegungsplan.streichen(plan, ids); }

/** Alle Buchungen einer Fläche streichen — etwa wenn Hinweise umgeschaltet werden. */
function planFlaecheLeeren (nr) {
  if (!plan) return 0;
  const vorher = plan.eintraege.length;
  plan.eintraege = plan.eintraege.filter(e => e.flaeche !== nr);
  return vorher - plan.eintraege.length;
}

/**
 * Hält den Plan auf Länge. Er wird NICHT neu gerechnet, sondern hinten
 * verlängert: eine einmal gegebene Ortsangabe soll halten. Würde alle paar
 * Minuten alles neu verteilt, stünde die Botschaft, für die eben noch
 * „Säule Mitte 04" angesagt war, plötzlich woanders.
 */
let letztesNachziehen = 0;

function planPflegen (t) {
  if (!planAn()) { plan = null; return; }
  const horizontMs = cfg.planHorizontSekunden * 1000;
  if (plan && belegungsplan.reichweite(plan, t) > horizontMs * 0.6) return;
  // Bleibt eine Fläche dauerhaft unbelegbar — nichts im Vorrat passt lesbar
  // darauf —, meldet die Reichweite immer null. Ohne diese Bremse würde dann
  // in jedem Takt nachgerechnet.
  if (plan && t - letztesNachziehen < 1000) return;
  letztesNachziehen = t;
  const neu = belegungsplan.bauen({
    zustand,
    vorrat: abfragen.spielbar.all(),
    hinweise: hinweise.scharfeListe(),
    jetzt: t,
    standzeitMs: einstellungen.standzeit() * 1000,
    horizontMs,
    endeMs: sessionen.nachschubBis(),
    gebucht: plan ? plan.eintraege : []
  });
  if (!plan) plan = { erstelltAm: t, eintraege: [] };
  plan.eintraege.push(...neu.eintraege);
}

/** Der laufende Plan — für die Auskunft an den Absender. */
function derPlan () { return plan; }

function jetzt () { return Date.now(); }

/**
 * Darf jetzt nachgeladen werden? Zwei Bedingungen, und sie sind verschieden
 * gemeint: der Handschalter ist der weiche Not-Aus der Moderation, die
 * Spielzeit ist der Takt des Abends. Beide halten nur den Nachschub an —
 * was steht, läuft in beiden Fällen normal aus.
 */
function nachladenErlaubt () {
  const s = einstellungen.schalter();
  if (!s.nachschub) return false;
  // Im Einrichtungsmodus sieht niemand die Botschaften — sie duerfen deshalb
  // auch nicht als gezeigt gezaehlt werden.
  if (s.einrichtung) return false;
  return sessionen.nachschubErlaubt();
}

/** Eine Runde: jede abgelaufene Fläche bekommt eine neue Botschaft. */
function takt () {
  // Angehalten heißt auch: der Plan ist hinfällig. Was gebucht war, wäre nach
  // der Pause zeitlich falsch — er wird beim Weiterlaufen neu aufgebaut.
  if (!nachladenErlaubt()) { plan = null; return; } // Laufendes läuft aus
  const t = jetzt();
  planPflegen(t);
  // Nie zwei Wechsel im selben Augenblick — sonst flackert die halbe Fassade auf einmal.
  const mindestabstand = Math.max(200, Math.round((einstellungen.standzeit() * 1000) / FLAECHEN.length / 2));
  for (const f of zustand.values()) {
    if (t < f.ende) continue;
    if (t - letzterWechsel < mindestabstand) break;
    if (belegen(f, t)) letzterWechsel = t;
  }
}

/**
 * Sucht die nächste passende Botschaft für eine Fläche und trägt sie ein.
 *
 * Vorrang hat die Stirnseite Mitte, solange dort Hinweise vom Platz scharf
 * stehen: dann gehört sie ihnen. Umleiten muss man dafür nichts — der
 * Scheduler teilt nicht im Voraus zu, sondern sucht beim Belegen aus dem
 * Vorrat, also verteilen sich die Publikumsbotschaften von selbst auf die
 * übrigen 32 Flächen.
 */
function belegen (f, t) {
  // Erst die Buchung. Gilt sie nicht mehr — die Botschaft wurde inzwischen
  // abgelehnt, der Hinweis herausgenommen —, fällt es auf den alten Weg
  // zurück, und die Fläche bleibt keine Sekunde leer.
  if (planAn() && ausPlanNehmen(f, t)) return true;

  if (f.nr === cfg.hinweisFlaeche) {
    const h = hinweise.naechster(f.hinweisId);
    if (h) return hinweisSetzen(f, h, t);
  }
  const kandidaten = abfragen.spielbar.all();
  if (kandidaten.length === 0) return false;

  const laufendeIds = new Set([...zustand.values()].filter(x => x.nr !== f.nr && x.ende > t).map(x => x.botschaftId));

  for (const b of kandidaten) {
    if (laufendeIds.has(b.id)) continue;           // nicht zweimal gleichzeitig an der Fassade
    if (b.id === f.botschaftId) continue;          // nicht direkt wiederholen
    const voll = vollerText(b);
    const g = groesseFuer(voll, f.breite, cfg.maxVersalhoehe);
    if (g.versalhoehe < cfg.minVersalhoehe) continue; // passt hier nicht lesbar drauf

    return botschaftSetzen(f, b, t, g, voll);
  }
  return false;
}

/** Trägt eine Botschaft auf einer Fläche ein und schreibt sie fort. */
function botschaftSetzen (f, b, t, g, voll) {
  const ende = t + einstellungen.standzeit() * 1000;
  f.botschaftId = b.id;
  // Zuruecksetzen, sonst gilt die Flaeche nach einem Hinweis weiter als
  // belegt von ihm — und die Anzeige weist eine Publikumsbotschaft als
  // Durchsage aus.
  f.hinweisId = null;
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

/**
 * Holt die nächste Buchung dieser Fläche aus dem Plan und prüft sie gegen die
 * Wirklichkeit. Die Buchung wird in jedem Fall verbraucht: gilt sie nicht
 * mehr, ist sie hinfällig und darf nicht beim nächsten Wechsel wiederkommen.
 */
function ausPlanNehmen (f, t) {
  if (!plan || !plan.eintraege.length) return false;
  let i = -1;
  for (let k = 0; k < plan.eintraege.length; k++) {
    const e = plan.eintraege[k];
    if (e.flaeche !== f.nr) continue;
    if (i === -1 || e.start < plan.eintraege[i].start) i = k;
  }
  if (i === -1) return false;
  const e = plan.eintraege[i];
  plan.eintraege.splice(i, 1);

  if (e.hinweisId !== null) {
    const h = hinweise.nachId(e.hinweisId);
    if (!h || !h.scharf || !h.text.trim()) return false;
    return hinweisSetzen(f, h, t);
  }

  const b = abfragen.perId.get(e.botschaftId);
  if (!b || b.status !== 'freigegeben') return false;
  // Zweimal gleichzeitig an der Fassade geht nicht — der Plan rechnet das mit,
  // aber ein Rückfall an anderer Stelle kann ihm zuvorgekommen sein.
  for (const x of zustand.values()) {
    if (x.nr !== f.nr && x.ende > t && x.botschaftId === b.id) return false;
  }
  if (b.id === f.botschaftId) return false;
  return botschaftSetzen(f, b, t, e.groesse, vollerText(b));
}

/**
 * Trägt einen Hinweis vom Platz auf der Stirnseite Mitte ein. Kein Eintrag in
 * `anzeigen`: dort hängt ein Fremdschlüssel auf `botschaften`, und ein Hinweis
 * ist keine. Gezählt wird auf seiner eigenen Zeile.
 */
function hinweisSetzen (f, h, t) {
  const g = groesseFuer(h.text, f.breite, cfg.maxVersalhoehe);
  f.botschaftId = null;
  f.hinweisId = h.id;
  f.text = h.text;
  f.absender = null;          // ein Hinweis hat keinen
  f.start = t;
  f.ende = t + einstellungen.standzeit() * 1000;
  f.groesse = g;
  hinweise.gezeigt(h.id, t);
  return true;
}

/**
 * Nimmt Botschaften sofort von der Fassade — für Ablehnen und Sperren aus der
 * Moderation. Die Fläche wird frei und bekommt im nächsten Takt eine andere.
 * @param {Iterable<number>} ids
 * @returns {number} Anzahl geräumter Flächen
 */
function entfernen (ids) {
  const menge = new Set([...ids].map(Number));
  // Auch aus dem Plan nehmen: eine abgelehnte Botschaft darf nicht in drei
  // Minuten aus einer alten Buchung wieder auftauchen.
  planStreichen(menge);
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
  planVerwerfen();
  for (const f of zustand.values()) raeumen(f);
}

function raeumen (f) {
  f.botschaftId = null;
  f.hinweisId = null;
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
    // Für die Fassade macht es keinen Unterschied — für Simulator, Statusseite
    // und spätere Auswertung schon: das hier kam nicht aus dem Publikum.
    hinweis: f.ende > t && f.hinweisId !== null,
    restSekunden: f.ende > t ? Math.round((f.ende - t) / 100) / 10 : 0,
    schrifthoehe: f.groesse ? f.groesse.schrifthoehe : null,
    versalhoehe: f.groesse ? f.groesse.versalhoehe : null,
    yVersatz: f.groesse ? f.groesse.yVersatz : null
  }));
}

module.exports = {
  starten, takt, anzeige, zustand, vollerText, entfernen, alleEntfernen, nachladenErlaubt,
  derPlan, planVerwerfen, planStreichen, planFlaecheLeeren, planPflegen, planAn
};
