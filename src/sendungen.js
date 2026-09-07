// Wiederholte Absendeversuche erkennen.
//
// DER FALL, DEN NIEMAND SIEHT. Die Botschaft erreicht den Server, die Antwort
// geht auf dem Rueckweg verloren. Der Absender sieht "keine Verbindung",
// drueckt noch einmal — und bekommt die Geraetesperre zu sehen ("in 118
// Sekunden geht die naechste"), waehrend seine Botschaft laengst an der Wand
// steht. Er haelt das System fuer kaputt, und wir haben die Botschaft doppelt.
//
// Deshalb schickt das Handy zu jedem Absendeversuch eine Zufallskennung mit.
// Kommt dieselbe noch einmal, wird die alte Antwort wiederholt statt neu
// angelegt. Erst dadurch ist automatisches Nachschicken ueberhaupt vertretbar.
//
// NUR IM ARBEITSSPEICHER. Die Kennung wird nirgends gespeichert: sie gilt
// Minuten, ist pro BOTSCHAFT zufaellig (nicht pro Geraet, nicht pro Person)
// und laesst sich mit nichts verknuepfen. Ein Neustart des Dienstes vergisst
// sie mit — schlimmstenfalls greift dann wieder das alte Verhalten.

const FRIST_MS = 10 * 60 * 1000;
// Deckel gegen Zumuellen: 20.000 Kennungen sind ein Vielfaches dessen, was an
// einem Abend zusammenkommt, und kosten nur wenige Megabyte.
const HOECHSTENS = 20000;

const merker = new Map();   // kennung -> { zeit, code, antwort }

function aufraeumen (jetzt = Date.now()) {
  for (const [k, e] of merker) {
    if (jetzt - e.zeit > FRIST_MS) merker.delete(k); else break;   // Map ist einfuegegeordnet
  }
  while (merker.size > HOECHSTENS) merker.delete(merker.keys().next().value);
}

/** Taugt die Kennung? Sie kommt vom Browser, also nichts glauben. */
function gueltig (kennung) {
  return typeof kennung === 'string' && kennung.length >= 8 && kennung.length <= 100;
}

function merken (kennung, code, antwort) {
  if (!gueltig(kennung)) return;
  aufraeumen();
  merker.set(kennung, { zeit: Date.now(), code, antwort });
}

/** Die Antwort auf einen frueheren Versuch, oder null. */
function finden (kennung) {
  if (!gueltig(kennung)) return null;
  aufraeumen();
  const e = merker.get(kennung);
  return e ? { code: e.code, antwort: e.antwort } : null;
}

function vergessen () { merker.clear(); }
function anzahl () { return merker.size; }

module.exports = { merken, finden, vergessen, anzahl, gueltig, FRIST_MS };
