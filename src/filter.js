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

  const urteil = gruende.some(g => g.rang === 'hart') ? 'ABLEHNEN'
    : gruende.length ? 'PRUEFEN'
      : 'FREI';

  return { urteil, stufe: '1a', gruende };
}

// Richtlinie 4.9 — Spam und Unsinn. Nur Verdacht, nie Ablehnung: bei einem
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

module.exports = { pruefen, nichtDarstellbar, spamverdacht };
