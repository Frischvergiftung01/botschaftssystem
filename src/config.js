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
  // Wartezeit zwischen zwei Botschaften desselben Geraets. 120 s statt 30:
  // eine halbe Minute laedt zum Spammen ein (Entscheidung 04.09.2026).
  sperreProGeraetSekunden: Number(process.env.SPERRE_SEKUNDEN || 120),

  // Filterkette (Block 4).
  // Stufe 1a (Wortliste, Regeln) laeuft immer. autoFreigabe entscheidet nur,
  // was mit einem sauberen FREI passiert: true = direkt in die Anzeige,
  // false = trotzdem erst durch die Moderation. Ein PRUEFEN geht in jedem
  // Fall in die Queue, ein ABLEHNEN in jedem Fall zurueck.
  //
  // Ab Block 5 ist das nur noch der STARTWERT. Der laufende Schalter steht in
  // der Datenbank (Tabelle `einstellungen`) und wird in der Moderation
  // umgelegt — am Abend soll niemand auf einen Redeploy warten muessen.
  autoFreigabe: process.env.AUTO_FREIGABE !== 'false',

  // Stufe 1b — Sprachmodell. Ohne Schluessel ist sie stillgelegt und die
  // Kette endet nach 1a. Der Schluessel steht in Coolify, nie im Repository.
  // Leerzeichen, Zeilenumbrueche und mitkopierte Anfuehrungszeichen abschneiden:
  // beim Einfuegen in Coolify rutschen die regelmaessig mit, und die
  // Gegenstelle antwortet dann mit einem nackten 401.
  mistralSchluessel: (process.env.MISTRAL_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
  mistralModell: process.env.MISTRAL_MODELL || 'mistral-small-2603',
  mistralZeitlimitMs: Number(process.env.MISTRAL_ZEITLIMIT_MS || 3000),
  // So viele Aufrufe gleichzeitig. Wird nach der Messung gegen das echte
  // Rate-Limit gesetzt — zu hoch bringt 429er statt Tempo.
  mistralParallel: Number(process.env.MISTRAL_PARALLEL || 4),

  // Wortlaut gegenueber dem Absender. Ohne Grund - eine Begruendung waere die
  // Anleitung fuer den naechsten Versuch (Filterrichtlinie, Abschnitt 2 und 7).
  textAblehnung: process.env.TEXT_ABLEHNUNG
    || 'Diese Botschaft können wir leider nicht zeigen. Versuch es gern mit anderen Worten.',

  // Moderation (Block 5).
  // Ohne gesetztes Kennwort bleibt die Oberflaeche ZU. Eine offene
  // Freigabeseite im Netz waere schlimmer als gar keine. Das Kennwort steht in
  // Coolify unter Environment Variables, niemals im Repository.
  moderationKennwort: (process.env.MODERATION_KENNWORT || '').trim().replace(/^["']|["']$/g, ''),
  moderationSitzungStunden: Number(process.env.MODERATION_SITZUNG_STUNDEN || 14),
  rasterGroesse: Number(process.env.RASTER_GROESSE || 12),
  // Das Werkzeug "Datenbank leeren" gehoert in die Vorbereitung, nicht in den
  // Veranstaltungsabend. Am 5. November auf false stellen.
  datenbankLeerenErlaubt: process.env.DATENBANK_LEEREN !== 'false',

  // Spielzeiten (Sessions).
  // Der Dienst laeuft in Coolify und damit sehr wahrscheinlich auf UTC, die
  // eingetragenen Uhrzeiten meinen aber Ortszeit am Koenigsbau. Ohne diese
  // Angabe laege der ganze Abend um eine Stunde daneben.
  zeitzone: process.env.ZEITZONE || 'Europe/Berlin',

  // Anzeige
  standzeitSekunden: Number(process.env.STANDZEIT || 25),
  blendeSekunden: 0.35,          // muss zum Patch passen (Smooth-Knoten)
  maxVersalhoehe: Number(process.env.MAX_VERSALHOEHE || 40),
  minVersalhoehe: Number(process.env.MIN_VERSALHOEHE || 22), // darunter gilt eine Fläche als unpassend
  taktMillisekunden: 250
};
