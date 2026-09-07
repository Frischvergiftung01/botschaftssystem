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
function sammeln (knoten, treffer = []) {
  if (!knoten || typeof knoten !== 'object') return treffer;
  if (Array.isArray(knoten)) {
    for (const k of knoten) sammeln(k, treffer);
    return treffer;
  }
  const hier = { text: new Map(), blende: new Map() };
  for (const [name, wert] of Object.entries(knoten)) {
    if (wert && typeof wert === 'object' && !Array.isArray(wert) &&
        typeof wert.id === 'number' && 'value' in wert) {
      const blende = /^Blende[ _]?(\d{1,2})$/i.exec(name);
      const text = /^(\d{1,2})[ _]/.exec(name);
      if (blende) hier.blende.set(Number(blende[1]), wert.id);
      else if (text) hier.text.set(Number(text[1]), wert.id);
    }
    sammeln(wert, treffer);
  }
  // Nur wo beides zusammen haengt, ist es unser Effekt.
  if (hier.text.size && hier.blende.size) treffer.push(hier);
  return treffer;
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
      + 'Liegt "FVG Message Wall v2" auf dem Clip?');
  }
  // Der Effekt mit den meisten vollstaendigen Paaren gewinnt — falls eine alte
  // Fassung des Patches noch irgendwo mitlaeuft.
  let bester = null, meiste = -1;
  for (const t of treffer) {
    let n = 0;
    for (const nr of t.text.keys()) if (t.blende.has(nr)) n++;
    if (n > meiste) { meiste = n; bester = t; }
  }
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

  return { pfad, flaechen };
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

module.exports = { verbinden, setzen, sammeln, PFADE };
