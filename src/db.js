// SQLite, eine Datei. Sichern heißt: Datei kopieren.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(path.dirname(cfg.datenbank), { recursive: true });
const db = new Database(cfg.datenbank);
db.pragma('journal_mode = WAL');   // überlebt einen harten Stromausfall besser
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS botschaften (
  id             INTEGER PRIMARY KEY,
  text           TEXT    NOT NULL,
  name           TEXT,
  -- neu | freigegeben | zurueckgestellt | abgelehnt | gesperrt
  --   neu             wartet in der Moderationsqueue
  --   zurueckgestellt von der Moderation vertagt, kommt in der eigenen Ansicht wieder
  --   gesperrt        war schon freigegeben und wurde wieder heruntergenommen
  status         TEXT    NOT NULL DEFAULT 'neu',
  filter         TEXT,                             -- JSON, Ergebnis der Filterkette (Block 4)
  token          TEXT    NOT NULL UNIQUE,          -- damit der Absender seinen Status abfragen kann
  geraet         TEXT,                             -- gehashte Gerätekennung, nur für die Spam-Sperre
  erstellt_am    INTEGER NOT NULL,
  entschieden_am INTEGER,
  anzahl_anzeigen INTEGER NOT NULL DEFAULT 0,
  zuletzt_gezeigt INTEGER,
  -- vom Filter als Grenzfall markiert (Urteil PRUEFEN). Steht in der Queue
  -- vorn und wird in der Oberfläche rot umrandet.
  unsicher       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_botschaften_status ON botschaften(status, anzahl_anzeigen, zuletzt_gezeigt);
CREATE INDEX IF NOT EXISTS idx_botschaften_token  ON botschaften(token);

CREATE TABLE IF NOT EXISTS anzeigen (
  id           INTEGER PRIMARY KEY,
  botschaft_id INTEGER NOT NULL REFERENCES botschaften(id),
  flaeche      INTEGER NOT NULL,
  start        INTEGER NOT NULL,
  ende         INTEGER NOT NULL,
  versalhoehe  REAL,
  schrifthoehe REAL,
  y_versatz    REAL
);
CREATE INDEX IF NOT EXISTS idx_anzeigen_botschaft ON anzeigen(botschaft_id, start);
CREATE INDEX IF NOT EXISTS idx_anzeigen_flaeche   ON anzeigen(flaeche, start);

-- Hinweise vom Platz: organisatorische Durchsagen auf der Stirnseite Mitte.
-- BEWUSST eine eigene Tabelle und nicht botschaften: sie kommen nicht aus
-- dem Publikum, gehen durch keinen Filter, brauchen keine Moderation und
-- duerfen weder in der Queue noch in den Kennzahlen auftauchen. Ein Flag auf
-- botschaften haette all das an jeder Abfrage nachgezogen.
CREATE TABLE IF NOT EXISTS hinweise (
  id              INTEGER PRIMARY KEY,
  nr              INTEGER NOT NULL UNIQUE,  -- Platz in der Liste, ab 1
  text            TEXT    NOT NULL DEFAULT '',
  -- scharf heisst: kommt an die Wand, sobald die Flaeche das naechste Mal
  -- wechselt. Stehendes wird nie unterbrochen.
  scharf          INTEGER NOT NULL DEFAULT 0,
  anzahl_anzeigen INTEGER NOT NULL DEFAULT 0,
  zuletzt_gezeigt INTEGER
);

-- Fuellsel: eigene Texte, die Luecken schliessen. Am Anfang des Abends ist
-- noch nichts eingegangen, und auf die schmalen Saeulen passt manche lange
-- Botschaft nicht lesbar drauf — ohne Fuellsel bliebe die Flaeche dunkel.
-- Eigene Tabelle aus demselben Grund wie bei den Hinweisen: sie kommen nicht
-- aus dem Publikum und duerfen die Kennzahlen des Abends nicht faerben.
CREATE TABLE IF NOT EXISTS fuellsel (
  id              INTEGER PRIMARY KEY,
  nr              INTEGER NOT NULL UNIQUE,  -- Platz in der Liste, ab 1
  text            TEXT    NOT NULL DEFAULT '',
  -- aktiv heisst: darf eine Luecke fuellen. Nicht: kommt garantiert dran.
  aktiv           INTEGER NOT NULL DEFAULT 0,
  anzahl_anzeigen INTEGER NOT NULL DEFAULT 0,
  zuletzt_gezeigt INTEGER
);

-- Die Spielzeiten des Abends (Sessions). Minuten seit Mitternacht als Plan,
-- echte Zeitstempel sobald gestartet wurde. Dass beides in der Datenbank
-- steht und nicht im Arbeitsspeicher, ist Absicht: eine laufende Session
-- uebersteht so einen Neustart des Dienstes mitten am Abend.
CREATE TABLE IF NOT EXISTS sessionen (
  id            INTEGER PRIMARY KEY,
  nr            INTEGER NOT NULL UNIQUE,   -- Reihenfolge des Abends, ab 1
  geplant_start INTEGER NOT NULL,          -- Minuten seit Mitternacht, unverbindlich
  geplant_ende  INTEGER NOT NULL,          -- Minuten seit Mitternacht, verbindlich: dann ist die Wand leer
  start         INTEGER,                   -- echter Start, gesetzt per Knopf
  ende          INTEGER,                   -- echtes Ende, beim Start aus geplant_ende aufgeloest
  abgebrochen   INTEGER NOT NULL DEFAULT 0
);

-- Schalter, die im Betrieb umgelegt werden (Block 5): Auto-Freigabe, Nachschub.
CREATE TABLE IF NOT EXISTS einstellungen (
  schluessel   TEXT PRIMARY KEY,
  wert         TEXT NOT NULL,
  geaendert_am INTEGER
);
`);

// Nachtrag für Datenbanken aus Block 2 und 4: die Spalte `unsicher` kam erst
// mit Block 5 dazu. Bestehende Zeilen bekommen sie aus dem gespeicherten
// Filterergebnis nachgetragen, sonst sortiert die Queue nach einem Update falsch.
function spalteErgaenzen (tabelle, name, definition) {
  const vorhanden = db.prepare(`PRAGMA table_info(${tabelle})`).all().some(s => s.name === name);
  if (!vorhanden) db.exec(`ALTER TABLE ${tabelle} ADD COLUMN ${name} ${definition}`);
  return !vorhanden;
}
if (spalteErgaenzen('botschaften', 'unsicher', 'INTEGER NOT NULL DEFAULT 0')) {
  db.prepare(`UPDATE botschaften SET unsicher = 1 WHERE filter LIKE '%"urteil":"PRUEFEN"%'`).run();
}
db.exec('CREATE INDEX IF NOT EXISTS idx_botschaften_queue ON botschaften(status, unsicher, erstellt_am)');

const abfragen = {
  einfuegen: db.prepare(`INSERT INTO botschaften (text, name, status, filter, token, geraet, erstellt_am, entschieden_am, unsicher)
                         VALUES (@text, @name, @status, @filter, @token, @geraet, @erstellt_am, @entschieden_am, @unsicher)`),
  perToken: db.prepare('SELECT * FROM botschaften WHERE token = ?'),
  perId: db.prepare('SELECT * FROM botschaften WHERE id = ?'),
  letzteVomGeraet: db.prepare('SELECT erstellt_am FROM botschaften WHERE geraet = ? ORDER BY erstellt_am DESC LIMIT 1'),
  spielbar: db.prepare(`SELECT * FROM botschaften WHERE status = 'freigegeben'
                        ORDER BY anzahl_anzeigen ASC, COALESCE(zuletzt_gezeigt, 0) ASC, erstellt_am ASC
                        LIMIT 400`),
  anzeigeEintragen: db.prepare(`INSERT INTO anzeigen (botschaft_id, flaeche, start, ende, versalhoehe, schrifthoehe, y_versatz)
                                VALUES (@botschaft_id, @flaeche, @start, @ende, @versalhoehe, @schrifthoehe, @y_versatz)`),
  anzeigeGezaehlt: db.prepare(`UPDATE botschaften SET anzahl_anzeigen = anzahl_anzeigen + 1, zuletzt_gezeigt = ? WHERE id = ?`),
  anzeigenZuBotschaft: db.prepare('SELECT flaeche, start, ende FROM anzeigen WHERE botschaft_id = ? ORDER BY start DESC LIMIT 10'),
  wartendeVor: db.prepare(`SELECT COUNT(*) AS n FROM botschaften
                           WHERE status = 'freigegeben' AND anzahl_anzeigen = 0 AND erstellt_am < ?`),
  kennzahlen: db.prepare(`SELECT status, COUNT(*) AS n FROM botschaften GROUP BY status`),

  // ---- Moderation (Block 5) ----------------------------------------------
  // Die Queue kommt in zwei Portionen: erst die unsicheren (rot umrandet,
  // einzeln zu prüfen), dann die unauffälligen (Rasteransicht).
  queue: db.prepare(`SELECT id, text, name, status, filter, unsicher, erstellt_am, anzahl_anzeigen
                     FROM botschaften WHERE status = 'neu' AND unsicher = @unsicher
                     ORDER BY erstellt_am ASC LIMIT @grenze`),
  nachStatus: db.prepare(`SELECT id, text, name, status, filter, unsicher, erstellt_am, entschieden_am, anzahl_anzeigen
                          FROM botschaften WHERE status = @status
                          ORDER BY COALESCE(entschieden_am, erstellt_am) DESC LIMIT @grenze`),
  offen: db.prepare(`SELECT unsicher, COUNT(*) AS n FROM botschaften WHERE status = 'neu' GROUP BY unsicher`),
  entschiedenSeit: db.prepare('SELECT COUNT(*) AS n FROM botschaften WHERE entschieden_am >= ?'),
  statusSetzen: db.prepare('UPDATE botschaften SET status = @status, entschieden_am = @zeit WHERE id = @id'),
  alleAnzeigenLoeschen: db.prepare('DELETE FROM anzeigen'),
  alleBotschaftenLoeschen: db.prepare('DELETE FROM botschaften'),

  // ---- Hinweise vom Platz ------------------------------------------------
  hinweiseListe: db.prepare('SELECT * FROM hinweise ORDER BY nr ASC'),
  hinweiseLeeren: db.prepare('DELETE FROM hinweise'),
  hinweisEinfuegen: db.prepare(`INSERT INTO hinweise (nr, text, scharf, anzahl_anzeigen, zuletzt_gezeigt)
                                VALUES (@nr, @text, @scharf, @anzahl_anzeigen, @zuletzt_gezeigt)`),
  hinweisScharf: db.prepare('UPDATE hinweise SET scharf = @scharf WHERE nr = @nr'),
  hinweisGezeigt: db.prepare(`UPDATE hinweise
                              SET anzahl_anzeigen = anzahl_anzeigen + 1, zuletzt_gezeigt = @zeit
                              WHERE id = @id`),

  // ---- Zahlen des Abends -------------------------------------------------
  // Eine Abfrage fuer die ganze Kachel. Getrennt wird nach Status UND danach,
  // ob schon die Filterkette abgelehnt hat: beides steht als `abgelehnt` in
  // derselben Spalte, aber "hat nie ein Mensch gesehen" ist die interessantere
  // Zahl. Das Urteil liegt im mitgeschriebenen Filterergebnis.
  abendZahlen: db.prepare(`SELECT status,
                                  CASE WHEN json_extract(filter, '$.urteil') = 'ABLEHNEN'
                                       THEN 1 ELSE 0 END AS vom_filter,
                                  count(*) AS n
                           FROM botschaften GROUP BY status, vom_filter`),
  einblendungen: db.prepare('SELECT count(*) AS n FROM anzeigen'),
  aeltesteBotschaft: db.prepare('SELECT min(erstellt_am) AS zeit FROM botschaften'),

  // ---- Fuellsel ----------------------------------------------------------
  fuellselListe: db.prepare('SELECT * FROM fuellsel ORDER BY nr ASC'),
  fuellselLeeren: db.prepare('DELETE FROM fuellsel'),
  fuellselEinfuegen: db.prepare(`INSERT INTO fuellsel (nr, text, aktiv, anzahl_anzeigen, zuletzt_gezeigt)
                                 VALUES (@nr, @text, @aktiv, @anzahl_anzeigen, @zuletzt_gezeigt)`),
  fuellselAktiv: db.prepare('UPDATE fuellsel SET aktiv = @aktiv WHERE nr = @nr'),
  fuellselGezeigt: db.prepare(`UPDATE fuellsel
                               SET anzahl_anzeigen = anzahl_anzeigen + 1, zuletzt_gezeigt = @zeit
                               WHERE id = @id`),

  // ---- Spielzeiten -------------------------------------------------------
  sessionenListe: db.prepare('SELECT * FROM sessionen ORDER BY nr ASC'),
  sessionenLeeren: db.prepare('DELETE FROM sessionen'),
  sessionEinfuegen: db.prepare(`INSERT INTO sessionen (nr, geplant_start, geplant_ende, start, ende, abgebrochen)
                                VALUES (@nr, @geplant_start, @geplant_ende, @start, @ende, @abgebrochen)`),
  sessionStarten: db.prepare('UPDATE sessionen SET start = @start, ende = @ende WHERE id = @id'),
  sessionAbbrechen: db.prepare('UPDATE sessionen SET ende = @ende, abgebrochen = 1 WHERE id = @id'),

  einstellungLesen: db.prepare('SELECT wert FROM einstellungen WHERE schluessel = ?'),
  einstellungSchreiben: db.prepare(`INSERT INTO einstellungen (schluessel, wert, geaendert_am)
                                    VALUES (@schluessel, @wert, @geaendert_am)
                                    ON CONFLICT(schluessel) DO UPDATE
                                    SET wert = excluded.wert, geaendert_am = excluded.geaendert_am`)
};

module.exports = { db, abfragen };
