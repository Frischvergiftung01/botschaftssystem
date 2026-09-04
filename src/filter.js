// Filterkette Stufe 1a — regelbasiert, sofort, serverseitig.
//
// Grundlage ist `Filterrichtlinie.md` im Konzeptionsordner. Diese Stufe
// entscheidet nur, was sie sicher entscheiden kann:
//
//   ABLEHNEN  Adressen und Kontaktdaten (4.8), harte Wortliste (4.1/4.3/4.4/4.5)
//   PRUEFEN   weiche Wortliste (4.2/4.6), Spamverdacht (4.9) → Moderationsqueue
//   FREI      nichts davon — geht weiter an Stufe 1b (Sprachmodell, Block 4b)
//
// Was diese Stufe NICHT kann und deshalb gar nicht erst versucht: Ironie,
// Anspielung, Kontext, vollständige Personennamen. Dafür ist das Sprachmodell da.
//
// Der Grund einer Ablehnung wird protokolliert, aber niemals an den Absender
// ausgegeben — sonst wird die Ablehnung zum Trainingsfeedback (Richtlinie 2.2).

const { normalisieren } = require('./normalisierung');
const liste = require('./wortliste');
const METRIK = require('./oswald-metrik.json');

const norm = s => normalisieren(s).geglaettet.replace(/[^a-z0-9]+/g, ' ').trim();

const HART = liste.hart.map(norm).filter(Boolean);
const HART_KOMPAKT = liste.hartKompakt.map(e => norm(e).replace(/ /g, ''));
const WEICH = liste.weich.map(norm).filter(Boolean);
const AUSNAHMEN = Object.fromEntries(
  Object.entries(liste.ausnahmen).map(([k, v]) => [norm(k), v.map(norm)])
);

// Richtlinie 4.8 — Kontaktdaten und Verweise. Entscheidet die Regelstufe allein.
const STRUKTUR = [
  ['adresse',  /https?:\/\/|\bwww\s*\./],
  ['adresse',  /\b[a-z0-9][a-z0-9-]{1,}\s*\.\s*(de|com|net|org|eu|io|tv|shop|info|at|ch|me|app|link)\b/],
  ['mail',     /\S+@\S+\.[a-z]{2,}/],
  ['handle',   /(^| )@[a-z0-9._-]{2,}/],
  ['telefon',  /(^|\D)(\+?\d[\d \/().-]{7,}\d)(\D|$)/]
];

// Was die Schrift nicht kennt, kann die Fassade nicht zeigen. Das ist keine
// Moderationsfrage, sondern eine Anzeigefrage — deshalb darf der Absender hier
// ausnahmsweise den Grund erfahren.
function nichtDarstellbar (text) {
  const fehlend = new Set();
  for (const z of String(text)) {
    if (z === '\n' || z === '\t') continue;
    if (!METRIK.glyphs[z]) fehlend.add(z);
  }
  return [...fehlend];
}

// Weiche Begriffe treffen auch gebeugt: "gruene" findet "die Gruenen",
// "linke" findet "linken". Erst ab fuenf Zeichen, sonst faengt "ns" halb
// Stuttgart. Fuer die harte Liste gilt das bewusst nicht — dort waere ein
// Fehlalarm eine Ablehnung, hier kostet er nur einen Blick der Moderation.
function weichTrifft (begriff, n) {
  if (begriff.includes(' ')) return n.satz.includes(' ' + begriff + ' ');
  if (begriff.length >= 5) return n.woerter.some(t => t.startsWith(begriff));
  return n.satz.includes(' ' + begriff + ' ');
}

function trefferMitAusnahme (begriff, satz) {
  const ausnahmen = AUSNAHMEN[begriff];
  if (!ausnahmen) return true;
  return !ausnahmen.some(a => satz.includes(a));
}

function pruefen (text, name = '') {
  const roh = name ? `${text} ${name}` : String(text);
  const n = normalisieren(roh);
  const gruende = [];

  for (const [regel, muster] of STRUKTUR) {
    if (muster.test(n.basis)) gruende.push({ regel, rang: 'hart', treffer: regel });
  }

  for (const begriff of HART) {
    if (n.satz.includes(' ' + begriff + ' ') && trefferMitAusnahme(begriff, n.satz)) {
      gruende.push({ regel: 'wortliste', rang: 'hart', treffer: begriff });
    }
  }
  for (const begriff of HART_KOMPAKT) {
    if (n.kompakt.includes(begriff)) gruende.push({ regel: 'wortliste-kompakt', rang: 'hart', treffer: begriff });
  }
  for (const muster of liste.hartMuster) {
    if (muster.test(n.basis)) gruende.push({ regel: 'code', rang: 'hart', treffer: String(muster) });
  }

  for (const begriff of WEICH) {
    if (weichTrifft(begriff, n) && trefferMitAusnahme(begriff, n.satz)) {
      gruende.push({ regel: 'wortliste', rang: 'weich', treffer: begriff });
    }
  }
  for (const muster of liste.weichMuster) {
    if (muster.test(n.basis)) gruende.push({ regel: 'code', rang: 'weich', treffer: String(muster) });
  }

  for (const grund of spamverdacht(n)) gruende.push(grund);

  const woerter = n.woerter.filter(t => /[a-z]/.test(t));
  const unsinnige = woerter.filter(unsinnigesWort);
  if (unsinnige.length) {
    const alles = unsinnige.length === woerter.length;
    gruende.push({ regel: 'unsinn', rang: alles ? 'hart' : 'weich', treffer: unsinnige[0] });
  }

  const urteil = gruende.some(g => g.rang === 'hart') ? 'ABLEHNEN'
    : gruende.length ? 'PRUEFEN'
      : 'FREI';

  return { urteil, stufe: '1a', gruende };
}

// Richtlinie 4.9 — offensichtlicher Tastatursalat. Die einzige Stelle, an der
// Unsinn direkt abgelehnt wird, und deshalb bewusst eng: nur ein Wort, das
// entweder eine Tastaturreihe abläuft (asdfgh, qwertz) oder dieselbe Silbe
// mindestens dreimal wiederholt (asdasdasd). Lachen und Ausrufe sind
// ausgenommen, sonst fiele "hahahaha" darunter. Abgelehnt wird nur, wenn die
// GANZE Botschaft so aussieht; ein einzelnes seltsames Wort in einem Satz
// bleibt ein Fall für die Moderation.
const TASTATURREIHEN = ['qwertzuiop', 'qwertyuiop', 'asdfghjkl', 'yxcvbnm', 'zxcvbnm', '1234567890'];
const AUSRUFE = new Set(['ha', 'he', 'hi', 'ho', 'hu', 'ja', 'na', 'la', 'le', 'lo', 'oh', 'ah', 'juh', 'tra']);

function tastaturmuster (wort) {
  for (const reihe of TASTATURREIHEN) {
    for (let i = 0; i + 5 <= wort.length; i++) {
      const teil = wort.slice(i, i + 5);
      if (reihe.includes(teil) || reihe.includes([...teil].reverse().join(''))) return true;
    }
  }
  return false;
}

function unsinnigesWort (wort) {
  if (wort.length < 6) return false;
  // Gedehntes zuerst aussortieren: "ohhhh", "neeee", "juhuuuu" sind keine
  // Tastatursalate, sondern Freude.
  const kern = wort.replace(/(.)\1+/g, '$1');
  if (kern.length <= 4) return false;
  if (tastaturmuster(wort)) return true;

  const silbe = wort.match(/^(.{2,4})\1{2,}$/);
  if (silbe) return !AUSRUFE.has(silbe[1]);

  // Wenig verschiedene Buchstaben auf viel Länge — "asdaffafafaf". Lachen und
  // Ausrufe sind ausgenommen, die bestehen aus derselben Silbe.
  if (wort.length >= 8 && new Set(wort).size <= 4) {
    const wiederholt = wort.match(/^(.{2,3})\1+$/);
    return !(wiederholt && AUSRUFE.has(wiederholt[1]));
  }
  return false;
}

// Richtlinie 4.9 — Spam. Sonst nur Verdacht, nie Ablehnung: bei einem
// Fehlalarm soll ein Mensch draufschauen, nicht die Maschine entscheiden.
function spamverdacht (n) {
  const gruende = [];
  const w = n.woerter;
  if (!w.length) return gruende;

  const zaehler = {};
  for (const t of w) zaehler[t] = (zaehler[t] || 0) + 1;
  if (Object.values(zaehler).some(x => x >= 4)) {
    gruende.push({ regel: 'spam', rang: 'weich', treffer: 'wiederholung' });
  }
  if (w.some(t => t.length >= 8 && !/[aeiouy]/.test(t))) {
    gruende.push({ regel: 'spam', rang: 'weich', treffer: 'zeichensalat' });
  }
  const ziffern = (n.basis.match(/\d/g) || []).length;
  if (n.basis.length >= 10 && ziffern / n.basis.length > 0.6) {
    gruende.push({ regel: 'spam', rang: 'weich', treffer: 'ziffernfolge' });
  }
  if (n.basis.length >= 12 && new Set(n.basis.replace(/[^a-z]/g, '')).size <= 3) {
    gruende.push({ regel: 'spam', rang: 'weich', treffer: 'zu wenig verschiedene zeichen' });
  }
  return gruende;
}

module.exports = { pruefen, nichtDarstellbar, spamverdacht, unsinnigesWort };
