// Die Bridge: holt den Anzeigezustand vom Server und schreibt ihn nach Arena.
//   node bridge/bridge.js
//
// GRUNDGEDANKE. Der Server ist passiv. Er weiss nichts von Arena, hat keine
// Verbindung nach aussen und faellt nicht aus, wenn hier etwas klemmt. Die
// Bridge zieht: alle halbe Sekunde `GET /api/anzeige`, vergleicht mit dem,
// was auf der Wand steht, und schreibt nur die Unterschiede.
//
// WARUM ZIEHEN UND NICHT SCHIEBEN. Der Medien-PC steht hinter dem Hausnetz;
// eine Verbindung von aussen hinein waere ein Loch, das jemand aufmachen und
// bewachen muesste. Und ein Poll-Ausfall ist harmlos: die Wand behaelt, was
// sie zeigt.
//
// DER WECHSEL sind drei Aufrufe: Blende auf 0, 350 ms warten (so lange
// braucht der Smooth-Knoten im Patch), Text tauschen, Blende auf 1. Der Text
// wird dabei erst NACH der Wartezeit gelesen — kommt waehrenddessen ein
// neuerer, wird gleich der gezeigt statt zweimal geblendet.
//
// WAS SIE NICHT TUT. Sie loescht nie von sich aus die Wand, auch nicht bei
// Netzausfall: was steht, bleibt stehen, bis der Server etwas anderes sagt.
// Der harte Abbruch bleibt Resolume vorbehalten (MESSAGES-Ebenen aus) — der
// wirkt auch dann, wenn diese Bridge haengt.

const fs = require('fs');
const path = require('path');
const arena = require('./arena');

const VORGABE = {
  server: 'https://botschaft.frischvergiftung.de',
  arena: 'http://127.0.0.1:8080/api/v1',
  taktMs: 500,
  blendeMs: 350,
  // Nach so vielen Fehlern am Stueck werden die Parameter-IDs neu gelesen:
  // Arena vergibt sie beim Neuladen des Effekts neu.
  fehlerBisNeuverbinden: 5,
  ruhig: false
};

/** Einstellungen: Datei neben dieser Datei, darueber Umgebungsvariablen. */
function einstellungen (zusatz = {}) {
  const e = { ...VORGABE };
  const datei = path.join(__dirname, 'einstellungen.json');
  if (fs.existsSync(datei)) Object.assign(e, JSON.parse(fs.readFileSync(datei, 'utf8')));
  if (process.env.BRIDGE_SERVER) e.server = process.env.BRIDGE_SERVER;
  if (process.env.BRIDGE_ARENA) e.arena = process.env.BRIDGE_ARENA;
  if (process.env.BRIDGE_TAKT_MS) e.taktMs = Number(process.env.BRIDGE_TAKT_MS);
  if (process.env.BRIDGE_BLENDE_MS) e.blendeMs = Number(process.env.BRIDGE_BLENDE_MS);
  return { ...e, ...zusatz };
}

const schlaf = ms => new Promise(r => setTimeout(r, ms));
const uhr = () => new Date().toLocaleTimeString('de-DE');

function starten (zusatz = {}) {
  const e = einstellungen(zusatz);
  const sagen = (...w) => { if (!e.ruhig) console.log('[' + uhr() + ']', ...w); };

  // Was steht laut Bridge gerade auf welcher Flaeche?
  const flaechen = new Map(); // nr -> { gezeigt, ziel, laeuft }
  const halten = nr => {
    if (!flaechen.has(nr)) flaechen.set(nr, { gezeigt: null, ziel: '', laeuft: false });
    return flaechen.get(nr);
  };

  let verbindung = null;      // { pfad, flaechen }
  let laeuft = true;
  let arenaFehler = 0;
  const zahlen = { wechsel: 0, serverFehler: 0, arenaFehler: 0, letzteAntwortMs: 0 };

  async function verbinden () {
    verbindung = await arena.verbinden(e.arena);
    sagen(`Arena verbunden — ${verbindung.flaechen.size} Flächen, Weg /${verbindung.pfad}/`);
    arenaFehler = 0;
  }

  async function setzen (id, wert) {
    try {
      await arena.setzen(e.arena, verbindung.pfad, id, wert);
      arenaFehler = 0;
    } catch (fehler) {
      arenaFehler++;
      zahlen.arenaFehler++;
      throw fehler;
    }
  }

  /** Der Anzeigezustand vom Server. null heisst: gerade nicht erreichbar. */
  async function anzeigeHolen () {
    const begonnen = Date.now();
    const abbruch = new AbortController();
    const wecker = setTimeout(() => abbruch.abort(), 3000);
    try {
      const antwort = await fetch(e.server + '/api/anzeige', { signal: abbruch.signal });
      if (!antwort.ok) throw new Error('Server antwortet mit ' + antwort.status);
      const daten = await antwort.json();
      zahlen.letzteAntwortMs = Date.now() - begonnen;
      return daten;
    } catch (fehler) {
      zahlen.serverFehler++;
      if (zahlen.serverFehler === 1 || zahlen.serverFehler % 20 === 0) {
        sagen('Server nicht erreichbar (' + fehler.message + ') — die Wand behält ihren Stand');
      }
      return null;
    } finally {
      clearTimeout(wecker);
    }
  }

  /** Erster Abgleich: alles hinschreiben, ohne Blenderei. */
  async function abgleichen (daten) {
    for (const f of daten.flaechen) {
      const ids = verbindung.flaechen.get(f.nr);
      if (!ids) continue;
      const text = f.text || '';
      await setzen(ids.text, text);
      await setzen(ids.blende, text ? 1 : 0);
      halten(f.nr).gezeigt = text;
      halten(f.nr).ziel = text;
    }
    sagen('Erstabgleich fertig — ' + daten.flaechen.filter(f => f.text).length + ' Flächen belegt');
  }

  /** Ein Wechsel auf einer Flaeche. Laeuft nebenher, eine je Flaeche. */
  async function wechseln (nr) {
    const z = halten(nr);
    const ids = verbindung.flaechen.get(nr);
    if (!ids || z.laeuft) return;
    z.laeuft = true;
    try {
      // Steht die Flaeche schon dunkel, ist Ausblenden nichts als Wartezeit.
      if (z.gezeigt) {
        await setzen(ids.blende, 0);
        await schlaf(e.blendeMs);
      }
      const text = z.ziel;              // absichtlich erst jetzt: der neueste gilt
      await setzen(ids.text, text);
      await setzen(ids.blende, text ? 1 : 0);
      z.gezeigt = text;
      zahlen.wechsel++;
      sagen(`Fläche ${String(nr).padStart(2, '0')} ← ${text ? '"' + text + '"' : '(leer)'}`);
    } catch (fehler) {
      // Nicht als gezeigt vermerken: der naechste Takt versucht es erneut.
      sagen(`Fläche ${nr}: ${fehler.message}`);
    } finally {
      z.laeuft = false;
    }
  }

  async function takt () {
    if (!verbindung) {
      try { await verbinden(); } catch (fehler) { sagen('Arena: ' + fehler.message); return; }
    }
    const daten = await anzeigeHolen();
    if (!daten) return;
    if (zahlen.serverFehler && zahlen.letzteAntwortMs) {
      sagen('Server wieder da');
      zahlen.serverFehler = 0;
    }
    let ersterLauf = false;
    for (const f of daten.flaechen) if (halten(f.nr).gezeigt === null) ersterLauf = true;
    if (ersterLauf) {
      try { await abgleichen(daten); } catch (fehler) { sagen('Abgleich: ' + fehler.message); }
      return;
    }
    for (const f of daten.flaechen) {
      const z = halten(f.nr);
      z.ziel = f.text || '';
      if (z.ziel !== z.gezeigt && !z.laeuft) wechseln(f.nr);   // bewusst ohne await
    }
    if (arenaFehler >= e.fehlerBisNeuverbinden) {
      sagen('Arena antwortet nicht mehr wie erwartet — IDs werden neu gelesen');
      verbindung = null;
      for (const z of flaechen.values()) z.gezeigt = null;     // erzwingt den Erstabgleich
    }
  }

  const schleife = (async () => {
    while (laeuft) {
      try { await takt(); } catch (fehler) { sagen('Takt: ' + fehler.message); }
      await schlaf(e.taktMs);
    }
  })();

  const bericht = setInterval(() => {
    sagen(`Stand: ${zahlen.wechsel} Wechsel, ${zahlen.arenaFehler} Arena-Fehler, `
      + `${zahlen.serverFehler} Server-Fehler, Antwortzeit ${zahlen.letzteAntwortMs} ms`);
  }, 30000);
  bericht.unref?.();

  return {
    zahlen,
    flaechen,
    einstellungen: e,
    async stoppen () { laeuft = false; clearInterval(bericht); await schleife; }
  };
}

if (require.main === module) {
  const lauf = starten();
  console.log('Bridge läuft. Server: ' + lauf.einstellungen.server + ' · Arena: ' + lauf.einstellungen.arena);
  for (const zeichen of ['SIGINT', 'SIGTERM']) {
    process.on(zeichen, async () => { await lauf.stoppen(); process.exit(0); });
  }
}

module.exports = { starten, einstellungen };
