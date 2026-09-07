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
  // Wie oft nachgesehen wird, ob der beschriebene Clip noch laeuft.
  wachtMs: 15000,
  ruhig: false,
  // Wohin mitgeschrieben wird. Leer = nur Fenster. Beim Start ueber
  // start-bridge.cmd steht hier "logs" — nach dem Abend will man nachsehen
  // koennen, was wann lief, und niemand liest ein geschlossenes Fenster.
  logOrdner: ''
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
  if (process.env.BRIDGE_LOG) e.logOrdner = process.env.BRIDGE_LOG;
  return { ...e, ...zusatz };
}

const schlaf = ms => new Promise(r => setTimeout(r, ms));
const uhr = () => new Date().toLocaleTimeString('de-DE');

function starten (zusatz = {}) {
  const e = einstellungen(zusatz);

  /** Eine Zeile ins Fenster und, wenn gewuenscht, in die Tagesdatei. */
  const sagen = (...w) => {
    const zeile = '[' + uhr() + '] ' + w.join(' ');
    if (!e.ruhig) console.log(zeile);
    if (!e.logOrdner) return;
    try {
      const tag = new Date().toISOString().slice(0, 10);
      const ordner = path.isAbsolute(e.logOrdner) ? e.logOrdner : path.join(__dirname, e.logOrdner);
      fs.mkdirSync(ordner, { recursive: true });
      fs.appendFileSync(path.join(ordner, `bridge-${tag}.log`), zeile + '\n');
    } catch { /* ein volles Laufwerk darf die Fassade nicht anhalten */ }
  };

  // Was steht laut Bridge gerade auf welcher Flaeche?
  const flaechen = new Map(); // nr -> { gezeigt, ziel, laeuft }
  const halten = nr => {
    if (!flaechen.has(nr)) flaechen.set(nr, { gezeigt: null, ziel: '', laeuft: false });
    return flaechen.get(nr);
  };

  let verbindung = null;      // { pfad, flaechen, layer, spalte, ... }
  let letzteWacht = 0;
  let laeuft = true;
  let arenaFehler = 0;
  const zahlen = { wechsel: 0, serverFehler: 0, arenaFehler: 0, letzteAntwortMs: 0 };

  async function verbinden () {
    verbindung = await arena.verbinden(e.arena);
    sagen(`Arena verbunden — Layer ${verbindung.layer} „${verbindung.layerName}", Spalte `
      + `${verbindung.spalte} „${verbindung.clipName}", ${verbindung.flaechen.size} Flächen, `
      + `Weg /${verbindung.pfad}/`);
    if (!verbindung.verbunden) {
      sagen('Der Clip ist gerade nicht getriggert — es wird trotzdem geschrieben, '
        + 'der Stand erscheint beim nächsten Triggern.');
    }
    if (verbindung.instanzen > 1) {
      sagen(`Hinweis: der Patch liegt ${verbindung.instanzen}× in der Komposition — `
        + 'geschrieben wird in den laufenden Clip.');
    }
    letzteWacht = Date.now();
    arenaFehler = 0;
  }

  /**
   * Waechter: schreiben wir noch dorthin, wo es hingehoert?
   *
   * Zwei verschiedene Sorgen, und nur eine davon ist ein Fehler:
   *
   * 1. MEHRERE Instanzen des Patches in der Komposition. Dann heisst "der
   *    Clip laeuft nicht mehr", dass jemand eine andere getriggert hat — es
   *    wird neu gesucht. (Am 07.09.2026 hat genau das eine Stunde gekostet:
   *    alle Aufrufe gelangen, die Wand stand still.)
   * 2. EINE Instanz, entriggert. Das ist der Normalfall waehrend der
   *    Mapping-Show und kein Fehler; es gibt auch nichts anderes zu finden.
   *    Gemerkt wird es trotzdem: sobald wieder getriggert wird, schreibt die
   *    Bridge einmal alles hin, damit die Wand nicht erst nach und nach
   *    aufwacht.
   */
  async function wachen () {
    if (!verbindung || Date.now() - letzteWacht < e.wachtMs) return;
    letzteWacht = Date.now();
    let laeuftNoch;
    try {
      laeuftNoch = await arena.nochVerbunden(e.arena, verbindung.layer, verbindung.spalte);
    } catch { return; }                      // Netzhaenger sind Sache des Taktes

    if (!laeuftNoch && verbindung.instanzen > 1) {
      sagen('Der Clip mit dem Patch läuft nicht mehr — es wird neu gesucht');
      verbindung = null;
      for (const z of flaechen.values()) z.gezeigt = null;
      return;
    }
    if (laeuftNoch && !verbindung.verbunden) {
      sagen('Clip wieder getriggert — der aktuelle Stand wird einmal komplett geschrieben');
      for (const z of flaechen.values()) z.gezeigt = null;   // erzwingt den Abgleich
    }
    verbindung.verbunden = laeuftNoch;
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
    await wachen();
    if (!verbindung) return;                 // der Waechter hat sie verworfen
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
  // Von Hand oder per start-bridge.cmd gestartet: dann wird mitgeschrieben.
  const lauf = starten({ logOrdner: process.env.BRIDGE_LOG || 'logs' });
  console.log('Bridge läuft. Server: ' + lauf.einstellungen.server + ' · Arena: ' + lauf.einstellungen.arena);
  for (const zeichen of ['SIGINT', 'SIGTERM']) {
    process.on(zeichen, async () => { await lauf.stoppen(); process.exit(0); });
  }
}

module.exports = { starten, einstellungen };
