// Filterkette Stufe 1b — semantische Prüfung durch ein Sprachmodell.
//
// Drei Eigenschaften, die wichtiger sind als die Trefferquote:
//
//  1. HARTES ZEITLIMIT. Nach `mistralZeitlimitMs` wird abgebrochen, egal was
//     die Gegenstelle gerade tut. Der Absender wartet auf diese Antwort.
//  2. AUSFALL HEISST QUEUE, NICHT VERWERFEN. Zeitüberschreitung, Fehler,
//     leeres Guthaben, unverständliche Antwort — alles endet in PRUEFEN.
//     Das System degradiert, es fällt nicht aus.
//  3. BEGRENZTE GLEICHZEITIGKEIT. Mehr parallele Aufrufe als das Rate-Limit
//     erlaubt, bringen 429er statt Tempo. Wer keinen Platz bekommt, wartet
//     nicht in der Schlange, sondern geht sofort in die Moderation.
//
// Ohne `MISTRAL_API_KEY` ist diese Stufe stillgelegt und liefert PRUEFEN
// nur dann, wenn sie ausdrücklich aufgerufen wird — siehe `aktiv()`.

const cfg = require('./config');
const RICHTLINIE = require('./richtlinie');

const ENDPUNKT = 'https://api.mistral.ai/v1/chat/completions';

let laufend = 0;
const zaehler = { aufrufe: 0, frei: 0, pruefen: 0, ablehnen: 0, timeout: 0, fehler: 0, ueberlastet: 0, wiederholt: 0, msGesamt: 0 };
// Der letzte Fehlergrund gehoert in die Kennzahlen: am Veranstaltungsabend
// muss ohne Serverzugang erkennbar sein, WARUM die Stufe nicht antwortet -
// abgelaufener Schluessel, leeres Guthaben und Rate-Limit brauchen ganz
// verschiedene Handgriffe. Die Antwort der Gegenstelle wird gekuerzt
// mitgenommen; ein Schluessel steht dort nicht drin.
let letzterFehler = null;

const aktiv = () => Boolean(cfg.mistralSchluessel);

async function bewerten (text, name = '') {
  if (!aktiv()) return { urteil: 'FREI', stufe: '1b', uebersprungen: 'kein Schluessel' };

  if (laufend >= cfg.mistralParallel) {
    zaehler.ueberlastet++;
    return { urteil: 'PRUEFEN', stufe: '1b', grund: 'ueberlastet' };
  }

  const botschaft = name ? `${text} — ${name}` : text;
  const frist = Date.now() + cfg.mistralZeitlimitMs;
  laufend++;
  zaehler.aufrufe++;

  try {
    // Mistral antwortet unter Last mit 503 "please retry" — im Livetest am
    // 01.09. war das jeder zweite Aufruf. Ohne Wiederholung landet die Haelfte
    // aller Botschaften in der Moderationsqueue, und die Moderation erstickt.
    // Wiederholt wird deshalb, aber nur solange das Zeitbudget reicht: die
    // Frist gilt fuer alle Versuche zusammen, nicht je Versuch.
    let letzte = null;
    for (let versuch = 1; versuch <= 3; versuch++) {
      const rest = frist - Date.now();
      if (rest < 600) break;                       // fuer einen Versuch zu wenig

      letzte = await einAufruf(botschaft, rest);
      if (letzte.urteil) return { ...letzte, stufe: '1b', versuche: versuch };
      if (!letzte.nochmal) break;                  // 401, 402: Wiederholen hilft nicht

      zaehler.wiederholt++;
      await new Promise(r => setTimeout(r, 120 + Math.random() * 180));
    }

    if (letzte && letzte.timeout) zaehler.timeout++; else zaehler.fehler++;
    if (letzte && !letzte.timeout) letzterFehler = { zeit: Date.now(), grund: letzte.grund, antwort: letzte.antwort };
    return { urteil: 'PRUEFEN', stufe: '1b', grund: letzte ? letzte.grund : 'kein Versuch mehr moeglich' };
  } finally {
    laufend--;
  }
}

// Ein einzelner Aufruf. Liefert entweder ein Urteil oder einen Fehler mit der
// Angabe, ob ein weiterer Versuch ueberhaupt Sinn hat.
async function einAufruf (botschaft, zeitbudgetMs) {
  const abbruch = new AbortController();
  const wecker = setTimeout(() => abbruch.abort(), zeitbudgetMs);
  const start = Date.now();

  try {
    const antwort = await fetch(ENDPUNKT, {
      method: 'POST',
      signal: abbruch.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.mistralSchluessel}`
      },
      body: JSON.stringify({
        model: cfg.mistralModell,
        temperature: 0,
        max_tokens: 4,
        messages: [
          { role: 'system', content: RICHTLINIE },
          { role: 'user', content: botschaft }
        ]
      })
    });

    const ms = Date.now() - start;
    zaehler.msGesamt += ms;

    if (!antwort.ok) {
      const text = await antwort.text().catch(() => '');
      return {
        grund: `http ${antwort.status}`,
        antwort: text.slice(0, 200),
        // 429 und 5xx sind Zustaende, keine Urteile — die gehen vorbei.
        // 401 (Schluessel) und 402 (Guthaben) gehen nicht vorbei.
        nochmal: antwort.status === 429 || antwort.status >= 500,
        ms
      };
    }

    const daten = await antwort.json();
    const wort = String(daten?.choices?.[0]?.message?.content ?? '')
      .toUpperCase().replace(/[^A-Z]/g, '');

    if (wort.startsWith('FREI')) { zaehler.frei++; return { urteil: 'FREI', ms }; }
    if (wort.startsWith('ABLEHNEN')) { zaehler.ablehnen++; return { urteil: 'ABLEHNEN', ms }; }
    if (wort.startsWith('PRUEFEN')) { zaehler.pruefen++; return { urteil: 'PRUEFEN', ms }; }

    // Unverstaendliche Antwort ist kein Freibrief — aber auch kein Grund,
    // es noch einmal zu versuchen: bei temperature 0 kaeme dasselbe zurueck.
    return { grund: 'unklare Antwort', antwort: wort.slice(0, 40), nochmal: false, ms };
  } catch (e) {
    const ms = Date.now() - start;
    zaehler.msGesamt += ms;
    const timeout = e.name === 'AbortError';
    return { grund: timeout ? 'zeitlimit' : String(e.message).slice(0, 60), timeout, nochmal: !timeout, ms };
  } finally {
    clearTimeout(wecker);
  }
}

const kennzahlen = () => ({
  ...zaehler,
  letzterFehler,
  laufend,
  msSchnitt: zaehler.aufrufe ? Math.round(zaehler.msGesamt / zaehler.aufrufe) : null
});

module.exports = { bewerten, aktiv, kennzahlen };
