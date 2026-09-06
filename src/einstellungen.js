// Schalter, die im Betrieb umgelegt werden und einen Neustart überleben.
//
// Sie stehen in der Datenbank und nicht in der Umgebung: wer am Abend die
// Auto-Freigabe abschaltet, will nicht auf einen Redeploy warten. Die
// Umgebungsvariable ist nur noch der Startwert.

const cfg = require('./config');
const { abfragen } = require('./db');

// `belegungsplan` ist der Notausstieg fuer den Umbau: aus heisst, der
// Scheduler entscheidet wieder erst im Moment des Wechsels, so wie vor dem
// Plan. Die Fassade laeuft dann normal weiter, nur die Ortsangabe auf der
// Statusseite faellt weg. Wer am Abend Zweifel hat, legt den Schalter um
// statt einen Redeploy anzustossen.
const SCHLUESSEL = { autoFreigabe: 'auto_freigabe', nachschub: 'nachschub', belegungsplan: 'belegungsplan' };
const STANDZEIT = 'standzeit';
const STANDZEIT_MIN = 5;
const STANDZEIT_MAX = 300;

function vorgabe () {
  return {
    autoFreigabe: cfg.autoFreigabe, // sauberes FREI direkt in die Anzeige?
    nachschub: true,                // teilt der Scheduler neue Botschaften zu?
    belegungsplan: true             // wird im Voraus gebucht statt erst beim Wechsel?
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

// ---------------------------------------------------------------- Standzeit
// Wie lange eine Botschaft auf ihrer Flaeche stehen bleibt. Steht aus demselben
// Grund hier wie die Schalter: wer am Abend merkt, dass 25 s zu lang oder zu
// kurz sind, soll nicht auf einen Redeploy warten. Die Umgebungsvariable
// STANDZEIT ist nur noch der Startwert.
//
// Eigener Zwischenspeicher statt mit den Schaltern zusammen: eine Dauer ist
// kein Schalter, und `schalter()` soll weiter genau das liefern, was der Name
// verspricht.

let standzeitSpeicher = null;

/** Standzeit in Sekunden. Der Scheduler fragt viermal je Sekunde. */
function standzeit () {
  if (standzeitSpeicher !== null) return standzeitSpeicher;
  const zeile = abfragen.einstellungLesen.get(STANDZEIT);
  const gelesen = zeile ? Number(zeile.wert) : NaN;
  standzeitSpeicher = Number.isFinite(gelesen) ? gelesen : cfg.standzeitSekunden;
  return standzeitSpeicher;
}

function standzeitSetzen (sekunden) {
  const n = Math.round(Number(sekunden));
  if (!Number.isFinite(n) || n < STANDZEIT_MIN || n > STANDZEIT_MAX) {
    throw new Error(`Die Standzeit muss zwischen ${STANDZEIT_MIN} und ${STANDZEIT_MAX} Sekunden liegen.`);
  }
  abfragen.einstellungSchreiben.run({
    schluessel: STANDZEIT, wert: String(n), geaendert_am: Date.now()
  });
  standzeitSpeicher = null;
  return standzeit();
}

/** Nach einem Leeren der Datenbank oder im Test. */
function vergessen () { zwischenspeicher = null; standzeitSpeicher = null; }

module.exports = {
  schalter, setzen, standzeit, standzeitSetzen, vergessen, STANDZEIT_MIN, STANDZEIT_MAX
};
