// Der Belegungsplan als Rechenwerk — ohne Datenbank, ohne Scheduler.
//   node werkzeuge/belegungsplan-test.js
//
// Geprüft werden die Zusagen, auf die sich die Auskunft an den Absender
// stützt: keine Botschaft steht zweimal gleichzeitig an der Fassade, keine
// wiederholt sich direkt auf derselben Fläche, nichts wird gebucht, was dort
// nicht lesbar wäre, und der Vorrat kommt der Reihe nach dran statt immer
// derselbe zuerst.

process.env.STANDZEIT = '25';
process.env.LOG_LEVEL = 'silent';

const cfg = require('../src/config');
const { FLAECHEN } = require('../src/flaechen');
const { groesseFuer } = require('../src/text');
const plan = require('../src/belegungsplan');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + JSON.stringify(zusatz) : ''));
}

const STANDZEIT = 25000;
const T0 = 1_800_000_000_000;   // feste Uhr, damit nichts vom Testzeitpunkt abhängt

/** Ein Flächenzustand wie ihn der Scheduler führt: alles frei. */
function leererZustand (jetzt = T0) {
  const m = new Map();
  for (const f of FLAECHEN) {
    m.set(f.nr, {
      nr: f.nr, name: f.name, breite: f.breite, gruppe: f.gruppe,
      botschaftId: null, hinweisId: null, text: '', absender: null, start: 0, ende: 0
    });
  }
  return m;
}

function botschaften (anzahl, bauer) {
  const liste = [];
  for (let i = 1; i <= anzahl; i++) {
    liste.push(Object.assign({
      id: i, text: 'Botschaft ' + i, name: null,
      anzahl_anzeigen: 0, zuletzt_gezeigt: null, erstellt_am: T0 - 100000 + i
    }, bauer ? bauer(i) : {}));
  }
  return liste;
}

console.log('\nGrundlauf über drei Minuten');
const dreiMinuten = plan.bauen({
  zustand: leererZustand(),
  vorrat: botschaften(120),
  hinweise: [],
  jetzt: T0,
  standzeitMs: STANDZEIT,
  horizontMs: 180000
});
{
  const e = dreiMinuten.eintraege;
  pruefe('es wird überhaupt gebucht', e.length > 100, e.length);
  pruefe('nichts vor jetzt', e.every(x => x.start >= T0));
  pruefe('nichts hinter dem Horizont', e.every(x => x.start < T0 + 180000),
    e.filter(x => x.start >= T0 + 180000).length);
  pruefe('jede Fläche kommt vor', new Set(e.map(x => x.flaeche)).size === FLAECHEN.length,
    new Set(e.map(x => x.flaeche)).size);
  pruefe('jeder Eintrag trägt seinen Ort', e.every(x => x.flaecheName && x.gruppe));
}

console.log('\nKeine Botschaft steht zweimal gleichzeitig');
{
  const nachId = new Map();
  for (const e of dreiMinuten.eintraege) {
    if (e.botschaftId === null) continue;
    if (!nachId.has(e.botschaftId)) nachId.set(e.botschaftId, []);
    nachId.get(e.botschaftId).push(e);
  }
  let ueberschneidungen = 0;
  for (const liste of nachId.values()) {
    liste.sort((a, b) => a.start - b.start);
    for (let i = 1; i < liste.length; i++) if (liste[i].start < liste[i - 1].ende) ueberschneidungen++;
  }
  pruefe('keine Überschneidung', ueberschneidungen === 0, ueberschneidungen);
}

console.log('\nKeine direkte Wiederholung auf derselben Fläche');
{
  const nachFlaeche = new Map();
  for (const e of dreiMinuten.eintraege) {
    if (!nachFlaeche.has(e.flaeche)) nachFlaeche.set(e.flaeche, []);
    nachFlaeche.get(e.flaeche).push(e);
  }
  let wiederholungen = 0;
  for (const liste of nachFlaeche.values()) {
    liste.sort((a, b) => a.start - b.start);
    for (let i = 1; i < liste.length; i++) {
      if (liste[i].botschaftId !== null && liste[i].botschaftId === liste[i - 1].botschaftId) wiederholungen++;
    }
  }
  pruefe('keine Wiederholung', wiederholungen === 0, wiederholungen);
  pruefe('die Einträge je Fläche liegen lückenlos hintereinander',
    [...nachFlaeche.values()].every(l => l.every((x, i) => i === 0 || x.start >= l[i - 1].ende)));
}

console.log('\nNur wo es lesbar ist');
{
  const schlecht = dreiMinuten.eintraege.filter(e => e.groesse.versalhoehe < cfg.minVersalhoehe);
  pruefe('jede Buchung erreicht die Mindesthöhe', schlecht.length === 0,
    schlecht.slice(0, 3).map(e => ({ f: e.flaeche, h: e.groesse.versalhoehe })));
}

console.log('\nDer Vorrat kommt reihum dran');
{
  const wie_oft = new Map();
  for (const e of dreiMinuten.eintraege) {
    if (e.botschaftId === null) continue;
    wie_oft.set(e.botschaftId, (wie_oft.get(e.botschaftId) || 0) + 1);
  }
  const zahlen = [...wie_oft.values()];
  const min = Math.min(...zahlen), max = Math.max(...zahlen);
  pruefe('alle 120 waren dran', wie_oft.size === 120, wie_oft.size);
  pruefe('höchstens einmal Unterschied', max - min <= 1, { min, max });
}

console.log('\nÄltere Botschaften zuerst');
{
  const p = plan.bauen({
    zustand: leererZustand(),
    vorrat: botschaften(60),
    hinweise: [], jetzt: T0, standzeitMs: STANDZEIT, horizontMs: 26000
  });
  const ersteRunde = p.eintraege.slice(0, FLAECHEN.length).map(e => e.botschaftId);
  pruefe('die erste Runde nimmt die ältesten',
    Math.max(...ersteRunde) <= FLAECHEN.length + 3, Math.max(...ersteRunde));
}

console.log('\nLange Botschaften nur auf breiten Flächen');
{
  const lang = 'EIN AUSSERGEWOEHNLICH LANGER TEXT DER NUR AUF DIE BREITESTEN FLAECHEN PASST WIRKLICH';
  const p = plan.bauen({
    zustand: leererZustand(),
    vorrat: [{ id: 1, text: lang, name: null, anzahl_anzeigen: 0, zuletzt_gezeigt: null, erstellt_am: T0 },
      ...botschaften(40).map(b => ({ ...b, id: b.id + 100 }))],
    hinweise: [], jetzt: T0, standzeitMs: STANDZEIT, horizontMs: 120000
  });
  const seine = p.eintraege.filter(e => e.botschaftId === 1);
  pruefe('sie kommt überhaupt vor', seine.length > 0, seine.length);
  const passt = seine.every(e => {
    const f = FLAECHEN.find(x => x.nr === e.flaeche);
    return groesseFuer(lang, f.breite, cfg.maxVersalhoehe).versalhoehe >= cfg.minVersalhoehe;
  });
  pruefe('und nur dort, wo sie lesbar ist', passt,
    seine.map(e => e.flaecheName));
}

console.log('\nHinweise haben Vorrang auf der Stirnseite Mitte');
{
  const p = plan.bauen({
    zustand: leererZustand(),
    vorrat: botschaften(60),
    hinweise: [
      { id: 7, nr: 1, text: 'Letzte Runde um 22:30', anzahl_anzeigen: 0, zuletzt_gezeigt: null },
      { id: 8, nr: 2, text: 'Bitte den Durchgang freihalten', anzahl_anzeigen: 0, zuletzt_gezeigt: null }
    ],
    jetzt: T0, standzeitMs: STANDZEIT, horizontMs: 180000
  });
  const mitte = p.eintraege.filter(e => e.flaeche === cfg.hinweisFlaeche);
  pruefe('die Stirnseite Mitte zeigt nur Hinweise', mitte.every(e => e.hinweisId !== null),
    mitte.filter(e => e.hinweisId === null).length);
  pruefe('beide Hinweise kommen dran', new Set(mitte.map(e => e.hinweisId)).size === 2,
    [...new Set(mitte.map(e => e.hinweisId))]);
  pruefe('sie wechseln sich ab',
    mitte.every((e, i) => i === 0 || e.hinweisId !== mitte[i - 1].hinweisId));
  pruefe('die übrigen Flächen zeigen Botschaften',
    p.eintraege.filter(e => e.flaeche !== cfg.hinweisFlaeche).every(e => e.botschaftId !== null));
}

console.log('\nDas Sessionende schneidet den Plan ab');
{
  const p = plan.bauen({
    zustand: leererZustand(),
    vorrat: botschaften(60), hinweise: [],
    jetzt: T0, standzeitMs: STANDZEIT, horizontMs: 180000,
    endeMs: T0 + 40000
  });
  pruefe('nichts nach dem Nachschubschluss', p.eintraege.every(e => e.start < T0 + 40000));
  pruefe('aber davor sehr wohl', p.eintraege.length > FLAECHEN.length, p.eintraege.length);
  pruefe('reichtBis nennt die Grenze', p.reichtBis === T0 + 40000, p.reichtBis - T0);
}

console.log('\nLaufende Flächen werden respektiert');
{
  const z = leererZustand();
  const f = z.get(5);
  f.botschaftId = 3; f.text = 'Botschaft 3'; f.start = T0 - 10000; f.ende = T0 + 15000;
  const p = plan.bauen({
    zustand: z, vorrat: botschaften(60), hinweise: [],
    jetzt: T0, standzeitMs: STANDZEIT, horizontMs: 120000
  });
  const auf5 = p.eintraege.filter(e => e.flaeche === 5);
  pruefe('Fläche 5 wird erst nach ihrem Ende neu belegt', auf5.every(e => e.start >= T0 + 15000),
    auf5[0] && auf5[0].start - T0);
  pruefe('und nicht gleich wieder mit derselben',
    auf5.length === 0 || auf5[0].botschaftId !== 3, auf5[0] && auf5[0].botschaftId);
  const drei = p.eintraege.filter(e => e.botschaftId === 3);
  pruefe('Botschaft 3 wird nicht gebucht, solange sie noch steht',
    drei.every(e => e.start >= T0 + 15000), drei[0] && drei[0].start - T0);
}

console.log('\nLeerer Vorrat bringt den Plan nicht zum Hängen');
{
  const p = plan.bauen({
    zustand: leererZustand(), vorrat: [], hinweise: [],
    jetzt: T0, standzeitMs: STANDZEIT, horizontMs: 180000
  });
  pruefe('nichts gebucht, kein Aufhänger', p.eintraege.length === 0, p.eintraege.length);
}

console.log('\nNachschlagen');
{
  const eine = dreiMinuten.eintraege.find(e => e.botschaftId !== null);
  const gefunden = plan.naechsterFuer(dreiMinuten, eine.botschaftId, T0);
  pruefe('findet den frühesten Auftritt', gefunden && gefunden.start <= eine.start,
    gefunden && gefunden.start - T0);
  pruefe('nach dem Horizont nichts mehr',
    plan.naechsterFuer(dreiMinuten, eine.botschaftId, T0 + 999999) === null);
  pruefe('unbekannte Botschaft gibt null', plan.naechsterFuer(dreiMinuten, 99999, T0) === null);
  pruefe('ohne Plan gibt null', plan.naechsterFuer(null, 1, T0) === null);
}

console.log('\nRechenzeit');
{
  const vorrat = botschaften(400);
  const start = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) {
    plan.bauen({ zustand: leererZustand(), vorrat, hinweise: [], jetzt: T0, standzeitMs: STANDZEIT, horizontMs: 180000 });
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / 5;
  pruefe('unter 60 ms je Lauf bei 400 Botschaften', ms < 60, Math.round(ms) + ' ms');
  console.log('       (' + Math.round(ms) + ' ms je Lauf)');
}

console.log('\n' + (fehler ? fehler + ' Fehler' : 'Alles gruen') + '\n');
process.exit(fehler ? 1 : 0);
