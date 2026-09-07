// Alles, was mit Resolume Arena spricht.
//
// Arena macht aus jedem `String In` und `Float In` des Wire-Patches einen
// Parameter mit einer stabilen Nummer. Gesetzt wird ueber diese Nummer, nicht
// ueber Layer und Spalte — dann ist es egal, wohin der Clip spaeter rutscht.
//
// ZWEI DINGE SIND HIER ABSICHTLICH LOCKER GEBAUT:
//
// 1. Die Parameter werden GESUCHT, nicht eingetragen. Der Patch benennt seine
//    Felder "01 Stirn Mitte" bis "33 Rechts 07" und "Blende 01" bis
//    "Blende 33" — die fuehrende Zahl ist die Flaechennummer. Wer im Patch ein
//    Feld umbenennt oder verschiebt, muss hier nichts nachtragen; wer die
//    Nummer entfernt, merkt es beim Start sofort.
// ABER: bei MEHREREN Instanzen entscheidet, welche laeuft. In einer
//    gewachsenen Komposition liegt derselbe Effekt mehrfach herum — am
//    07.09.2026 waren es drei, und die Bridge schrieb tadellos in eine, die
//    niemand sieht.
//    Umgekehrt ist "nicht getriggert" KEIN Fehler: die Parameter gehoeren dem
//    Clip, nicht der Wiedergabe. Waehrend der Mapping-Show wird der
//    Botschaften-Clip entriggert; geschrieben wird trotzdem weiter, und beim
//    naechsten Triggern steht der aktuelle Stand sofort da. Gibt es nur eine
//    Instanz, wird sie deshalb genommen, ob sie laeuft oder nicht.
// 2. Der Pfad zur Parameterschnittstelle wird beim Start PROBIERT. Arena hat
//    ihn zwischen Fassungen schon einmal verschoben; zwei Anfragen beim Start
//    sind billiger als eine Bridge, die am Veranstaltungsabend an einem
//    Schraegstrich scheitert.

const ZEITLIMIT_MS = 2000;

const PFADE = ['composition/parameter/by-id', 'parameter/by-id'];

async function anfrage (url, opt = {}) {
  const abbruch = new AbortController();
  const wecker = setTimeout(() => abbruch.abort(), opt.zeitlimit || ZEITLIMIT_MS);
  try {
    return await fetch(url, { ...opt, signal: abbruch.signal });
  } finally {
    clearTimeout(wecker);
  }
}

/**
 * Sammelt Text- und Blendenparameter aus der Kompositions-JSON.
 *
 * Statt den Baum entlangzuhangeln (Layer -> Clip -> Effekt -> Parameter) wird
 * er durchsucht: ein Parameter ist ein Objekt mit `id` und `value`, und sein
 * Name ist der Schluessel, unter dem es haengt. Das haelt auch dann noch,
 * wenn Arena die Verschachtelung aendert.
 */
function sammeln (knoten, treffer = [], lage = {}) {
  if (!knoten || typeof knoten !== 'object') return treffer;
  if (Array.isArray(knoten)) {
    for (const k of knoten) sammeln(k, treffer, lage);
    return treffer;
  }
  const hier = { text: new Map(), blende: new Map(), ...lage };
  for (const [name, wert] of Object.entries(knoten)) {
    // `active_clip` ist eine Zweitschrift des laufenden Clips — sonst faende
    // man dieselben Parameter zweimal.
    if (name === 'active_clip') continue;
    if (wert && typeof wert === 'object' && !Array.isArray(wert) &&
        typeof wert.id === 'number' && 'value' in wert) {
      const blende = /^Blende[ _]?(\d{1,2})$/i.exec(name);
      const text = /^(\d{1,2})[ _]/.exec(name);
      if (blende) hier.blende.set(Number(blende[1]), wert.id);
      else if (text) hier.text.set(Number(text[1]), wert.id);
    }
    // Lage mitfuehren, damit hinterher gesagt werden kann, WO gefunden wurde.
    if (name === 'layers' && Array.isArray(wert)) {
      wert.forEach((l, i) => sammeln(l, treffer, { ...lage, layer: i + 1, layerName: l?.name?.value }));
      continue;
    }
    if (name === 'clips' && Array.isArray(wert)) {
      wert.forEach((c, i) => sammeln(c, treffer, {
        ...lage,
        spalte: i + 1,
        clipName: c?.name?.value,
        verbunden: /^Connected/i.test(String(c?.connected?.value || ''))
      }));
      continue;
    }
    sammeln(wert, treffer, lage);
  }
  // Nur wo beides zusammen haengt, ist es unser Effekt.
  if (hier.text.size && hier.blende.size) treffer.push(hier);
  return treffer;
}

/** Vollstaendige Paare Text+Blende — daran wird gemessen, welche Instanz taugt. */
function paare (t) {
  let n = 0;
  for (const nr of t.text.keys()) if (t.blende.has(nr)) n++;
  return n;
}

/**
 * Liest die Komposition einmal aus und baut die Karte Flaeche -> Parameter-IDs.
 * @returns {{pfad:string, flaechen:Map<number,{text:number,blende:number}>}}
 */
async function verbinden (arenaBasis) {
  const antwort = await anfrage(arenaBasis + '/composition', { zeitlimit: 8000 });
  if (!antwort.ok) throw new Error('Arena antwortet auf /composition mit ' + antwort.status);
  const treffer = sammeln(await antwort.json());
  if (!treffer.length) {
    throw new Error('In der Komposition steckt kein Effekt mit Text- UND Blendenfeldern. '
      + 'Liegt "FVG Message Wall v2" auf einem Clip?');
  }
  // Erst die laufenden Clips, und darunter der Effekt mit den meisten
  // vollstaendigen Paaren. Laeuft keiner, wird der beste stillliegende
  // genommen — bei nur einer Instanz ist das der Normalfall waehrend der
  // Mapping-Show. `verbunden` sagt dem Aufrufer, was gerade zu sehen ist.
  const laufende = treffer.filter(t => t.verbunden);
  const bester = (laufende.length ? laufende : treffer)
    .sort((a, b) => paare(b) - paare(a))[0];
  const flaechen = new Map();
  for (const [nr, text] of bester.text) {
    if (bester.blende.has(nr)) flaechen.set(nr, { text, blende: bester.blende.get(nr) });
  }

  // Pfad ausprobieren: irgendeine bekannte ID lesen.
  const probe = [...flaechen.values()][0].blende;
  let pfad = null;
  for (const p of PFADE) {
    try {
      const a = await anfrage(`${arenaBasis}/${p}/${probe}`);
      if (a.ok) { pfad = p; break; }
    } catch { /* naechsten versuchen */ }
  }
  if (!pfad) throw new Error('Kein gangbarer Weg zu den Parametern (probiert: ' + PFADE.join(', ') + ')');

  return {
    pfad,
    flaechen,
    layer: bester.layer,
    spalte: bester.spalte,
    clipName: bester.clipName,
    layerName: bester.layerName,
    verbunden: !!bester.verbunden,
    instanzen: treffer.length
  };
}

/**
 * Laeuft der Clip noch, in den geschrieben wird?
 *
 * Waehrend des Abends kann jemand in Arena eine andere Spalte triggern; dann
 * schreibt die Bridge weiter in einen Clip, den niemand sieht. Die Abfrage
 * kostet rund 20 kB und laeuft deshalb nur alle paar Sekunden.
 */
async function nochVerbunden (arenaBasis, layer, spalte) {
  if (!layer || !spalte) return true;      // ohne Lage nicht pruefbar
  const antwort = await anfrage(`${arenaBasis}/composition/layers/${layer}/clips/${spalte}`);
  if (!antwort.ok) return false;
  const clip = await antwort.json();
  return /^Connected/i.test(String(clip?.connected?.value || ''));
}

/** Setzt einen Parameter. Wirft, damit der Aufrufer mitzaehlen kann. */
async function setzen (arenaBasis, pfad, id, wert) {
  const antwort = await anfrage(`${arenaBasis}/${pfad}/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: wert })
  });
  if (!antwort.ok) throw new Error(`Parameter ${id} nicht gesetzt (${antwort.status})`);
}

module.exports = { verbinden, setzen, sammeln, nochVerbunden, PFADE };
