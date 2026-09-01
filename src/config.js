// Alle Stellschrauben an einem Ort. Werte lassen sich per Umgebungsvariable
// überschreiben — in Coolify unter "Environment Variables".

module.exports = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  datenbank: process.env.DB_PFAD || './data/botschaften.db',

  // Eingabe
  maxZeichenText: Number(process.env.MAX_ZEICHEN || 120),
  maxZeichenName: Number(process.env.MAX_ZEICHEN_NAME || 15),
  empfohleneZeichen: Number(process.env.EMPFOHLENE_ZEICHEN || 35), // bis hierhin passt eine Botschaft auf alle 33 Flächen
  nameErlaubt: process.env.NAME_ERLAUBT !== 'false',
  sperreProGeraetSekunden: Number(process.env.SPERRE_SEKUNDEN || 30),

  // Filterkette (Block 4).
  // Stufe 1a (Wortliste, Regeln) laeuft immer. autoFreigabe entscheidet nur,
  // was mit einem sauberen FREI passiert: true = direkt in die Anzeige,
  // false = trotzdem erst durch die Moderation. Ein PRUEFEN geht in jedem
  // Fall in die Queue, ein ABLEHNEN in jedem Fall zurueck.
  autoFreigabe: process.env.AUTO_FREIGABE !== 'false',

  // Wortlaut gegenueber dem Absender. Ohne Grund - eine Begruendung waere die
  // Anleitung fuer den naechsten Versuch (Filterrichtlinie, Abschnitt 2 und 7).
  textAblehnung: process.env.TEXT_ABLEHNUNG
    || 'Diese Botschaft können wir leider nicht zeigen. Versuch es gern mit anderen Worten.',

  // Anzeige
  standzeitSekunden: Number(process.env.STANDZEIT || 25),
  blendeSekunden: 0.35,          // muss zum Patch passen (Smooth-Knoten)
  maxVersalhoehe: Number(process.env.MAX_VERSALHOEHE || 40),
  minVersalhoehe: Number(process.env.MIN_VERSALHOEHE || 22), // darunter gilt eine Fläche als unpassend
  taktMillisekunden: 250
};
