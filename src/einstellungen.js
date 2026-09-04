// Schalter, die im Betrieb umgelegt werden und einen Neustart überleben.
//
// Sie stehen in der Datenbank und nicht in der Umgebung: wer am Abend die
// Auto-Freigabe abschaltet, will nicht auf einen Redeploy warten. Die
// Umgebungsvariable ist nur noch der Startwert.

const cfg = require('./config');
const { abfragen } = require('./db');

const SCHLUESSEL = { autoFreigabe: 'auto_freigabe', nachschub: 'nachschub' };

function vorgabe () {
  return {
    autoFreigabe: cfg.autoFreigabe, // sauberes FREI direkt in die Anzeige?
    nachschub: true                 // teilt der Scheduler neue Botschaften zu?
  };
}

let zwischenspeicher = null;

/** Aktueller Stand beider Schalter. Wird zwischengespeichert — der Scheduler fragt viermal je Sekunde. */
function schalter () {
  if (zwischenspeicher) return zwischenspeicher;
  const s = vorgabe();
  for (const [name, schluessel] of Object.entries(SCHLUESSEL)) {
    const zeile = abfragen.einstellungLesen.get(schluessel);
    if (zeile) s[name] = zeile.wert === '1';
  }
  zwischenspeicher = s;
  return s;
}

function setzen (name, wert) {
  if (!(name in SCHLUESSEL)) throw new Error('Unbekannter Schalter: ' + name);
  abfragen.einstellungSchreiben.run({
    schluessel: SCHLUESSEL[name], wert: wert ? '1' : '0', geaendert_am: Date.now()
  });
  zwischenspeicher = null;
  return schalter();
}

/** Nach einem Leeren der Datenbank oder im Test. */
function vergessen () { zwischenspeicher = null; }

module.exports = { schalter, setzen, vergessen };
