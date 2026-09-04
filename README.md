# Botschaftssystem — Königsbau 2026

Publikumsbotschaften auf der Fassade des Königsbaus, Lange Nacht am **7. November 2026**.
Dieses Repository enthält die **Blöcke 2 bis 5** aus dem Umsetzungsplan: den Durchstich vom Handy
bis auf die Fläche, die Filterkette und die Moderation.

## Was schon läuft

Eine vom Handy getippte Botschaft landet über das Backend im Scheduler, wird dort einer der
33 Flächen zugeteilt und erscheint im **Flächen-Simulator** an der richtigen Stelle der Fassade —
in der richtigen Größe, mit derselben Blende wie im Wire-Patch. Die Statusseite sagt dem Absender,
wann und wo.

| Seite | Adresse | wofür |
|---|---|---|
| Eingabe | `/` | Besucher tippen ihre Botschaft, mit Live-Vorschau in Projektionsoptik |
| Status | `/status?t=…` | „noch 12 vor dir" bzw. „jetzt auf Säule Mitte 03" |
| Simulator | `/simulator` | die Fassade im Browser, solange kein Projektor läuft |
| Moderation | `/moderation` | Freigeben, Ablehnen, Zurückstellen — mit Kennwort |

## Starten

```bash
npm install
npm run seed     # ein paar Beispielbotschaften, damit etwas zu sehen ist
npm start        # http://localhost:3000
npm test         # Durchstich, Filterkette und Moderation
npm run queue-fuellen -- 300   # Übungsfutter für die Durchsatzprobe
```

Für die Moderation muss `MODERATION_KENNWORT` gesetzt sein (mindestens 8 Zeichen), sonst bleibt
`/moderation` geschlossen:

```bash
MODERATION_KENNWORT=… npm start
```

Node 20 oder neuer. Ohne weitere Dienste — die Datenbank ist eine Datei unter `data/`.

## Aufbau

```
src/server.js      Fastify: nimmt Botschaften an, liefert Status und Anzeigezustand
src/scheduler.js   teilt Botschaften auf die 33 Flächen zu, versetzter Wechsel
src/text.js        misst Text in echten Schriftmaßen -> größte Größe, die passt
src/flaechen.js    die 33 Flächen: Maße, Lage auf der Canvas, Lage an der Fassade
src/filter.js      Filterkette Stufe 1a: entscheidet FREI / PRUEFEN / ABLEHNEN
src/mistral.js     Stufe 1b: Sprachmodell, hartes Zeitlimit, Ausfall -> Queue
src/richtlinie.js  der Auftrag an das Modell - verdichtete Filterrichtlinie
src/normalisierung.js  glaettet Leetspeak, Sperrschrift, Trennzeichen, Wiederholungen
src/wortliste.js   die drei Raenge hart / weich / Ausnahmen — nicht weitergeben
src/moderation.js  Queue, Sammelentscheidungen, Kennzahlen, Datenbank leeren (Block 5)
src/auth.js        Zugangsschutz der Moderation: ein Kennwort, signiertes Cookie
src/einstellungen.js  Schalter, die im Betrieb umgelegt werden und den Neustart überleben
src/db.js          SQLite-Schema
src/config.js      alle Stellschrauben, per Umgebungsvariable überschreibbar
public/            die Seiten, ohne Framework und ohne Build
werkzeuge/         Seed, Queue-Füller und die drei Tests
```

## Filterkette, Stufe 1a

Grundlage ist `Filterrichtlinie.md` im Konzeptionsordner. `src/filter.js` liefert je Botschaft
`FREI`, `PRUEFEN` oder `ABLEHNEN`:

- **ABLEHNEN** — Adressen, Mail, Telefon, Handles und die harte Wortliste. Der Absender bekommt
  eine freundliche Absage **ohne Grund** (sonst ist die Ablehnung eine Anleitung für den nächsten
  Versuch); die Botschaft wird mitsamt Begründung protokolliert.
- **PRUEFEN** — weiche Wortliste und Spamverdacht. Geht in die Moderationsqueue, auch wenn
  `AUTO_FREIGABE=true` steht.
- **FREI** — geht bei `AUTO_FREIGABE=true` direkt in die Anzeige, später zusätzlich durch Stufe 1b.

Vor dem Abgleich wird normalisiert — Umlaute, ß, Leetspeak, Sperrschrift, Trennzeichen,
Wiederholungen. Die Wortliste läuft durch dieselbe Normalisierung, deshalb darf sie natürlich
geschrieben werden. `npm test` prüft 35 Fälle aus den Beispieltabellen der Richtlinie; wer die
Richtlinie ändert, ändert `werkzeuge/filter-test.js` mit.

Zeichen, die die Schrift nicht kennt (Emoji, fremde Alphabete), werden getrennt abgewiesen —
mit Begründung, denn das ist keine Moderationsfrage, sondern eine Anzeigefrage.

## Filterkette, Stufe 1b

`src/mistral.js` schickt alles, was 1a nicht schon abgelehnt hat, an ein Sprachmodell — mit dem
Prompt aus `src/richtlinie.js`, der verdichteten Fassung der Richtlinie. Es zählt immer das
**strengere** der beiden Urteile: 1b darf verschärfen, freigeben darf nur ein Mensch.

Drei Eigenschaften sind wichtiger als die Trefferquote:

- **Hartes Zeitlimit** (`MISTRAL_ZEITLIMIT_MS`, Vorgabe 3000). Der Absender wartet darauf.
- **Ausfall heißt Queue, nicht verwerfen.** Zeitüberschreitung, Fehler, leeres Guthaben,
  unverständliche Antwort — alles endet in `PRUEFEN`.
- **Begrenzte Gleichzeitigkeit** (`MISTRAL_PARALLEL`). Wer keinen Platz bekommt, wartet nicht,
  sondern geht sofort in die Moderation.
- **Wiederholung bei 429 und 5xx**, bis zu dreimal, aber nur solange das Zeitbudget reicht — die
  Frist gilt für alle Versuche zusammen. Mistral antwortet unter Last mit `503 please retry`; im
  ersten Livetest war das jeder zweite Aufruf. Bei 401 (Schlüssel) und 402 (Guthaben) wird nicht
  wiederholt, das geht nicht vorbei.

`/api/kennzahlen` zeigt unter `stufe1b` die Zähler und den **letzten Fehlergrund samt Antwort der
Gegenstelle**. Das ist die Anzeige für den Veranstaltungsabend: abgelaufener Schlüssel, leeres
Guthaben und Überlast brauchen ganz verschiedene Handgriffe.

Ohne `MISTRAL_API_KEY` ist die Stufe stillgelegt und die Kette endet nach 1a.

`npm run messung` fährt Latenz, Rate-Limit und Trefferquote gegen das echte Konto und schlägt
Werte für `MISTRAL_PARALLEL` und `MISTRAL_ZEITLIMIT_MS` vor. Die 20 Fälle dort sind solche, an
denen 1a blind ist — Ironie, Anspielung, verpackte Politik, vollständige Namen. Was dort danebengeht,
gehört in den Prompt, nicht in die Wortliste.

## Die wichtigste Rechnung: passt der Text auf die Fläche?

Zeichenzählen taugt nicht — `WAHNSINN, WAS FÜR EIN ABEND` läuft über, wo gleich viele
Kleinbuchstaben bequem passen. `src/text.js` misst deshalb mit den echten Maßen der Hausschrift
(Oswald) und begrenzt die Größe an drei Stellen:

1. **Breite der Fläche** — 437 px bei den meisten Säulen
2. **Höhe des Bandes** — 44 px, gemessen an der *tatsächlichen* Ober- und Unterkante der
   Buchstaben. Ein „Ä" ragt bei Oswald bis 1042 Einheiten hoch (Versalhöhe: 810), ein „p" bis
   −190 hinunter. Wer nur die Versalhöhe rechnet, schneidet Umlaute oben und Unterlängen unten ab.
3. **Obergrenze** — der Parameter `Schrifthoehe max` aus dem Wire-Patch

Herausgerechnet werden drei Werte, und genau die drei schickt später die Bridge an Resolume:
Text, `Schrifthoehe` und `Y Versatz`.

**Probe aufs Exempel:** Der Kalibriersatz von 2025 — „Beste Stimmung hier, ich liebe es." —
landet auf einer 437er Säule bei **28,5 px Versalhöhe**. Der Erfahrungswert von der Fassade war
rund 29 px. Der Test in `werkzeuge/durchstich-test.js` prüft das bei jedem Lauf.

## Moderation (Block 5)

Der Engpass des Abends ist nicht die Fassade, sondern dieser Bildschirm: **500 Entscheidungen je
Stunde** muss eine Person schaffen. Die Oberfläche ist darauf gebaut.

- **Einzeln** — eine Botschaft groß in Projektionsoptik, drei Knöpfe, Auto-Advance.
  Tasten: `1`/`F` freigeben, `2`/`A` ablehnen, `3`/`Z` zurückstellen, `U` rückgängig.
  Grenzfälle des Filters stehen vorn und sind rot umrandet, mit dem Grund daneben.
- **Raster** — zwölf unauffällige Botschaften auf einmal, Anklicken nimmt eine heraus,
  ein Knopf gibt die übrigen frei. Das ist der Durchsatzhebel.
- **Auf der Fassade** — was gerade läuft, mit `Sperren`: die Botschaft verschwindet **sofort**
  von der Fläche, nicht erst nach Ablauf der Standzeit.
- **Schalter im Kopf** — `Auto-Freigabe` (saubere Botschaften ohne Moderation durchlassen) und
  `Nachschub` (Zuteilung anhalten, Laufendes läuft aus). Beide stehen in der Datenbank und
  überleben einen Neustart.

**Der Not-Aus liegt nicht hier, sondern in Resolume:** die MESSAGES-Ebenen ausschalten. Das ist der
einzige Weg, der auch dann noch wirkt, wenn Netz, Bridge oder dieser Dienst hängen.

Zugang: ein gemeinsames Kennwort aus `MODERATION_KENNWORT`, danach ein signiertes Cookie
(`MODERATION_SITZUNG_STUNDEN`, Vorgabe 14). Wird das Kennwort gewechselt, sind alle Sitzungen sofort
ungültig. Ohne Kennwort bleibt die Oberfläche zu — auch unter `/moderation.html`.

**Durchsatzprobe:** `npm run queue-fuellen -- 300`, dann `/moderation` öffnen und die Stoppuhr
laufen lassen. Der Kopf zeigt „letzte 5 min" und die Hochrechnung auf die Stunde.

## Was als Nächstes drankommt

- **Block 6:** Bridge auf dem Medien-PC — der Simulator wird gegen Arena getauscht, beide bleiben
  umschaltbar
- **Block 7:** Ausbau — Statusseite mit Fassadenplan, Monitoring, Seed-Pool
- **Block 8:** Härtung — Lasttest, Red-Team, Vollprobe

## Schrift

Oswald liegt unter `public/schrift/` lokal bei (SIL Open Font License, siehe Lizenzdatei) — die
Seite kommt damit ohne fremde Server aus. Das ist auf einem überlasteten Platznetz kein
Schönheitsfehler, sondern der Unterschied zwischen „lädt" und „lädt nicht".
