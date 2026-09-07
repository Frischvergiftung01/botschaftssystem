// Prueft, dass ein wiederholter Absendeversuch nicht doppelt ankommt.
//   node werkzeuge/wiederholung-test.js
//
// Der Fall, den niemand sieht: die Botschaft erreicht den Server, die Antwort
// geht auf dem Rueckweg verloren. Frueher bekam der Absender daraufhin die
// Geraetesperre zu sehen ("in 118 Sekunden geht die naechste"), waehrend seine
// Botschaft laengst an der Wand stand — und im schlechteren Fall stand sie
// zweimal da.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/wiederholung-test.db';
process.env.STANDZEIT = '25';
process.env.SPERRE_SEKUNDEN = '120';
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { db } = require('../src/db');
const sendungen = require('../src/sendungen');
const { fastify } = require('../src/server');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz !== undefined ? '   -> ' + zusatz : ''));
}
const zaehlen = () => db.prepare('SELECT count(*) n FROM botschaften').get().n;
const senden = (payload) => fastify.inject({ method: 'POST', url: '/api/botschaft', payload });

(async () => {
  console.log('\nDerselbe Versuch zweimal');
  {
    const eins = await senden({ text: 'Grüße vom Schlossplatz', name: '', geraet: 'g1', sendung: 'versuch-0001-aaaaaaaa' });
    pruefe('der erste geht durch', eins.statusCode === 200, eins.statusCode);
    const token = eins.json().token;
    const nachEinem = zaehlen();

    const zwei = await senden({ text: 'Grüße vom Schlossplatz', name: '', geraet: 'g1', sendung: 'versuch-0001-aaaaaaaa' });
    pruefe('der zweite wird nicht abgewiesen', zwei.statusCode === 200, zwei.statusCode);
    pruefe('und liefert denselben Token', zwei.json().token === token, zwei.json().token);
    pruefe('er ist als Wiederholung gekennzeichnet', zwei.json().wiederholt === true);
    pruefe('es gibt weiterhin nur eine Botschaft', zaehlen() === nachEinem, zaehlen());
  }

  console.log('\nEin neuer Versuch vom selben Geraet laeuft in die Sperre');
  {
    const vorher = zaehlen();
    const drei = await senden({ text: 'Und noch eine', name: '', geraet: 'g1', sendung: 'versuch-0002-bbbbbbbb' });
    pruefe('die Geraetesperre greift weiterhin', drei.statusCode === 429, drei.statusCode);
    pruefe('und legt nichts an', zaehlen() === vorher, zaehlen());
  }

  console.log('\nAuch eine Ablehnung wird nur einmal protokolliert');
  {
    const vorher = zaehlen();
    const eins = await senden({ text: 'Schreib mir: post@example.de', name: '', geraet: 'g2', sendung: 'versuch-0003-cccccccc' });
    pruefe('sie wird abgelehnt', eins.statusCode === 422, eins.statusCode);
    const nachEinem = zaehlen();
    pruefe('und steht im Protokoll', nachEinem === vorher + 1, nachEinem);

    const zwei = await senden({ text: 'Schreib mir: post@example.de', name: '', geraet: 'g2', sendung: 'versuch-0003-cccccccc' });
    pruefe('die Wiederholung sagt dasselbe', zwei.statusCode === 422, zwei.statusCode);
    pruefe('ohne ein zweites Mal zu protokollieren', zaehlen() === nachEinem, zaehlen());
  }

  console.log('\nOhne Kennung bleibt alles wie vorher');
  {
    const vorher = zaehlen();
    const ohne = await senden({ text: 'Ganz ohne Kennung', name: '', geraet: 'g3' });
    pruefe('sie geht durch', ohne.statusCode === 200, ohne.statusCode);
    pruefe('und legt an', zaehlen() === vorher + 1, zaehlen());
    const zweimal = await senden({ text: 'Ganz ohne Kennung', name: '', geraet: 'g4' });
    pruefe('zwei Versuche ohne Kennung sind zwei Botschaften',
      zweimal.statusCode === 200 && zaehlen() === vorher + 2, zaehlen());
  }

  console.log('\nDie Kennungen leben nur im Arbeitsspeicher');
  {
    pruefe('sie stehen in keiner Tabelle',
      !db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%sendung%'").get());
    pruefe('gemerkt sind sie trotzdem', sendungen.anzahl() > 0, sendungen.anzahl());
    sendungen.vergessen();
    pruefe('und nach einem Neustart weg', sendungen.anzahl() === 0);
    // Danach verhaelt sich alles wie frueher: derselbe Versuch waere eine neue
    // Botschaft — abgefangen nur noch von der Geraetesperre.
    const wieder = await senden({ text: 'Grüße vom Schlossplatz', name: '', geraet: 'g1', sendung: 'versuch-0001-aaaaaaaa' });
    pruefe('der alte Versuch laeuft dann in die Sperre', wieder.statusCode === 429, wieder.statusCode);
  }

  await fastify.close();
  console.log(fehler ? `\n${fehler} Fehler\n` : '\nAlles gruen\n');
  process.exit(fehler ? 1 : 0);
})();
