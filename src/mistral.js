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
const zaehler = { aufrufe: 0, frei: 0, pruefen: 0, ablehnen: 0, timeout: 0, fehler: 0, ueberlastet: 0, msGesamt: 0 };

const aktiv = () => Boolean(cfg.mistralSchluessel);

async function bewerten (text, name = '') {
  if (!aktiv()) return { urteil: 'FREI', stufe: '1b', uebersprungen: 'kein Schluessel' };

  if (laufend >= cfg.mistralParallel) {
    zaehler.ueberlastet++;
    return { urteil: 'PRUEFEN', stufe: '1b', grund: 'ueberlastet' };
  }

  const botschaft = name ? `${text} — ${name}` : text;
  const abbruch = new AbortController();
  const wecker = setTimeout(() => abbruch.abort(), cfg.mistralZeitlimitMs);
  const start = Date.now();
  laufend++;
  zaehler.aufrufe++;

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
      zaehler.fehler++;
      return { urteil: 'PRUEFEN', stufe: '1b', grund: `http ${antwort.status}`, ms };
    }

    const daten = await antwort.json();
    const wort = String(daten?.choices?.[0]?.message?.content ?? '')
      .toUpperCase().replace(/[^A-Z]/g, '');

    if (wort.startsWith('FREI')) { zaehler.frei++; return { urteil: 'FREI', stufe: '1b', ms }; }
    if (wort.startsWith('ABLEHNEN')) { zaehler.ablehnen++; return { urteil: 'ABLEHNEN', stufe: '1b', ms }; }
    if (wort.startsWith('PRUEFEN')) { zaehler.pruefen++; return { urteil: 'PRUEFEN', stufe: '1b', ms }; }

    // Unverständliche Antwort ist kein Freibrief.
    zaehler.fehler++;
    return { urteil: 'PRUEFEN', stufe: '1b', grund: 'unklare Antwort: ' + wort.slice(0, 20), ms };
  } catch (e) {
    const ms = Date.now() - start;
    const timeout = e.name === 'AbortError';
    timeout ? zaehler.timeout++ : zaehler.fehler++;
    return { urteil: 'PRUEFEN', stufe: '1b', grund: timeout ? 'zeitlimit' : String(e.message).slice(0, 60), ms };
  } finally {
    clearTimeout(wecker);
    laufend--;
  }
}

const kennzahlen = () => ({
  ...zaehler,
  laufend,
  msSchnitt: zaehler.aufrufe ? Math.round(zaehler.msGesamt / zaehler.aufrufe) : null
});

module.exports = { bewerten, aktiv, kennzahlen };
