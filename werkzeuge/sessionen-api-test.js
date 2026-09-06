// Test der Spielzeiten ueber die Schnittstelle.  node werkzeuge/sessionen-api-test.js
//
// Geprueft wird vor allem der Zugangsschutz: der Plan des Abends und erst
// recht der Startknopf duerfen nicht offen im Netz liegen. Der schlanke
// Sessionstand in /api/kennzahlen dagegen schon — die Statusseite braucht ihn
// und sie kennt kein Kennwort.

const fs = require('fs');

process.env.DB_PFAD = '/tmp/sessionen-api-test.db';
process.env.ZEITZONE = 'Europe/Berlin';
process.env.STANDZEIT = '25';
process.env.MODERATION_KENNWORT = 'probe-kennwort-2026';
process.env.MISTRAL_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
for (const e of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PFAD + e, { force: true });

const { fastify } = require('../src/server');
const s = require('../src/sessionen');

let fehler = 0;
function pruefe (name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok   ' + name); return; }
  fehler++;
  console.log('  FEHL ' + name + (zusatz ? '   -> ' + JSON.stringify(zusatz) : ''));
}

let keks = null;
const ruf = (url, payload) => fastify.inject({
  method: payload ? 'POST' : 'GET', url, payload,
  headers: keks ? { cookie: keks } : {}
});

/** Ortsminute des Tages — nicht getHours(), der Testrechner steht auf UTC. */
function jetztOrtsminute () {
  const g = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.ZEITZONE, hour12: false, hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  return Number(g.find(t => t.type === 'hour').value) % 24 * 60
       + Number(g.find(t => t.type === 'minute').value);
}

(async () => {
  console.log('\nOhne Anmeldung ist alles zu');
  for (const [pfad, nutzlast] of [
    ['/api/moderation/sessionen', null],
    ['/api/moderation/sessionen', { zeilen: [] }],
    ['/api/moderation/session-starten', {}],
    ['/api/moderation/session-abbrechen', {}]
  ]) {
    const a = await ruf(pfad, nutzlast);
    pruefe(`${nutzlast ? 'POST' : 'GET '} ${pfad} gibt 401`, a.statusCode === 401, a.statusCode);
  }

  const an = await fastify.inject({
    method: 'POST', url: '/api/moderation/anmelden',
    payload: { kennwort: 'probe-kennwort-2026' }
  });
  keks = an.headers['set-cookie'];
  keks = Array.isArray(keks) ? keks[0] : keks;
  pruefe('Anmeldung klappt', an.statusCode === 200, an.statusCode);

  console.log('\nPlan speichern und lesen');
  {
    const a = await ruf('/api/moderation/sessionen', {
      zeilen: [
        { geplantStart: '19:12', geplantEnde: '19:29' },
        { geplantStart: '19:42', geplantEnde: '19:59' }
      ]
    });
    pruefe('Speichern gibt 200', a.statusCode === 200, a.statusCode);
    const st = a.json();
    pruefe('zwei Zeilen zurueck', st.zeilen.length === 2, st.zeilen.length);
    pruefe('Uhrzeit lesbar', st.zeilen[1].geplantEnde === '19:59', st.zeilen[1].geplantEnde);

    const b = await ruf('/api/moderation/sessionen');
    pruefe('Lesen gibt denselben Plan', b.json().zeilen.length === 2);
  }

  console.log('\nFehlerhafte Eingaben');
  {
    const a = await ruf('/api/moderation/sessionen', { zeilen: [{ geplantStart: 'gleich', geplantEnde: '19:29' }] });
    pruefe('Unsinn als Uhrzeit gibt 400', a.statusCode === 400, a.statusCode);
    pruefe('mit lesbarem Grund', /HH:MM/.test(a.json().fehler || ''), a.json());

    const b = await ruf('/api/moderation/sessionen', { zeilen: [{ geplantStart: '19:40', geplantEnde: '19:20' }] });
    pruefe('Ende vor Anfang gibt 400', b.statusCode === 400, b.statusCode);

    const c = await ruf('/api/moderation/sessionen', {});
    pruefe('fehlende Zeilen geben 400', c.statusCode === 400, c.statusCode);

    const d = await ruf('/api/moderation/sessionen');
    pruefe('der gute Plan steht noch', d.json().zeilen.length === 2, d.json().zeilen.length);
  }

  console.log('\nStarten und abbrechen');
  {
    const jetzt = jetztOrtsminute();
    await ruf('/api/moderation/sessionen', {
      zeilen: [{ geplantStart: s.alsUhrzeit(jetzt), geplantEnde: s.alsUhrzeit(Math.min(1439, jetzt + 17)) }]
    });

    const a = await ruf('/api/moderation/session-starten', {});
    pruefe('Start gibt 200', a.statusCode === 200, a.statusCode);
    pruefe('Phase laeuft', a.json().phase === 'laeuft', a.json().phase);
    pruefe('Nachschub offen', a.json().nachschubErlaubt === true);

    const b = await ruf('/api/moderation/session-starten', {});
    pruefe('zweiter Start gibt 409', b.statusCode === 409, b.statusCode);

    const c = await ruf('/api/moderation/session-abbrechen', {});
    pruefe('Abbruch gibt 200', c.statusCode === 200, c.statusCode);
    pruefe('danach Pause', c.json().phase === 'pause', c.json().phase);

    const d = await ruf('/api/moderation/session-abbrechen', {});
    pruefe('Abbruch ohne Runde gibt 409', d.statusCode === 409, d.statusCode);
  }

  console.log('\nOeffentliche Kennzahlen');
  {
    keks = null;                                   // bewusst abgemeldet
    const a = await ruf('/api/kennzahlen');
    pruefe('Kennzahlen sind offen', a.statusCode === 200, a.statusCode);
    const k = a.json();
    pruefe('Sessionstand ist dabei', Boolean(k.session), k.session);
    pruefe('Phase ist enthalten', typeof k.session.phase === 'string', k.session);
    pruefe('Anzahl geplanter Runden ist dabei', k.session.geplant === 1, k.session.geplant);
    pruefe('der Plan selbst NICHT', k.session.zeilen === undefined, Object.keys(k.session));
  }

  await fastify.close();
  console.log('\n' + (fehler ? fehler + ' Fehler' : 'Alles gruen') + '\n');
  process.exit(fehler ? 1 : 0);
})();
