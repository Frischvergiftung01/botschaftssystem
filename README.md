# Botschaftssystem — Königsbau 2026

Publikumsbotschaften auf der Fassade des Königsbaus, Lange Nacht am **7. November 2026**.
Dieses Repository ist **Block 2** aus dem Umsetzungsplan: der Durchstich vom Handy bis auf die Fläche.

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

## Starten

```bash
npm install
npm run seed     # ein paar Beispielbotschaften, damit etwas zu sehen ist
npm start        # http://localhost:3000
npm test         # Durchstich-Test: Absenden -> Fläche -> Status
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
src/db.js          SQLite-Schema
src/config.js      alle Stellschrauben, per Umgebungsvariable überschreibbar
public/            die drei Seiten, ohne Framework und ohne Build
werkzeuge/         Seed, Durchstich-Test und Filter-Test
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

## Was als Nächstes drankommt

- **Block 5:** Moderationsoberfläche — solange sie fehlt, bleibt alles mit `PRUEFEN` liegen
- **Block 5:** Moderationsoberfläche und die feine Scheduler-Logik
- **Block 6:** Bridge auf dem Medien-PC — der Simulator wird gegen Arena getauscht, beide bleiben
  umschaltbar

## Schrift

Oswald liegt unter `public/schrift/` lokal bei (SIL Open Font License, siehe Lizenzdatei) — die
Seite kommt damit ohne fremde Server aus. Das ist auf einem überlasteten Platznetz kein
Schönheitsfehler, sondern der Unterschied zwischen „lädt" und „lädt nicht".
