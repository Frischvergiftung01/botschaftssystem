// Prueft, dass die Spielzeiten den Scheduler richtig anhalten.
//   node werkzeuge/sessionen-scheduler-test.js
//
// Die erste Pruefung ist die wichtigste des ganzen Umbaus: OHNE eingetragenen
// Plan muss die Fassade weiterlaufen wie vorher. Waere das nicht so, wuerde
// ein Deploy an einem Tag ohne gepflegte Zeiten die Wand dunkel schalten.
//
// Danach geht es um die Trennung der beiden Bremsen. Handschalter und
// Spielzeit halten beide nur den NACHSCHUB an — was steht, laeuft aus. Der
// harte Abbruch bleibt Resolume vorbehalten.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/sessionen-scheduler-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
process.env.STANDZEIT = '25';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const cfg = require('../src/config');
const { db, abfragen } = require('../src/db');
const scheduler = require('../src/scheduler');
const sessionen = require('../src/sessionen');
const einstellungen = require('../src/einstellungen');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + zusatz : ''));
}

const schlaf = ms => new Promise(r => setTimeout(r, ms));

/** Planung von vorn. Sonst erbt die neue Zeile den Start der alten. */
function frischerPlan (vonMin, bisMin) {
  db.prepare('DELETE FROM sessionen').run();
  sessionen.vergessen();
  sessionen.speichern([{
    geplantStart: sessionen.alsUhrzeit(vonMin), geplantEnde: sessionen.alsUhrzeit(bisMin)
  }]);
}
const belegt = () => scheduler.anzeige().filter(f => f.text).length;

/** Mehrere Takte mit Abstand — der Scheduler drosselt Wechsel bewusst. */
async function takte (n = 4) {
  for (let i = 0; i < n; i++) { scheduler.takt(); await schlaf(420); }
}

function ortsminute () {
  const g = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.ZEITZONE, hour12: false, hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  return Number(g.find(t => t.type === 'hour').value) % 24 * 60
       + Number(g.find(t => t.type === 'minute').value);
}

for (let i = 0; i < 40; i++) {
  abfragen.einfuegen.run({
    text: 'Probebotschaft ' + i, name: null, status: 'freigegeben', filter: null,
    token: 'probe-' + i, geraet: 'g' + i,
    erstellt_am: Date.now() - (100 - i), entschieden_am: Date.now(), unsicher: 0
  });
}

(async () => {
  console.log('\nOhne Plan laeuft alles wie vorher');
  {
    pruefe('kein Plan eingetragen', sessionen.geplant() === false);
    pruefe('Phase heisst ohnePlan', sessionen.stand().phase === 'ohnePlan', sessionen.stand().phase);
    pruefe('Nachschub ist frei', scheduler.nachladenErlaubt() === true);
    await takte(3);
    pruefe('die Fassade fuellt sich', belegt() > 0, belegt());
  }

  console.log('\nMit Plan, aber nicht gestartet: kein Nachschub');
  {
    scheduler.alleEntfernen();
    const jetzt = ortsminute();
    frischerPlan(Math.min(1400, jetzt + 60), Math.min(1420, jetzt + 77));
    pruefe('Phase heisst jetzt pause', sessionen.stand().phase === 'pause', sessionen.stand().phase);
    pruefe('Nachschub ist zu', scheduler.nachladenErlaubt() === false);
    await takte(4);
    pruefe('die Fassade bleibt leer', belegt() === 0, belegt());
  }

  console.log('\nGestartet: es geht wieder los');
  {
    const jetzt = ortsminute();
    frischerPlan(jetzt, Math.min(1439, jetzt + 17));
    sessionen.starten();
    pruefe('Phase laeuft', sessionen.stand().phase === 'laeuft', sessionen.stand().phase);
    pruefe('Nachschub ist offen', scheduler.nachladenErlaubt() === true);
    await takte(3);
    pruefe('die Fassade fuellt sich', belegt() > 0, belegt());
  }

  console.log('\nLetzte Standzeit vor Schluss: nichts Neues mehr, Laufendes bleibt');
  {
    const vorher = belegt();
    pruefe('es steht etwas an der Wand', vorher > 0, vorher);
    // Ende auf gleich stellen: wir sind mitten im Auslaufen.
    const l = sessionen.laufende();
    db.prepare('UPDATE sessionen SET ende = ? WHERE id = ?').run(Date.now() + 8000, l.id);
    sessionen.vergessen();
    pruefe('Phase laeuftAus', sessionen.stand().phase === 'laeuftAus', sessionen.stand().phase);
    pruefe('Nachschub ist zu', scheduler.nachladenErlaubt() === false);
    await takte(3);
    pruefe('nichts ist dazugekommen', belegt() <= vorher, belegt() + ' war ' + vorher);
    pruefe('das Laufende steht noch', belegt() > 0, belegt());
  }

  console.log('\nNach dem Ende: leere Flaechen bleiben leer');
  {
    const l = sessionen.laufende() || db.prepare('SELECT * FROM sessionen ORDER BY nr DESC LIMIT 1').get();
    db.prepare('UPDATE sessionen SET ende = ? WHERE id = ?').run(Date.now() - 1000, l.id);
    sessionen.vergessen();
    scheduler.alleEntfernen();
    pruefe('Phase ist pause', sessionen.stand().phase === 'pause', sessionen.stand().phase);
    await takte(4);
    pruefe('die Fassade bleibt leer', belegt() === 0, belegt());
  }

  console.log('\nHandschalter bremst auch bei laufender Session');
  {
    const jetzt = ortsminute();
    frischerPlan(jetzt, Math.min(1439, jetzt + 17));
    sessionen.starten();
    einstellungen.setzen('nachschub', false);
    pruefe('Session laeuft', sessionen.stand().phase === 'laeuft', sessionen.stand().phase);
    pruefe('Nachschub trotzdem zu', scheduler.nachladenErlaubt() === false);
    await takte(4);
    pruefe('die Fassade bleibt leer', belegt() === 0, belegt());

    einstellungen.setzen('nachschub', true);
    pruefe('Schalter zurueck: wieder offen', scheduler.nachladenErlaubt() === true);
    await takte(3);
    pruefe('und es fuellt sich', belegt() > 0, belegt());
  }

  console.log('\nAbbrechen haelt sofort an');
  {
    scheduler.alleEntfernen();
    sessionen.abbrechen();
    pruefe('Nachschub ist zu', scheduler.nachladenErlaubt() === false);
    await takte(4);
    pruefe('die Fassade bleibt leer', belegt() === 0, belegt());
  }

  console.log('\nEine gelaufene Runde wacht durch Umplanen nicht wieder auf');
  {
    const jetzt = ortsminute();
    frischerPlan(jetzt, Math.min(1439, jetzt + 17));
    sessionen.starten();
    // Runde kuenstlich beenden.
    const l = sessionen.laufende();
    db.prepare('UPDATE sessionen SET ende = ? WHERE id = ?').run(Date.now() - 1000, l.id);
    sessionen.vergessen();
    pruefe('Runde ist beendet', sessionen.laufende() === null);

    // Jetzt das Ende in der Planung nach hinten schieben, wie man es abends taete.
    sessionen.speichern([{ geplantStart: sessionen.alsUhrzeit(jetzt), geplantEnde: '23:59' }]);
    pruefe('sie bleibt beendet', sessionen.laufende() === null,
      sessionen.laufende() && sessionen.laufende().ende);
    pruefe('Nachschub bleibt zu', scheduler.nachladenErlaubt() === false);

    scheduler.alleEntfernen();
    await takte(3);
    pruefe('die Fassade bleibt leer', belegt() === 0, belegt());
  }

  console.log('\n' + (fehler ? fehler + ' Fehler' : 'Alles gruen') + '\n');
  process.exit(fehler ? 1 : 0);
})();
