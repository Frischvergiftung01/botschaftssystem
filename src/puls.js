// Lebenszeichen der Bridge.
//
// Der Server kann von sich aus nicht sehen, ob die Bridge laeuft: er ist
// passiv, die Verbindung geht immer von ihr aus. Am Abend ist aber genau das
// die Frage, die man in der Moderation beantwortet haben will — steht die Wand
// still, weil nichts freigegeben ist, oder weil die Bridge haengt?
//
// Deshalb meldet sich die Bridge alle paar Sekunden. Der Stand liegt bewusst
// NUR im Arbeitsspeicher: er ist Sekunden gueltig, nach einem Neustart ohnehin
// falsch, und eine Datenbankzeile je Puls waere Schreiblast ohne Nutzen.

const FRIST_MS = 15000;   // so lange gilt ein Puls als frisch

let letzter = null;       // { zeit, ...stand }

function melden (stand = {}) {
  letzter = { zeit: Date.now(), ...stand };
  return letzter;
}

/**
 * Was die Moderation anzeigt.
 * @returns {{gemeldet:boolean, frisch:boolean, vorSekunden:number|null, stand:object|null}}
 */
function stand () {
  if (!letzter) return { gemeldet: false, frisch: false, vorSekunden: null, stand: null };
  const her = Date.now() - letzter.zeit;
  const { zeit, ...rest } = letzter;
  return {
    gemeldet: true,
    frisch: her <= FRIST_MS,
    vorSekunden: Math.round(her / 1000),
    stand: rest
  };
}

/** Fuer Tests und nach einem Leeren. */
function vergessen () { letzter = null; }

module.exports = { melden, stand, vergessen, FRIST_MS };
