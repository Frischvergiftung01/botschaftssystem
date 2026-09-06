// Prueft die Spielzeiten-Logik gegen eine Wegwerf-Datenbank.
//
//   node werkzeuge/sessionen-test.js
//
// Interessant sind vor allem drei Stellen, an denen man sich leicht vertut:
// die Zeitzone (der Dienst laeuft auf UTC, die Uhrzeiten meinen Ortszeit),
// die Rueckrechnung der Standzeit vom Sessionende, und dass eine verpasste
// Runde von selbst aus der Auswahl faellt.

process.env.DB_PFAD = process.env.DB_PFAD || '/tmp/sessionen-test.db';
process.env.ZEITZONE = process.env.ZEITZONE || 'Europe/Berlin';
require('fs').rmSync(process.env.DB_PFAD, { force: true });
require('fs').rmSync(process.env.DB_PFAD + '-wal', { force: true });
require('fs').rmSync(process.env.DB_PFAD + '-shm', { force: true });

const cfg = require('../src/config');
const { db, abfragen } = require('../src/db');
const s = require('../src/sessionen');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz ? '   -> ' + zusatz : ''));
}

const STANDZEIT = cfg.standzeitSekunden * 1000;

/**
 * Die aktuelle Minute des Tages in der VERANSTALTUNGSZEITZONE. Nicht
 * new Date().getHours() nehmen: der Testrechner steht womoeglich auf UTC,
 * und dann liegen die erzeugten Zeilen um den Zonenversatz daneben.
 */
function jetztOrtsminute () {
  const g = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.ZEITZONE, hour12: false, hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  const h = Number(g.find(t => t.type === 'hour').value) % 24;
  const m = Number(g.find(t => t.type === 'minute').value);
  return h * 60 + m;
}

console.log('\nUhrzeiten');
pruefe('19:29 wird zu 1169', s.ausUhrzeit('19:29') === 1169, s.ausUhrzeit('19:29'));
pruefe('1169 wird zu 19:29', s.alsUhrzeit(1169) === '19:29', s.alsUhrzeit(1169));
pruefe('Punkt statt Doppelpunkt geht auch', s.ausUhrzeit('19.29') === 1169);
pruefe('Unsinn wird abgelehnt', s.ausUhrzeit('halb acht') === null);
pruefe('25:00 wird abgelehnt', s.ausUhrzeit('25:00') === null);

console.log('\nZeitzone');
{
  const t = s.heuteUm(19 * 60 + 29);
  const ort = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(t));
  pruefe('heuteUm(19:29) ist in Berlin auch 19:29', ort === '19:29', ort);
}

console.log('\nPlanung speichern');
{
  const n = s.speichern([
    { geplantStart: '19:12', geplantEnde: '19:29' },
    { geplantStart: '19:42', geplantEnde: '19:59' },
    { geplantStart: '20:12', geplantEnde: '20:29' }
  ]);
  pruefe('drei Zeilen gespeichert', n === 3, n);
  const st = s.stand();
  pruefe('Stand zeigt drei Zeilen', st.zeilen.length === 3, st.zeilen.length);
  pruefe('Zeilen sind durchnummeriert', st.zeilen.map(z => z.nr).join() === '1,2,3');
  pruefe('Uhrzeiten kommen lesbar zurueck', st.zeilen[0].geplantEnde === '19:29', st.zeilen[0].geplantEnde);
  pruefe('ohne Start ist Phase Pause', st.phase === 'pause', st.phase);
  pruefe('ohne Start kein Nachschub', st.nachschubErlaubt === false);
}

console.log('\nVerdrehte Zeiten werden abgewiesen');
{
  let gefangen = false;
  try { s.speichern([{ geplantStart: '19:40', geplantEnde: '19:20' }]); } catch (e) { gefangen = true; }
  pruefe('Ende vor Anfang wirft', gefangen);
  // Die Planung von eben muss unberuehrt sein.
  pruefe('Planung ist nicht kaputtgegangen', s.stand().zeilen.length === 3);
}

console.log('\nVergangene Runden fallen heraus');
{
  // Zwei Runden liegen in der Vergangenheit, eine in der Zukunft.
  const jetztMin = jetztOrtsminute();
  const frueher = Math.max(1, jetztMin - 120);
  const spaeter = Math.min(1400, jetztMin + 120);
  s.speichern([
    { geplantStart: s.alsUhrzeit(frueher), geplantEnde: s.alsUhrzeit(frueher + 17) },
    { geplantStart: s.alsUhrzeit(spaeter), geplantEnde: s.alsUhrzeit(spaeter + 17) }
  ]);
  const n = s.naechste();
  pruefe('naechste ueberspringt die verpasste Runde', n && n.nr === 2, n && n.nr);
  const st = s.stand();
  pruefe('verpasste Runde ist als solche gekennzeichnet', st.zeilen[0].verpasst === true);
  pruefe('kommende Runde ist nicht verpasst', st.zeilen[1].verpasst === false);
  pruefe('Countdown bis Start ist positiv', st.kommend.sekundenBisStart > 0, st.kommend.sekundenBisStart);
}

console.log('\nStarten, Nachschub, Auslaufen');
{
  const st = s.starten();
  pruefe('Phase ist laeuft', st.phase === 'laeuft', st.phase);
  pruefe('Nachschub ist erlaubt', st.nachschubErlaubt === true);
  pruefe('aktuelle Runde ist Nummer 2', st.aktuell.nr === 2, st.aktuell.nr);
  pruefe('Restzeit ist plausibel', st.aktuell.restSekunden > 60, st.aktuell.restSekunden);

  let nochmal = false;
  try { s.starten(); } catch (e) { nochmal = true; }
  pruefe('zweiter Start wird abgewiesen', nochmal);

  // Ende kuenstlich nach vorn ziehen: noch 10 s bis zur Leere, also mitten
  // im Auslaufen. Der Nachschub muss dann schon zu sein.
  const l = s.laufende();
  db.prepare('UPDATE sessionen SET ende = ? WHERE id = ?').run(Date.now() + 10000, l.id);
  s.vergessen();
  const aus = s.stand();
  pruefe('Phase ist laeuftAus', aus.phase === 'laeuftAus', aus.phase);
  pruefe('kein Nachschub mehr', aus.nachschubErlaubt === false);
  pruefe('Nachschubrest ist null', aus.aktuell.nachschubRestSekunden === 0, aus.aktuell.nachschubRestSekunden);
  pruefe('Restzeit laeuft aber noch', aus.aktuell.restSekunden > 0 && aus.aktuell.restSekunden <= 10,
    aus.aktuell.restSekunden);

  // Und eine Sekunde vor dem Nachschubschluss muss noch geladen werden.
  db.prepare('UPDATE sessionen SET ende = ? WHERE id = ?').run(Date.now() + STANDZEIT + 1000, l.id);
  s.vergessen();
  pruefe('kurz vor Nachschubschluss noch offen', s.nachschubErlaubt() === true);
  db.prepare('UPDATE sessionen SET ende = ? WHERE id = ?').run(Date.now() + STANDZEIT - 1000, l.id);
  s.vergessen();
  pruefe('kurz nach Nachschubschluss zu', s.nachschubErlaubt() === false);
}

console.log('\nAbbrechen');
{
  const st = s.abbrechen();
  pruefe('nach dem Abbruch ist Pause', st.phase === 'pause', st.phase);
  pruefe('kein Nachschub nach Abbruch', st.nachschubErlaubt === false);
  pruefe('Zeile ist als abgebrochen vermerkt', st.zeilen[1].abgebrochen === true);
  let ohne = false;
  try { s.abbrechen(); } catch (e) { ohne = true; }
  pruefe('Abbruch ohne laufende Runde wird abgewiesen', ohne);
}

console.log('\nEine laufende Runde uebersteht das Umplanen');
{
  s.speichern([
    { geplantStart: s.alsUhrzeit(jetztOrtsminute()), geplantEnde: '23:58' }
  ]);
  s.starten();
  const vorher = s.laufende().start;
  s.speichern([{ geplantStart: s.stand().zeilen[0].geplantStart, geplantEnde: '23:59' }]);
  const nachher = s.laufende();
  pruefe('Runde laeuft weiter', nachher !== null);
  pruefe('echter Start bleibt erhalten', nachher && nachher.start === vorher);
  pruefe('neues Ende ist uebernommen', nachher && s.alsUhrzeit(nachher.geplant_ende) === '23:59',
    nachher && s.alsUhrzeit(nachher.geplant_ende));
}

console.log('\nStandzeit im Betrieb');
{
  const einstellungen = require('../src/einstellungen');
  pruefe('Startwert kommt aus der Umgebung',
    einstellungen.standzeit() === cfg.standzeitSekunden, einstellungen.standzeit());

  einstellungen.standzeitSetzen(40);
  pruefe('neuer Wert gilt', einstellungen.standzeit() === 40, einstellungen.standzeit());

  for (const daneben of [0, 4, 301, 'viel', null]) {
    let gefangen = false;
    try { einstellungen.standzeitSetzen(daneben); } catch (e) { gefangen = true; }
    pruefe('abgewiesen: ' + JSON.stringify(daneben), gefangen);
  }
  pruefe('der gute Wert steht noch', einstellungen.standzeit() === 40, einstellungen.standzeit());

  // Und sie muss sofort in die Rueckrechnung vom Sessionende einfliessen.
  // Planung von vorn: aus dem Block davor laeuft noch eine Runde.
  db.prepare('DELETE FROM sessionen').run();
  s.vergessen();
  s.speichern([{ geplantStart: s.alsUhrzeit(jetztOrtsminute()), geplantEnde: '23:59' }]);
  s.starten();
  const l = s.laufende();
  db.prepare('UPDATE sessionen SET ende = ? WHERE id = ?').run(Date.now() + 30000, l.id);
  s.vergessen();
  pruefe('bei 40 s Standzeit ist 30 s vor Schluss schon zu', s.nachschubErlaubt() === false);
  einstellungen.standzeitSetzen(25);
  pruefe('bei 25 s Standzeit ist noch offen', s.nachschubErlaubt() === true);
}

console.log('\n' + (fehler ? fehler + ' Fehler' : 'Alles gruen') + '\n');
process.exit(fehler ? 1 : 0);
