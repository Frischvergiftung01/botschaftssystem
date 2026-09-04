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

  einstellungLesen: db.prepare('SELECT wert FROM einstellungen WHERE schluessel = ?'),
  einstellungSchreiben: db.prepare(`INSERT INTO einstellungen (schluessel, wert, geaendert_am)
                                    VALUES (@schluessel, @wert, @geaendert_am)
                                    ON CONFLICT(schluessel) DO UPDATE
                                    SET wert = excluded.wert, geaendert_am = excluded.geaendert_am`)
};

module.exports = { db, abfragen };
