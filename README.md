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
src/db.js          SQLite-Schema
src/config.js      alle Stellschrauben, per Umgebungsvariable überschreibbar
public/            die drei Seiten, ohne Framework und ohne Build
werkzeuge/         Seed und Durchstich-Test
```

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

- **Block 3:** Repository auf GitHub, Coolify-Projekt, Subdomain — dann ist jeder Zwischenstand
  unter einer echten Adresse anschaubar
- **Block 4:** Filterkette (Wortliste mit Normalisierung, dann Mistral). Solange sie fehlt, steht
  `AUTO_FREIGABE=true` und jede Botschaft geht direkt in die Anzeige
- **Block 5:** Moderationsoberfläche und die feine Scheduler-Logik
- **Block 6:** Bridge auf dem Medien-PC — der Simulator wird gegen Arena getauscht, beide bleiben
  umschaltbar

## Schrift

Oswald liegt unter `public/schrift/` lokal bei (SIL Open Font License, siehe Lizenzdatei) — die
Seite kommt damit ohne fremde Server aus. Das ist auf einem überlasteten Platznetz kein
Schönheitsfehler, sondern der Unterschied zwischen „lädt" und „lädt nicht".
