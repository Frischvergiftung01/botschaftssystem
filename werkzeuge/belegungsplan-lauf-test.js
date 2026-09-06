// Der Belegungsplan im laufenden Scheduler.
//   node werkzeuge/belegungsplan-lauf-test.js
//
// Die eine Frage, um die es hier geht: HAELT DER PLAN, WAS ER VERSPRICHT?
// Auf dieser Zusage steht die Auskunft an den Absender — "in zwei Minuten,
// rechter Fluegel, dritte Saeule". Wenn die Fassade sich nicht daran haelt,
// ist die Ansage schlimmer als gar keine.
//
// Dazu die Rueckfallebene: der Plan ist eine Vorschaltung. Faellt er aus,
// abgeschaltet oder ungueltig geworden, muss der Scheduler weitermachen wie
// vor dem Umbau. Ein Fehler soll zur alten Funktion degradieren, nicht zu
// einer dunklen Wand.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/belegungsplan-lauf-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
// Standzeit kurz, damit viele Wechsel in kurzer Zeit passieren — aber nicht
// so kurz, dass die Drosselung des Schedulers zum Engpass wird: 33 Flaechen
// bei 10 s Standzeit sind 3,3 Wechsel je Sekunde, erlaubt sind 5.
process.env.STANDZEIT = '10';
process.env.PLAN_HORIZONT = '30';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const cfg = require('../src/config');
const { abfragen } = require('../src/db');
const scheduler = require('../src/scheduler');
const einstellungen = require('../src/einstellungen');
const hinweise = require('../src/hinweise');
const moderation = require('../src/moderation');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + JSON.stringify(zusatz) : ''));
}

const schlaf = ms => new Promise(r => setTimeout(r, ms));
const belegt = () => scheduler.anzeige().filter(f => f.text).length;

function botschaftenAnlegen (n) {
  for (let i = 0; i < n; i++) {
    abfragen.einfuegen.run({
      text: 'Probebotschaft ' + i, name: null, status: 'freigegeben', filter: null,
      token: 'probe-' + i, geraet: 'g' + i,
      erstellt_am: Date.now() - (1000 - i), entschieden_am: Date.now(), unsicher: 0
    });
  }
}

/**
 * Laesst den Scheduler laufen und schreibt mit, was tatsaechlich auf welcher
 * Flaeche landet — inklusive dessen, was der Plan davor versprochen hatte.
 */
async function laufen (sekunden) {
  const wirklich = [];
  const ende = Date.now() + sekunden * 1000;
  const vorher = new Map();  // flaeche -> zuletzt gesehene botschaftId
  for (const f of scheduler.zustand.values()) vorher.set(f.nr, f.botschaftId);

  while (Date.now() < ende) {
    // Was verspricht der Plan gerade fuer jede Flaeche?
    const plan = scheduler.derPlan();
    const zusage = new Map();
    if (plan) {
      for (const e of plan.eintraege) {
        const bisher = zusage.get(e.flaeche);
        if (!bisher || e.start < bisher.start) zusage.set(e.flaeche, e);
      }
    }
    scheduler.takt();
    for (const f of scheduler.zustand.values()) {
      const alt = vorher.get(f.nr);
      const neu = f.hinweisId !== null ? 'h' + f.hinweisId : f.botschaftId;
      if (neu === alt || neu === null) continue;
      const z = zusage.get(f.nr);
      wirklich.push({
        flaeche: f.nr,
        bekommen: neu,
        versprochen: z ? (z.hinweisId !== null ? 'h' + z.hinweisId : z.botschaftId) : null
      });
      vorher.set(f.nr, neu);
    }
    await schlaf(60);
  }
  return wirklich;
}

(async () => {
  botschaftenAnlegen(200);

  console.log('\nDer Plan wird gebaut, sobald es losgeht');
  {
    scheduler.takt();
    const p = scheduler.derPlan();
    pruefe('es gibt einen Plan', Boolean(p));
    pruefe('er ist gefuellt', p.eintraege.length > 30, p && p.eintraege.length);
    pruefe('er bucht in die Zukunft', p.eintraege.every(e => e.ende > Date.now()));
    pruefe('jede Buchung nennt ihren Ort', p.eintraege.every(e => e.flaecheName && e.gruppe));
  }

  console.log('\nDie Fassade haelt sich an den Plan');
  {
    const wirklich = await laufen(20);
    pruefe('es ist ordentlich etwas passiert', wirklich.length > 40, wirklich.length);
    const mitZusage = wirklich.filter(w => w.versprochen !== null);
    pruefe('alles war vorher gebucht',
      mitZusage.length === wirklich.length, mitZusage.length + ' von ' + wirklich.length);
    const gebrochen = mitZusage.filter(w => w.bekommen !== w.versprochen);
    pruefe('und jede Zusage wurde eingehalten', gebrochen.length === 0,
      gebrochen.slice(0, 5));
  }

  console.log('\nEine abgelehnte Botschaft verschwindet aus dem Plan');
  {
    const plan = scheduler.derPlan();
    const kandidat = plan.eintraege.find(e => e.botschaftId !== null);
    pruefe('es gibt eine gebuchte Botschaft', Boolean(kandidat));
    const id = kandidat.botschaftId;
    moderation.entscheiden([id], 'sperren');
    pruefe('sie ist aus dem Plan gestrichen',
      scheduler.derPlan().eintraege.every(e => e.botschaftId !== id));
    pruefe('die uebrigen Buchungen stehen noch', scheduler.derPlan().eintraege.length > 20,
      scheduler.derPlan().eintraege.length);
    await laufen(6);
    pruefe('sie taucht auch an der Fassade nicht auf',
      scheduler.anzeige().every(f => !f.text || f.text !== 'Probebotschaft ' + (id - 1)));
    pruefe('und die Fassade laeuft weiter', belegt() > 20, belegt());
  }

  console.log('\nOhne Plan laeuft alles wie vor dem Umbau');
  {
    einstellungen.setzen('belegungsplan', false);
    scheduler.takt();
    pruefe('der Plan ist weg', scheduler.derPlan() === null);
    const wirklich = await laufen(12);
    pruefe('die Fassade wechselt trotzdem', wirklich.length > 20, wirklich.length);
    pruefe('sie ist gut belegt', belegt() > 25, belegt());
    pruefe('nichts war gebucht', wirklich.every(w => w.versprochen === null));

    einstellungen.setzen('belegungsplan', true);
    scheduler.takt();
    pruefe('nach dem Wiedereinschalten gibt es wieder einen Plan',
      Boolean(scheduler.derPlan()) && scheduler.derPlan().eintraege.length > 20,
      scheduler.derPlan() && scheduler.derPlan().eintraege.length);
  }

  console.log('\nHinweise vom Platz werden mitgebucht');
  {
    hinweise.speichern([{ text: 'Letzte Runde um 22:30' }]);
    hinweise.scharfSetzen(1, true);
    scheduler.planFlaecheLeeren(cfg.hinweisFlaeche);
    // Nachziehen ist gedrosselt; einen Augenblick geben.
    await schlaf(1100);
    scheduler.takt();
    const aufMitte = scheduler.derPlan().eintraege.filter(e => e.flaeche === cfg.hinweisFlaeche);
    pruefe('die Stirnseite Mitte ist fuer den Hinweis gebucht',
      aufMitte.length > 0 && aufMitte.every(e => e.hinweisId !== null),
      aufMitte.map(e => e.hinweisId));
    await laufen(12);
    const f = scheduler.zustand.get(cfg.hinweisFlaeche);
    pruefe('und er steht auch dort', f.hinweisId !== null && f.text === 'Letzte Runde um 22:30', f.text);

    hinweise.scharfSetzen(1, false);
    scheduler.planFlaecheLeeren(cfg.hinweisFlaeche);
    await laufen(14);
    const g = scheduler.zustand.get(cfg.hinweisFlaeche);
    pruefe('nach dem Herausnehmen wieder eine Botschaft', g.hinweisId === null && Boolean(g.text), g.text);
  }

  console.log('\nEine veraltete Buchung wird verbraucht, nicht wiederholt');
  {
    // Buchung von Hand auf eine Botschaft biegen, die es nicht mehr gibt.
    const plan = scheduler.derPlan();
    const f = scheduler.zustand.get(9);
    plan.eintraege = plan.eintraege.filter(e => e.flaeche !== 9);
    plan.eintraege.push({
      flaeche: 9, flaecheName: 'x', gruppe: 'x', start: Date.now(), ende: Date.now() + 2000,
      botschaftId: 999999, hinweisId: null, text: 'gibt es nicht',
      groesse: { versalhoehe: 30, schrifthoehe: 30, yVersatz: 0 }
    });
    f.ende = Date.now() - 1;
    // Der Scheduler wechselt nur eine Flaeche je Takt — also ein paar Takte
    // geben, bis Flaeche 9 an der Reihe war.
    await laufen(4);
    pruefe('die tote Buchung ist verbraucht',
      scheduler.derPlan().eintraege.every(e => e.botschaftId !== 999999));
    pruefe('die Flaeche hat trotzdem etwas bekommen', Boolean(scheduler.zustand.get(9).text),
      scheduler.zustand.get(9).text);
  }

  console.log('\nRuecknahme aller Botschaften laesst den Plan nicht zurueck');
  {
    scheduler.alleEntfernen();
    pruefe('der Plan ist verworfen', scheduler.derPlan() === null);
    scheduler.takt();
    pruefe('und wird sofort neu aufgebaut', Boolean(scheduler.derPlan()));
  }

  console.log('\n' + (fehler ? fehler + ' Fehler' : 'Alles gruen') + '\n');
  process.exit(fehler ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
