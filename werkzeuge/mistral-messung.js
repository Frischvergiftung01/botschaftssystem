// Latenz-, Rate-Limit- und Trefferquotenmessung für Stufe 1b.
// Aufruf (Windows):  set MISTRAL_API_KEY=...   dann   npm run messung
//
// Drei Fragen, die diese Messung beantwortet:
//   1. Wie lange dauert ein Aufruf wirklich? (Das Zeitlimit steht bei 3 s.)
//   2. Wie viele Aufrufe gleichzeitig verträgt der Tarif, bevor 429 kommt?
//   3. Trifft das Modell die Grenzfälle, die die Wortliste nicht sehen kann?
//
// Die Fälle unten sind bewusst solche, an denen Stufe 1a blind ist: Ironie,
// Anspielung, verpackte Politik, vollständige Namen. Wo hier etwas nicht passt,
// gehört der Prompt in `src/richtlinie.js` nachgeschärft — nicht die Wortliste.

const cfg = require('../src/config');
const mistral = require('../src/mistral');

if (!mistral.aktiv()) {
  console.error('MISTRAL_API_KEY ist nicht gesetzt. Unter Windows:  set MISTRAL_API_KEY=...');
  process.exit(1);
}

const FAELLE = [
  ['Hallo Oma, wir denken an dich',                       'FREI'],
  ['Für Anna — du bist mein Zuhause',                     'FREI'],
  ['Willst du mich heiraten, Miriam?',                    'FREI'],
  ['Ruhe in Frieden, Papa. Wir vermissen dich',           'FREI'],
  ['Danke an alle, die heute hinter der Bühne stehen',    'FREI'],
  ['Prost Stuttgart, was für ein Abend',                  'FREI'],
  ['Frieden',                                             'FREI'],
  ['VfB bis ich sterbe',                                  'FREI'],
  ['Danke an die Uni Hohenheim für fünf gute Jahre',      'FREI'],
  ['Bonjour Stuttgart, merci pour cette soirée',          'FREI'],

  ['Frieden für die Ukraine',                             'ABLEHNEN'],
  ['Anna Meier, ich liebe dich',                          'ABLEHNEN'],
  ['Unser Kanzler ist eine Vollkatastrophe',              'ABLEHNEN'],
  ['Kauft alle bei uns im Laden ein, beste Preise',       'ABLEHNEN'],
  ['Wer heute nicht feiert, ist ein Loser',               'ABLEHNEN'],
  ['Ich mach dich kalt, Kevin',                           'ABLEHNEN'],

  ['Rettet das Klima, bevor es zu spät ist',              'PRUEFEN'],
  // Strittig und deshalb mit zwei zulaessigen Urteilen: die Losung ist
  // historisch belegt und heute vereinnahmt. Streng ist hier vertretbar.
  ['Wir sind das Volk',                                   ['PRUEFEN', 'ABLEHNEN']],
  ['Grüße an alle, die wissen, was 1312 bedeutet',        'PRUEFEN'],
  ['Danke Mercedes für 40 Jahre',                         'PRUEFEN']
];

const pKachel = (werte, p) => werte.slice().sort((a, b) => a - b)[Math.min(werte.length - 1, Math.floor(werte.length * p))];

(async () => {
  console.log(`Modell: ${cfg.mistralModell} · Zeitlimit: ${cfg.mistralZeitlimitMs} ms\n`);

  // ---- 1. Nacheinander: Latenz und Trefferquote --------------------------
  const zeiten = [];
  let daneben = 0;
  console.log('Fall für Fall:');
  for (const [text, erwartet] of FAELLE) {
    const t = Date.now();
    const r = await mistral.bewerten(text);
    zeiten.push(Date.now() - t);
    const zulaessig = [].concat(erwartet);
    const passt = zulaessig.includes(r.urteil);
    if (!passt) daneben++;
    console.log(`  ${passt ? ' ' : '✗'} ${String(r.ms + ' ms').padStart(7)}  ${(r.urteil + '        ').slice(0, 9)} ${passt ? '' : '(erwartet ' + zulaessig.join(' oder ') + ') '}${text}`);
  }

  console.log(`
  Latenz   p50 ${pKachel(zeiten, 0.5)} ms · p90 ${pKachel(zeiten, 0.9)} ms · max ${Math.max(...zeiten)} ms
  Treffer  ${FAELLE.length - daneben} von ${FAELLE.length}`);

  // ---- 2. Gleichzeitigkeit: wo kommt der 429? ----------------------------
  console.log('\nGleichzeitigkeit:');
  const messungen = [];
  for (const parallel of [2, 4, 8, 16]) {
    cfg.mistralParallel = parallel + 5;   // Semaphore aushebeln, wir wollen ans echte Limit
    const start = Date.now();
    const ergebnisse = await Promise.all(
      Array.from({ length: parallel }, (_, i) => mistral.bewerten('Hallo Stuttgart, Testlauf ' + i))
    );
    const dauer = Date.now() - start;
    const abgewiesen = ergebnisse.filter(r => /http 429/.test(r.grund || '')).length;
    const fehler = ergebnisse.filter(r => r.grund && !/http 429/.test(r.grund)).length;
    messungen.push({ parallel, dauer, abgewiesen, fehler });
    console.log(`  ${String(parallel).padStart(2)} gleichzeitig: ${String(dauer + ' ms').padStart(8)} · ${abgewiesen} × 429 · ${fehler} andere Fehler`);
    await new Promise(r => setTimeout(r, 2000));   // dem Tarif Luft lassen
  }

  const sauber = messungen.filter(m => !m.abgewiesen && !m.fehler).map(m => m.parallel);
  // Die Messung schwankt zwischen Laeufen erheblich - dieselbe Stufe ist mal
  // sauber, mal nicht. Deshalb nur bis 8 empfehlen: der Gewinn daruber ist
  // Rauschen, das Risiko am Abend ist es nicht.
  const empfehlung = Math.min(8, sauber.length ? Math.max(...sauber) : 2);

  // Massgeblich ist die Latenz UNTER LAST, nicht die im Leerlauf: bei acht
  // gleichzeitigen Aufrufen dauert der einzelne ein Vielfaches. Wer das
  // Zeitlimit nach der Leerlaufmessung setzt, bricht genau dann ab, wenn
  // Andrang ist - also am Abend um halb elf.
  const unterLast = messungen.find(m => m.parallel === empfehlung);
  const zeitlimit = Math.max(2500, Math.ceil((unterLast ? unterLast.dauer : 0) * 1.3 / 500) * 500);

  console.log(`
  Empfehlung für Coolify:
    MISTRAL_PARALLEL = ${empfehlung}
    MISTRAL_ZEITLIMIT_MS = ${zeitlimit}

  Zähler: ${JSON.stringify(mistral.kennzahlen())}`);
})().catch(e => { console.error(e); process.exit(1); });
