# Botschaften-Bridge — Medien-PC

Dieser Ordner ist alles, was auf dem Medien-PC gebraucht wird. Er hängt an nichts:
kein Netzlaufwerk, keine Installation, keine Zusatzpakete. **Ordner kopieren, wohin er
soll** — Desktop, Projektordner, egal — und `start-bridge.cmd` doppelklicken.

Gebraucht wird nur **Node.js** auf dem Rechner (LTS von nodejs.org). Fehlt es, sagt das
Startskript das beim ersten Versuch.

---

## Was die Bridge tut

Sie fragt den Server zweimal je Sekunde, was auf den 33 Flächen stehen soll, und schreibt
die Unterschiede nach Resolume Arena. Ein Wechsel sind drei Handgriffe: Blende auf 0,
350 ms warten, Text tauschen, Blende auf 1.

Der Server ist dabei passiv — er weiß nichts von Arena und ruft hier nie an. Die Bridge
holt. Bricht die Verbindung ab, **bleibt auf der Wand stehen, was steht**. Leeren kann nur
der Server, nie ein Fehler.

## Vor dem ersten Start

1. In Arena: **Preferences → Webserver → „Enable Webserver & REST API"** anhaken, Port 8080.
   Ohne das findet die Bridge Arena nicht.
2. Der Clip mit dem Patch *FVG Message Wall v2* muss in der Komposition liegen. Getriggert
   sein muss er **nicht** — siehe unten.
3. `einstellungen.json` prüfen. Sie entsteht beim ersten Start aus der Vorlage:

   | Eintrag | Bedeutung |
   |---|---|
   | `server` | Adresse des Botschaftssystems. Normalfall `https://botschaft.frischvergiftung.de` |
   | `arena` | Arena auf demselben Rechner: `http://127.0.0.1:8080/api/v1` |
   | `taktMs` | wie oft der Server gefragt wird (500 = zweimal je Sekunde) |
   | `blendeMs` | Blendenzeit; **muss zum Smooth-Knoten im Patch passen** (0,35 s) |
   | `token` | nur nötig, wenn am Server `BRIDGE_TOKEN` gesetzt ist — derselbe Wert |

## Im Betrieb

Das Fenster **offen lassen** — es ist die Bridge. Es zeigt jeden Wechsel und alle 30 Sekunden
eine Standzeile. Mitgeschrieben wird zusätzlich nach `logs\bridge-JJJJ-MM-TT.log`.

Alle fünf Sekunden meldet sich die Bridge beim Server. In der Moderation steht dadurch oben
**Fassade verbunden**; bleibt sie aus, sieht man dort sofort, dass es am Medien-PC klemmt.

Stürzt die Bridge ab, startet das Skript sie nach 5 Sekunden neu. Soll sie *aus* bleiben:
Fenster schließen.

**Den Clip entriggern ist erlaubt.** Während der Mapping-Show gehört die Wand der Show; die
Bridge schreibt trotzdem weiter, die Werte bleiben im Clip stehen. Beim nächsten Triggern
steht der aktuelle Stand sofort vollständig da.

**Der Not-Aus liegt nicht hier**, sondern in Resolume: die MESSAGES-Ebene ausschalten. Das
wirkt auch dann, wenn Netz, Bridge oder Server hängen. Die weiche Fassung ist der Schalter
*Nachschub* in der Moderation.

## Was im Log steht

| Zeile | Bedeutung |
|---|---|
| `Arena verbunden — Layer 6 „MESSAGES", Spalte 1 …` | gefunden, und wohin geschrieben wird |
| `Erstabgleich fertig — 7 Flächen belegt` | Anfangsstand einmal komplett hingeschrieben |
| `Fläche 06 ← "…"` | ein Wechsel |
| `Der Clip ist gerade nicht getriggert` | kein Fehler, siehe oben |
| `Server nicht erreichbar … — die Wand behält ihren Stand` | Netz weg; die Bridge probiert weiter |
| `Clip wieder getriggert — der aktuelle Stand wird einmal komplett geschrieben` | Rückkehr aus der Show |
| `Der Clip mit dem Patch läuft nicht mehr — es wird neu gesucht` | nur wenn der Patch mehrfach in der Komposition liegt |

## Wenn etwas klemmt

| Bild | wahrscheinlich | Handgriff |
|---|---|---|
| Fenster meldet `Arena: … /composition …` | Webserver in Arena aus, oder Arena zu | Häkchen setzen, Arena starten |
| Wand ändert sich nicht, Log zählt Wechsel | in Arena liegt der Patch mehrfach, es läuft die falsche Instanz | in der Komposition auf **eine** Instanz aufräumen |
| Log meldet dauernd `Server nicht erreichbar` | Internet weg | Wand behält ihren Stand; Netz prüfen |
| Alles leer, keine Fehler | im System sind keine freigegebenen Botschaften | Moderation ansehen, ggf. Auto-Freigabe |

Ausführlich steht die Technik im Übergabeprotokoll; hier steht nur, was am Abend zählt.
