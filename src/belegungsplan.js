// Der Belegungsplan — wer wann auf welche Fläche kommt, ein paar Minuten im
// Voraus.
//
// WOZU. Bis hierher entscheidet der Scheduler erst im Moment des Wechsels,
// welche Botschaft eine frei gewordene Fläche bekommt. Das genügt für die
// Fassade, aber nicht für die Auskunft an den Absender: "läuft jetzt" hilft
// niemandem, der am anderen Ende des Gebäudes steht. Gebraucht wird die
// Ansage vorher — und zwar mit Ort. Vorhersagen lässt sich das nicht, denn
// jede Moderationsentscheidung verschiebt das Ergebnis. Also wird gebucht:
// derselbe Algorithmus, nur vorher gerechnet.
//
// WIE GENAU. Der Plan ist eine Vorausrechnung, keine Garantie. Die Flächen
// wechseln in Wirklichkeit ein paar hundert Millisekunden später als hier
// gerechnet (der Scheduler drosselt bewusst), und jede Freigabe schiebt neue
// Botschaften in den Vorrat. Der ORT stimmt, solange der Plan gilt; die ZEIT
// ist eine gute Schätzung. Genau so wird es dem Absender auch gesagt.
//
// WAS ER NICHT MACHT. Er schreibt nichts in die Datenbank und rührt den
// laufenden Zustand nicht an. Gebaut wird auf einer Momentaufnahme, und das
// Ergebnis ist ein einfaches Objekt. Damit bleibt er prüfbar, und der
// Scheduler kann ihn jederzeit fallen lassen und weitermachen wie bisher.

const cfg = require('./config');
const { FLAECHEN } = require('./flaechen');
const { groesseFuer } = require('./text');

/**
 * Textmaße sind teuer und wiederholen sich stark: derselbe Text wird gegen
 * fünf verschiedene Flächenbreiten geprüft, und das über hunderte Zuteilungen.
 * Der Speicher lebt nur für einen Planlauf.
 */
function masswerk () {
  const abgelegt = new Map();
  return (text, breite) => {
    const schluessel = breite + ' ' + text;
    let g = abgelegt.get(schluessel);
    if (!g) { g = groesseFuer(text, breite, cfg.maxVersalhoehe); abgelegt.set(schluessel, g); }
    return g;
  };
}

/** Reihenfolge des Vorrats — dieselbe wie in der Abfrage `spielbar`. */
function vorne (a, b) {
  return a.anzahl - b.anzahl ||
    (a.zuletzt || 0) - (b.zuletzt || 0) ||
    a.erstellt - b.erstellt ||
    a.id - b.id;
}

/** Einsortieren statt neu sortieren: je Zuteilung wandert genau ein Eintrag. */
function einsortieren (liste, eintrag) {
  let tief = 0, hoch = liste.length;
  while (tief < hoch) {
    const mitte = (tief + hoch) >> 1;
    if (vorne(liste[mitte], eintrag) <= 0) tief = mitte + 1; else hoch = mitte;
  }
  liste.splice(tief, 0, eintrag);
}

/**
 * Rechnet den Belegungsplan aus.
 *
 * @param {object} lage Momentaufnahme, damit hier nichts aus der Datenbank
 *   gelesen und nichts hineingeschrieben wird.
 * @param {Map} lage.zustand    laufender Flächenzustand des Schedulers
 * @param {Array} lage.vorrat   spielbare Botschaften
 * @param {Array} lage.hinweise scharfe Hinweise vom Platz
 * @param {number} lage.jetzt
 * @param {number} lage.standzeitMs
 * @param {number} lage.horizontMs wie weit nach vorn gerechnet wird
 * @param {number} [lage.endeMs] Nachschubschluss der Session: danach wird
 *   nichts mehr belegt, also auch nichts mehr gebucht
 * @param {Array} [lage.gebucht] bereits vergebene, noch nicht abgearbeitete
 *   Einträge. Sie werden NICHT neu gerechnet, sondern nur eingefaltet — der
 *   Plan wächst hinten weiter. Das ist der Grund, warum eine einmal gegebene
 *   Ortsangabe hält: würde alle paar Minuten alles neu verteilt, stünde die
 *   Botschaft, für die eben noch „Säule Mitte 04" angesagt war, plötzlich
 *   woanders, und die Auskunft wäre wertlos.
 * @returns {{erstelltAm:number, reichtBis:number, eintraege:Array}} nur die
 *   NEUEN Einträge; die eingefalteten kommen nicht noch einmal zurück.
 */
function bauen (lage) {
  const { zustand, jetzt, standzeitMs, horizontMs } = lage;
  const mass = masswerk();
  const bis = jetzt + horizontMs;
  const schluss = typeof lage.endeMs === 'number' ? Math.min(bis, lage.endeMs) : bis;

  // Wann wird welche Fläche frei, und was steht gerade darauf?
  const frei = new Map();
  const zuletztDort = new Map();      // Flächennummer -> zuletzt gebuchte Botschaft
  const zuletztDurchsage = new Map(); // dasselbe für Hinweise
  const belegtBis = new Map();        // botschaftId -> bis wann sie an der Fassade steht
  for (const f of zustand.values()) {
    frei.set(f.nr, Math.max(jetzt, f.ende));
    zuletztDort.set(f.nr, f.botschaftId);
    zuletztDurchsage.set(f.nr, f.hinweisId);
    if (f.botschaftId !== null && f.ende > jetzt) belegtBis.set(f.botschaftId, f.ende);
  }

  // Schon Gebuchtes einfalten: die Flächen sind bis dahin besetzt, die
  // Botschaften bis dahin vergeben, und die Zähler zählen es mit.
  const schonGezeigt = new Map();     // botschaftId -> wie oft im Plan gebucht
  const zuletztGebucht = new Map();   // botschaftId -> spätester Start
  let letzterGebuchterWechsel = -Infinity;
  const spaetesteJeFlaeche = new Map();
  for (const e of (lage.gebucht || [])) {
    frei.set(e.flaeche, Math.max(frei.get(e.flaeche) || jetzt, e.ende));
    const bisher = spaetesteJeFlaeche.get(e.flaeche);
    if (!bisher || e.start > bisher.start) spaetesteJeFlaeche.set(e.flaeche, e);
    if (e.botschaftId !== null) {
      belegtBis.set(e.botschaftId, Math.max(belegtBis.get(e.botschaftId) || 0, e.ende));
      schonGezeigt.set(e.botschaftId, (schonGezeigt.get(e.botschaftId) || 0) + 1);
      zuletztGebucht.set(e.botschaftId, Math.max(zuletztGebucht.get(e.botschaftId) || 0, e.start));
    }
    if (e.hinweisId !== null) {
      schonGezeigt.set('h' + e.hinweisId, (schonGezeigt.get('h' + e.hinweisId) || 0) + 1);
      zuletztGebucht.set('h' + e.hinweisId, Math.max(zuletztGebucht.get('h' + e.hinweisId) || 0, e.start));
    }
    if (e.start > letzterGebuchterWechsel) letzterGebuchterWechsel = e.start;
  }
  for (const [nr, e] of spaetesteJeFlaeche) {
    zuletztDort.set(nr, e.botschaftId);
    zuletztDurchsage.set(nr, e.hinweisId);
  }

  const flaecheNach = new Map(FLAECHEN.map(f => [f.nr, f]));

  // Vorrat mit mitgeführten Zählern: im Plan gilt eine Botschaft als gezeigt,
  // sobald sie gebucht ist — sonst käme dieselbe immer wieder als Erste dran.
  const vorrat = lage.vorrat.map(b => ({
    id: b.id,
    text: b.name ? `${b.text} — ${b.name}` : b.text,
    anzahl: (b.anzahl_anzeigen || 0) + (schonGezeigt.get(b.id) || 0),
    zuletzt: Math.max(b.zuletzt_gezeigt || 0, zuletztGebucht.get(b.id) || 0),
    erstellt: b.erstellt_am || 0
  })).sort(vorne);

  const durchsagen = (lage.hinweise || []).map(h => ({
    id: h.id,
    text: h.text,
    anzahl: (h.anzahl_anzeigen || 0) + (schonGezeigt.get('h' + h.id) || 0),
    zuletzt: Math.max(h.zuletzt_gezeigt || 0, zuletztGebucht.get('h' + h.id) || 0),
    erstellt: h.nr
  })).sort(vorne);

  // Der Scheduler lässt nie zwei Flächen im selben Augenblick wechseln.
  const mindestabstand = Math.max(200, Math.round(standzeitMs / FLAECHEN.length / 2));
  let letzterWechsel = letzterGebuchterWechsel;

  const eintraege = [];
  const grenze = FLAECHEN.length * (Math.ceil(horizontMs / standzeitMs) + 2);

  for (let runde = 0; runde < grenze; runde++) {
    let nr = null, wann = Infinity;
    for (const [n, w] of frei) if (w < wann) { wann = w; nr = n; }
    if (nr === null) break;

    const t = Math.max(wann, letzterWechsel + mindestabstand);
    if (t >= schluss) break;

    const f = flaecheNach.get(nr);
    let gebucht = null;

    if (nr === cfg.hinweisFlaeche && durchsagen.length) {
      let i = 0;
      if (durchsagen.length > 1 && durchsagen[0].id === zuletztDurchsage.get(nr)) i = 1;
      const h = durchsagen[i];
      gebucht = { hinweisId: h.id, botschaftId: null, text: h.text, g: mass(h.text, f.breite) };
      durchsagen.splice(i, 1);
      einsortieren(durchsagen, { ...h, anzahl: h.anzahl + 1, zuletzt: t });
      zuletztDurchsage.set(nr, h.id);
      zuletztDort.set(nr, null);
    } else {
      for (let i = 0; i < vorrat.length; i++) {
        const b = vorrat[i];
        if ((belegtBis.get(b.id) || 0) > t) continue;      // steht gerade woanders
        if (b.id === zuletztDort.get(nr)) continue;        // nicht direkt wiederholen
        const g = mass(b.text, f.breite);
        if (g.versalhoehe < cfg.minVersalhoehe) continue;  // hier nicht lesbar
        gebucht = { botschaftId: b.id, hinweisId: null, text: b.text, g };
        vorrat.splice(i, 1);
        einsortieren(vorrat, { ...b, anzahl: b.anzahl + 1, zuletzt: t });
        zuletztDort.set(nr, b.id);
        break;
      }
    }

    if (!gebucht) {
      // Für diese Fläche ist gerade nichts Passendes da — eine Standzeit
      // später noch einmal ansehen, sonst dreht die Schleife auf der Stelle.
      frei.set(nr, t + standzeitMs);
      continue;
    }

    const ende = t + standzeitMs;
    eintraege.push({
      flaeche: nr,
      flaecheName: f.name,
      gruppe: f.gruppe,
      start: t,
      ende,
      botschaftId: gebucht.botschaftId,
      hinweisId: gebucht.hinweisId,
      text: gebucht.text,
      groesse: gebucht.g
    });
    frei.set(nr, ende);
    if (gebucht.botschaftId !== null) belegtBis.set(gebucht.botschaftId, ende);
    letzterWechsel = t;
  }

  return { erstelltAm: jetzt, reichtBis: schluss, eintraege };
}

/** Der nächste gebuchte Auftritt einer Botschaft, oder null. */
function naechsterFuer (plan, botschaftId, ab = Date.now()) {
  if (!plan) return null;
  let treffer = null;
  for (const e of plan.eintraege) {
    if (e.botschaftId !== botschaftId || e.ende <= ab) continue;
    if (!treffer || e.start < treffer.start) treffer = e;
  }
  return treffer;
}

/** Was auf einer Fläche als Nächstes gebucht ist — für Prüfung und Anzeige. */
function naechsterAuf (plan, flaeche, ab = 0) {
  if (!plan) return null;
  let treffer = null;
  for (const e of plan.eintraege) {
    if (e.flaeche !== flaeche || e.start < ab) continue;
    if (!treffer || e.start < treffer.start) treffer = e;
  }
  return treffer;
}

/**
 * Nimmt Buchungen bestimmter Botschaften aus dem Plan — nach einem
 * Moderationseingriff. Es wird bewusst NICHT neu gerechnet: die Lücke füllt
 * der Scheduler im Rückfall, und alle übrigen Zusagen bleiben stehen.
 * @returns {number} Anzahl gestrichener Buchungen
 */
function streichen (plan, ids) {
  if (!plan) return 0;
  const menge = new Set([...ids].map(Number));
  const vorher = plan.eintraege.length;
  plan.eintraege = plan.eintraege.filter(e => e.botschaftId === null || !menge.has(e.botschaftId));
  return vorher - plan.eintraege.length;
}

/** Buchungen von Hinweisen streichen — nach dem Herausnehmen eines Platzes. */
function durchsagenStreichen (plan) {
  if (!plan) return 0;
  const vorher = plan.eintraege.length;
  plan.eintraege = plan.eintraege.filter(e => e.hinweisId === null);
  return vorher - plan.eintraege.length;
}

/**
 * Wie weit der Plan noch nach vorn reicht — gemessen an der SCHWAECHSTEN
 * Fläche, nicht am Gesamtbild. Eine einzelne leergeräumte Fläche (etwa nach
 * dem Umschalten der Hinweise) würde sonst im Durchschnitt untergehen und
 * bekäme keine Buchung mehr; sie fiele still in den Rückfall zurück, und die
 * Auskunft für diese Fläche wäre weg.
 */
function reichweite (plan, jetzt = Date.now()) {
  if (!plan || !plan.eintraege.length) return 0;
  const bis = new Map();
  for (const e of plan.eintraege) {
    bis.set(e.flaeche, Math.max(bis.get(e.flaeche) || 0, e.start));
  }
  if (bis.size < FLAECHEN.length) return 0;   // eine Fläche ganz ohne Buchung
  let kleinste = Infinity;
  for (const w of bis.values()) if (w < kleinste) kleinste = w;
  return Math.max(0, kleinste - jetzt);
}

module.exports = { bauen, naechsterFuer, naechsterAuf, streichen, durchsagenStreichen, reichweite };
