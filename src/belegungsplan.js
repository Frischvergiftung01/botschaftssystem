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

  const flaecheNach = new Map(FLAECHEN.map(f => [f.nr, f]));

  // Vorrat mit mitgeführten Zählern: im Plan gilt eine Botschaft als gezeigt,
  // sobald sie gebucht ist — sonst käme dieselbe immer wieder als Erste dran.
  const vorrat = lage.vorrat.map(b => ({
    id: b.id,
    text: b.name ? `${b.text} — ${b.name}` : b.text,
    anzahl: b.anzahl_anzeigen || 0,
    zuletzt: b.zuletzt_gezeigt || 0,
    erstellt: b.erstellt_am || 0
  })).sort(vorne);

  const durchsagen = (lage.hinweise || []).map(h => ({
    id: h.id,
    text: h.text,
    anzahl: h.anzahl_anzeigen || 0,
    zuletzt: h.zuletzt_gezeigt || 0,
    erstellt: h.nr
  })).sort(vorne);

  // Der Scheduler lässt nie zwei Flächen im selben Augenblick wechseln.
  const mindestabstand = Math.max(200, Math.round(standzeitMs / FLAECHEN.length / 2));
  let letzterWechsel = -Infinity;

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

module.exports = { bauen, naechsterFuer, naechsterAuf };
