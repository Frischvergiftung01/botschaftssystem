// Normalisierung vor dem Wortlistenabgleich.
//
// Ohne diesen Schritt umgeht die Wortliste jeder in einer halben Minute:
// "A r s c h l o c h", "4rschl0ch", "a.r.s.c.h.l.o.c.h", "Arschlooooch".
// Deshalb wird der Text erst geglättet und dann verglichen — und die
// Wortliste selbst läuft durch dieselbe Glättung, damit beide Seiten
// dieselbe Sprache sprechen.
//
// Es entstehen drei Fassungen, weil nicht jede Prüfung dieselbe braucht:
//   basis     — Kleinschreibung, ohne Diakritika, Zahlen unangetastet
//               (dafür sind die Zahlencodes da: 88 darf nicht zu "ss" werden)
//   entzerrt  — dazu: Trennzeichen und Sperrschreibung aufgelöst
//   geglaettet— dazu: Leetspeak aufgelöst, Wiederholungen gekürzt
//               (die Fassung, gegen die die Wortliste läuft)

const LEET = { '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't', '9': 'g', '8': 'b' };

function ohneDiakritika (s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "a.r.s.c.h" und "a-r-s-c-h" zusammenziehen, aber "hallo.oma" nicht verkleben:
// Trennzeichen verschwinden nur dort, wo sie zwischen einzelnen Zeichen stehen.
function trennzeichenAufloesen (s) {
  return s.replace(/\b(?:[a-z0-9][.\-_*~^'`]){2,}[a-z0-9]\b/g, t => t.replace(/[.\-_*~^'`]/g, ''));
}

// "S I E G H E I L" → "siegheil". Erst ab drei Einzelbuchstaben in Folge,
// damit "a b" oder ein einzelnes "e" nichts kaputt macht.
function sperrschriftAufloesen (s) {
  return s.replace(/\b(?:[a-z0-9] ){2,}[a-z0-9]\b/g, t => t.replace(/ /g, ''));
}

// Leetspeak nur dort aufloesen, wo Buchstaben im Spiel sind. Eine reine
// Zahlengruppe bleibt unangetastet — sonst wuerde aus der Jahreszahl 1888
// ein "ibi" und aus dem Code 88 ein "bb", und die Zahlenpruefung liefe ins Leere.
function leetAufloesen (s) {
  return s.replace(/[^\s]+/g, wort =>
    /[a-z]/.test(wort) ? wort.replace(/[1!|34@05$7+98]/g, z => LEET[z] || z) : wort);
}

// "niiiicht" → "nicht", "kaffee" → "kafe". Dass dabei auch harmlose
// Doppelbuchstaben fallen, ist gewollt — die Wortliste wird genauso behandelt.
function wiederholungenKuerzen (s) {
  return s.replace(/(.)\1+/g, '$1');
}

function normalisieren (roh) {
  const basis = ohneDiakritika(String(roh || '').toLowerCase())
    .replace(/ß/g, 'ss')
    // "auslaender" und "Ausländer" muessen dieselbe Zeichenfolge ergeben:
    // die Umlaute sind oben schon zu a/o/u geworden, hier folgt die
    // ausgeschriebene Variante nach. Gilt fuer Botschaft und Wortliste
    // gleichermassen, deshalb kann die Wortliste natuerlich geschrieben werden.
    .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
    .replace(/\s+/g, ' ')
    .trim();

  const entzerrt = sperrschriftAufloesen(trennzeichenAufloesen(basis));
  const geglaettet = wiederholungenKuerzen(leetAufloesen(entzerrt));

  const woerter = geglaettet.split(/[^a-z0-9]+/).filter(Boolean);
  return {
    basis,
    entzerrt,
    geglaettet,
    woerter,
    satz: ' ' + woerter.join(' ') + ' ',   // für den Abgleich mit Wortgrenzen
    kompakt: woerter.join('')              // nur für wenige, lange Begriffe
  };
}

module.exports = { normalisieren, wiederholungenKuerzen, leetAufloesen };
