// Test der Filterkette, Stufe 1a. Aufruf: npm test
//
// Die Tabelle unten ist die ausführbare Fassung der Beispieltabellen aus
// `Filterrichtlinie.md`. Wer die Richtlinie ändert, ändert hier mit — und
// merkt sofort, wenn eine Änderung an anderer Stelle etwas umwirft.
const assert = require('assert');
const fs = require('fs');

process.env.DB_PFAD = '/tmp/filter-test.db';
process.env.SPERRE_SEKUNDEN = '0';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { pruefen, nichtDarstellbar } = require('../src/filter');
const { fastify } = require('../src/server');

const FAELLE = [
  // [Botschaft, erwartetes Urteil, Abschnitt der Richtlinie]
  ['Hallo Oma!',                          'FREI',     '3'],
  ['Für Anna, ich liebe dich',            'FREI',     '3'],
  ['Willst du mich heiraten?',            'FREI',     '3'],
  ['Ruhe in Frieden, Papa',               'FREI',     '5 Trauer'],
  ['Prost Stuttgart',                     'FREI',     '5 Alkohol'],
  ['Wir sehen uns am Brunnen',            'FREI',     '4.8 keine Kontaktdaten'],
  ['Danke an die Feuerwehr',              'FREI',     '4.2'],
  ['Danke an die Uni Hohenheim',          'FREI',     '8.4 Institutionen'],
  ['Frieden',                             'FREI',     '4.2 Wunsch ohne Adressat'],
  ['VfB!',                                'FREI',     '8.2 örtlicher Verein'],
  ['Grüne Soße schmeckt',                 'FREI',     'Ausnahme'],
  ['Die linke Hand',                      'FREI',     'Ausnahme'],
  ['Kriegsbergstraße',                    'FREI',     'Ausnahme'],
  ['Jahrgang 88',                         'FREI',     'Ausnahme'],
  ['seit 1888',                           'FREI',     'Jahreszahl, kein Code'],

  ['Frieden für Gaza',                    'PRUEFEN',  '4.2 laufender Konflikt'],
  ['Rettet das Klima',                    'PRUEFEN',  '8.3 Anliegen ohne Gegner'],
  ['Die Grünen',                          'PRUEFEN',  '4.2 Partei'],
  ['Go BVB',                              'PRUEFEN',  '8.2 auswärtiger Verein'],
  ['Danke an Mercedes',                   'PRUEFEN',  '4.6 Marke'],
  ['88',                                  'PRUEFEN',  '4.3 Code, aber auch Jahrgang'],
  ['aaaa aaaa aaaa aaaa',                 'PRUEFEN',  '4.9 Spam'],

  ['Beste Pizza bei Luigi, www.luigi.de', 'ABLEHNEN', '4.8 Adresse'],
  ['Schreib mir: post@example.de',        'ABLEHNEN', '4.8 Mail'],
  ['Ruf mich an 0711 2345678',            'ABLEHNEN', '4.8 Telefon'],
  ['Folg mir @meinkanal',                 'ABLEHNEN', '4.8 Handle'],
  ['Du Arschloch',                        'ABLEHNEN', '4.1'],
  ['A R S C H L O C H',                   'ABLEHNEN', '6 Sperrschrift'],
  ['4rschl0ch',                           'ABLEHNEN', '6 Leetspeak'],
  ['a.r.s.c.h.l.o.c.h',                   'ABLEHNEN', '6 Trennzeichen'],
  ['Arschlooooch',                        'ABLEHNEN', '6 Wiederholung'],
  ['Sieg Heil',                           'ABLEHNEN', '4.3'],
  ['Ausländer raus',                      'ABLEHNEN', '4.3'],
  ['1488',                                'ABLEHNEN', '4.3 Code'],
  ['Ich töte dich',                       'ABLEHNEN', '4.5']
];

let fehler = 0;
for (const [text, erwartet, abschnitt] of FAELLE) {
  const ist = pruefen(text).urteil;
  if (ist !== erwartet) {
    fehler++;
    console.error(`  ✗ ${JSON.stringify(text)} → ${ist}, erwartet ${erwartet}  (Richtlinie ${abschnitt})`);
  }
}
assert.strictEqual(fehler, 0, `${fehler} von ${FAELLE.length} Fällen weichen von der Richtlinie ab`);

// Zeichen, die die Schrift nicht kennt
assert.deepStrictEqual(nichtDarstellbar('Prost Stuttgart 🎉'), ['🎉']);
assert.deepStrictEqual(nichtDarstellbar('Grüße, Größe, Straße — schön!'), []);

(async () => {
  // Abgelehntes kommt als Fehler zurück, ohne Grund, und wird protokolliert
  const abgelehnt = await fastify.inject({
    method: 'POST', url: '/api/botschaft',
    payload: { text: 'Du Arschloch', geraet: 'test-filter-1' }
  });
  assert.strictEqual(abgelehnt.statusCode, 422);
  assert.ok(/nicht zeigen/.test(abgelehnt.json().fehler), 'freundliche Absage erwartet');
  assert.ok(!/wortliste|arschloch/i.test(abgelehnt.body), 'der Grund darf nicht nach draußen');

  // Grenzfall landet in der Queue, nicht in der Anzeige — auch bei AUTO_FREIGABE
  const grenzfall = await fastify.inject({
    method: 'POST', url: '/api/botschaft',
    payload: { text: 'Grüße an alle Fans vom BVB', geraet: 'test-filter-2' }
  });
  assert.strictEqual(grenzfall.statusCode, 200);
  assert.strictEqual(grenzfall.json().status, 'neu', 'PRUEFEN gehört in die Moderationsqueue');

  // Sauberes geht durch
  const frei = await fastify.inject({
    method: 'POST', url: '/api/botschaft',
    payload: { text: 'Hallo Oma, wir denken an dich', name: 'Lena', geraet: 'test-filter-3' }
  });
  assert.strictEqual(frei.json().status, 'freigegeben');

  // Emoji wird mit Begründung abgewiesen — das ist eine Anzeigefrage
  const emoji = await fastify.inject({
    method: 'POST', url: '/api/botschaft',
    payload: { text: 'Prost Stuttgart 🎉', geraet: 'test-filter-4' }
  });
  assert.strictEqual(emoji.statusCode, 400);
  assert.ok(/darstellen/.test(emoji.json().fehler));

  console.log(`
  ${FAELLE.length} Fälle aus der Filterrichtlinie geprüft, alle wie beschrieben.
  Ablehnung ohne Grund, Grenzfall in der Queue, Sauberes in der Anzeige.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
