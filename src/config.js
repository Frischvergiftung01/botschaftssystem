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

  // Filterkette (Block 4). Solange sie fehlt, wandert alles direkt in die Anzeige.
  autoFreigabe: process.env.AUTO_FREIGABE !== 'false',

  // Anzeige
  standzeitSekunden: Number(process.env.STANDZEIT || 25),
  blendeSekunden: 0.35,          // muss zum Patch passen (Smooth-Knoten)
  maxVersalhoehe: Number(process.env.MAX_VERSALHOEHE || 40),
  minVersalhoehe: Number(process.env.MIN_VERSALHOEHE || 22), // darunter gilt eine Fläche als unpassend
  taktMillisekunden: 250
};
