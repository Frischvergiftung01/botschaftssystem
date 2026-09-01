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
  status         TEXT    NOT NULL DEFAULT 'neu',   -- neu | freigegeben | abgelehnt | gesperrt
  filter         TEXT,                             -- JSON, Ergebnis der Filterkette (Block 4)
  token          TEXT    NOT NULL UNIQUE,          -- damit der Absender seinen Status abfragen kann
  geraet         TEXT,                             -- gehashte Gerätekennung, nur für die Spam-Sperre
  erstellt_am    INTEGER NOT NULL,
  entschieden_am INTEGER,
  anzahl_anzeigen INTEGER NOT NULL DEFAULT 0,
  zuletzt_gezeigt INTEGER
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
`);

const abfragen = {
  einfuegen: db.prepare(`INSERT INTO botschaften (text, name, status, filter, token, geraet, erstellt_am, entschieden_am)
                         VALUES (@text, @name, @status, @filter, @token, @geraet, @erstellt_am, @entschieden_am)`),
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
  status: db.prepare('UPDATE botschaften SET status = ?, entschieden_am = ? WHERE id = ?')
};

module.exports = { db, abfragen };
