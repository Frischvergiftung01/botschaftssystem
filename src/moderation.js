// Block 5 — Moderation.
//
// Der Engpass des Abends ist nicht die Fassade, sondern dieser Bildschirm:
// 500 Entscheidungen in der Stunde muss eine Person schaffen (Konzept 4.3).
// Alles hier ist darauf ausgelegt — Sammelentscheidungen statt Einzelklicks,
// keine Rückfragen, keine Begründungspflicht. Arbeitsprinzip bei einer
// einzelnen Person: im Zweifel nein.
//
// KEIN Not-Aus in Software. Der harte Abbruch passiert in Resolume, indem die
// Message-Ebenen ausgeschaltet werden — der einzige Weg, der auch dann noch
// wirkt, wenn Netz, Bridge oder dieser Dienst hängen. Was es hier gibt, ist die
// weiche Fassung: eine einzelne Botschaft sofort von der Fassade nehmen
// (`sperren`) und den Nachschub anhalten (Schalter `nachschub`).

const cfg = require('./config');
const { db, abfragen } = require('./db');
const { FLAECHEN } = require('./flaechen');
const { groesseFuer } = require('./text');
const scheduler = require('./scheduler');
const einstellungen = require('./einstellungen');
const sessionen = require('./sessionen');

/** Was die Oberfläche schicken darf und welcher Status daraus wird. */
const ZIEL = {
  freigeben: 'freigegeben',
  ablehnen: 'abgelehnt',
  zurueckstellen: 'zurueckgestellt',
  sperren: 'gesperrt',        // war schon freigegeben: sofort von der Fassade
  zurueckholen: 'neu'         // Rückgängig aus der Oberfläche
};

// Diese Zustände dürfen nicht an der Fassade stehen bleiben.
const RUNTER = new Set(['abgelehnt', 'gesperrt', 'zurueckgestellt', 'neu']);

// Flächen von schmal nach breit. Die schmalste, auf der eine Botschaft noch
// lesbar ist, zeigt den ungünstigsten realistischen Fall — genau den soll die
// Moderation sehen, nicht die geschmeichelte Fassung auf dem Stirnband.
const NACH_BREITE = [...FLAECHEN].sort((a, b) => a.breite - b.breite);

function optik (text) {
  let passende = 0;
  let gewaehlt = null;
  for (const f of NACH_BREITE) {
    const g = groesseFuer(text, f.breite, cfg.maxVersalhoehe);
    if (g.versalhoehe >= cfg.minVersalhoehe) {
      passende++;
      if (!gewaehlt) gewaehlt = { f, g };
    }
  }
  if (!gewaehlt) {
    const f = NACH_BREITE[NACH_BREITE.length - 1];
    gewaehlt = { f, g: groesseFuer(text, f.breite, cfg.maxVersalhoehe) };
  }
  return {
    flaeche: gewaehlt.f.nr,
    flaecheName: gewaehlt.f.name,
    breite: gewaehlt.f.breite,
    versalhoehe: gewaehlt.g.versalhoehe,
    yVersatz: gewaehlt.g.yVersatz,
    passendeFlaechen: passende,
    passt: passende > 0
  };
}

/** Kurze, lesbare Fassung des gespeicherten Filterergebnisses. */
function gruende (roh) {
  if (!roh) return [];
  let p;
  try { p = JSON.parse(roh); } catch (e) { return []; }
  const liste = [];
  for (const g of (p.stufe1a && p.stufe1a.gruende) || []) {
    liste.push(`${g.rang === 'hart' ? 'Regel' : 'Hinweis'}: ${g.regel} (${g.treffer})`);
  }
  const b = p.stufe1b;
  if (b) {
    if (b.grund) liste.push(`Sprachmodell nicht erreichbar: ${b.grund}`);
    else if (b.urteil && b.urteil !== 'FREI') liste.push(`Sprachmodell: ${b.urteil}`);
  }
  return liste;
}

function aufbereiten (b) {
  const voll = b.name ? `${b.text} — ${b.name}` : b.text;
  return {
    id: b.id,
    text: b.text,
    name: b.name,
    status: b.status,
    unsicher: Boolean(b.unsicher),
    erstelltAm: b.erstellt_am,
    anzahlAnzeigen: b.anzahl_anzeigen || 0,
    voll,
    gruende: gruende(b.filter),
    optik: optik(voll)
  };
}

/**
 * Die Arbeitsvorräte der Moderation.
 * einzeln = unsichere zuerst, raster = nur unauffällige.
 */
function queue (ansicht = 'einzeln', grenze = 60) {
  if (ansicht === 'raster') {
    // Das Raster zeigt genau eine Rasterfüllung — mehr Kacheln auf einmal
    // freizugeben, als man überblickt, ist der Fehler, den man abends macht.
    return abfragen.queue.all({ unsicher: 0, grenze: Math.min(grenze, cfg.rasterGroesse) }).map(aufbereiten);
  }
  if (ansicht === 'zurueckgestellt' || ansicht === 'pool' || ansicht === 'abgelehnt') {
    const status = ansicht === 'pool' ? 'freigegeben' : ansicht;
    return abfragen.nachStatus.all({ status, grenze }).map(aufbereiten);
  }
  const unsichere = abfragen.queue.all({ unsicher: 1, grenze });
  const rest = unsichere.length < grenze
    ? abfragen.queue.all({ unsicher: 0, grenze: grenze - unsichere.length })
    : [];
  return [...unsichere, ...rest].map(aufbereiten);
}

/**
 * Sammelentscheidung. Läuft in einer Transaktion — bei zwölf Botschaften auf
 * einen Klick soll es entweder ganz oder gar nicht passieren.
 */
const schreiben = db.transaction((ids, status, zeit) => {
  let n = 0;
  for (const id of ids) n += abfragen.statusSetzen.run({ id, status, zeit }).changes;
  return n;
});

function entscheiden (ids, entscheidung) {
  const status = ZIEL[entscheidung];
  if (!status) throw new Error('Unbekannte Entscheidung: ' + entscheidung);
  const saubere = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  if (!saubere.length) return { geaendert: 0, status, geraeumt: 0 };

  const geaendert = schreiben(saubere, status, Date.now());
  // Zurückgenommenes darf nicht bis zum Ende der Standzeit stehen bleiben.
  const geraeumt = RUNTER.has(status) ? scheduler.entfernen(saubere) : 0;
  return { geaendert, status, geraeumt };
}

/** Zahlen für den Kopf der Oberfläche — und für den Abnahmetest. */
function kennzahlen () {
  const offen = { unsicher: 0, unauffaellig: 0 };
  for (const z of abfragen.offen.all()) {
    if (z.unsicher) offen.unsicher = z.n; else offen.unauffaellig = z.n;
  }
  const jetzt = Date.now();
  const letzte5 = abfragen.entschiedenSeit.get(jetzt - 5 * 60 * 1000).n;
  const letzte60 = abfragen.entschiedenSeit.get(jetzt - 60 * 60 * 1000).n;
  return {
    offen,
    offenGesamt: offen.unsicher + offen.unauffaellig,
    entschieden5Min: letzte5,
    entschiedenStunde: letzte60,
    // Hochrechnung aus den letzten fünf Minuten: das ist die Zahl, gegen die
    // das Abnahmekriterium von 500 Entscheidungen je Stunde gemessen wird.
    durchsatzProStunde: letzte5 * 12,
    schalter: einstellungen.schalter(),
    // Der Sessionstand faehrt hier mit, damit der Balken oben in der Oberflaeche
    // aus derselben Abfrage lebt wie die Zahlen — eine Anfrage statt zwei.
    session: sessionen.stand(),
    standzeitSekunden: einstellungen.standzeit(),
    standzeitGrenzen: { min: einstellungen.STANDZEIT_MIN, max: einstellungen.STANDZEIT_MAX },
    rasterGroesse: cfg.rasterGroesse,
    darfLeeren: cfg.datenbankLeerenErlaubt
  };
}

/**
 * Datenbank leeren — für die Vorbereitung, nicht für den Abend. Dreimal über
 * das Container-Terminal war ein Zeichen, dass das Werkzeug hier fehlt.
 */
const leerenTx = db.transaction(() => {
  abfragen.alleAnzeigenLoeschen.run();
  const n = abfragen.alleBotschaftenLoeschen.run().changes;
  return n;
});

function datenbankLeeren () {
  if (!cfg.datenbankLeerenErlaubt) throw new Error('Das Leeren ist auf diesem Stand abgeschaltet.');
  const geloescht = leerenTx();
  scheduler.alleEntfernen();
  return geloescht;
}

module.exports = { queue, entscheiden, kennzahlen, datenbankLeeren, optik, aufbereiten, ZIEL };
