// Wortliste zur Filterrichtlinie, Stufe 1a.
//
// Drei Ränge, wie in der Richtlinie beschrieben:
//   hart   → sofort ablehnen, ohne Moderation und ohne Sprachmodell
//   weich  → in die Moderationsqueue. Auch das Sprachmodell holt sie da nicht
//            wieder heraus: es darf nur verschaerfen, freigeben darf nur ein Mensch
//   ausnahmen → heben einen Treffer wieder auf ("die linke Hand")
//
// Die Einträge werden beim Laden durch dieselbe Normalisierung geschickt wie
// die Botschaft. Deshalb darf hier natürlich geschrieben werden — "Grüße",
// "scheiße", "Ausländer raus" — und Doppelbuchstaben, Umlaute und ß sind egal.
//
// Abgeglichen wird mit Wortgrenzen. "krieg" trifft deshalb nicht in
// "Kriegsbergstraße", und "18" nicht in "1888".
//
// ⚠ Diese Datei gehört nicht in Konzeptpapiere und nicht in Anhänge. Eine
//   Blockliste, die im Umlauf ist, ist eine Anleitung zum Umgehen.

module.exports = {

  // ------------------------------------------------------------------ hart
  // Richtlinie 4.1 Beleidigung · 4.3 Extremismus · 4.4 Sexuelles · 4.5 Gewalt
  hart: [
    // Beschimpfung, Herabwürdigung
    'arschloch', 'wichser', 'hurensohn', 'hurentochter', 'fotze', 'missgeburt',
    'schlampe', 'nutte', 'drecksau', 'drecksack', 'dreckskerl', 'abschaum',
    'untermensch', 'spast', 'spasti', 'mongo', 'mongoloid', 'vollidiot',
    'halt die fresse', 'fick dich', 'fickt euch', 'verpiss dich', 'leck mich',
    // Slurs
    'kanake', 'neger', 'nigger', 'schwuchtel', 'judensau', 'judenschwein',
    'zigeuner', 'schlitzauge', 'itaker', 'rassenschande',
    // Sexuelles, explizit
    'ficken', 'arschficker', 'blowjob', 'muschi', 'titten', 'porno', 'pornhub',
    'onlyfans', 'masturbieren', 'wichsen',
    // Gewalt, Drohung, Selbstverletzung
    'umbringen', 'bring dich um', 'bringt euch um', 'abstechen', 'abknallen',
    'erschiessen', 'aufhaengen', 'vergasen', 'vergast', 'verrecke', 'krepier',
    'stirb', 'du stirbst', 'toete dich',
    // Extremismus
    'sieg heil', 'heil hitler', 'hitlergruss', 'hitler', 'hakenkreuz',
    'blut und ehre', 'meine ehre heisst treue', 'auslaender raus',
    'deutschland den deutschen', 'volksverraeter', 'nsdap', 'umvolkung',
    'holocaustluege', 'judenvergasung'
  ],

  // Auch ohne Wortgrenzen, gegen den zusammengezogenen Text. Nur lange,
  // eindeutige Begriffe — sonst findet man "Penis" in "Alpen Island".
  hartKompakt: [
    'siegheil', 'heilhitler', 'hurensohn', 'arschloch', 'judensau',
    'judenschwein', 'hakenkreuz', 'blutundehre', 'auslaenderraus', 'fickdich'
  ],

  // Gegen die Basisfassung, in der die Zahlen unangetastet sind.
  hartMuster: [
    /\b1488\b/,          // 14 Worte + 88
    /\b14\s*\/\s*88\b/,
    /\b8\s*8\s*8\b/      // gesperrt geschriebenes 88 mit Fuellzeichen
  ],

  // ----------------------------------------------------------------- weich
  // Geht in die Moderation - endgueltig fuer Stufe 1. Im Zweifel nein.
  weich: [
    // Zahlen- und Buchstabencodes, die auch harmlos vorkommen
    '88', '18', '28', '1312', 'acab', '161', '162', 'hh', 'ns', 'ss',
    // Richtlinie 4.2 — Parteien
    'afd', 'cdu', 'csu', 'spd', 'fdp', 'gruene', 'linke', 'bsw', 'npd',
    'freie waehler', 'piratenpartei',
    // Richtlinie 4.2 — Personen des politischen Lebens
    'merz', 'scholz', 'merkel', 'habeck', 'baerbock', 'weidel', 'chrupalla',
    'lindner', 'wagenknecht', 'soeder', 'kretschmann', 'nopper', 'trump',
    'putin', 'selenskyj', 'netanjahu', 'erdogan', 'macron', 'musk',
    // Richtlinie 4.2 — laufende Konflikte
    'gaza', 'israel', 'palaestina', 'palestine', 'ukraine', 'russland',
    'hamas', 'hisbollah', 'nahost', 'syrien', 'iran', 'krieg', 'sanktionen',
    // Richtlinie 4.2 — Losungen, Aufrufe, Anliegen (Entscheidung: Moderation)
    'wahl', 'waehlt', 'waehlen', 'demo', 'demonstration', 'gegen rechts',
    'gegen links', 'nazis raus', 'nieder mit', 'stoppt', 'revolution',
    'streik', 'klima', 'klimawandel', 'klimaschutz', 'klimakleber', 'rettet', 'letzte generation',
    'fridays for future', 'tierschutz', 'tierversuche', 'abtreibung',
    'gendern', 'impfpflicht', 'corona', 'migration', 'asyl', 'fluechtlinge',
    'abschiebung', 'remigration', 'free palestine', 'islamisten', 'scharia',
    'scientology',
    // Richtlinie 4.6 — Werbung, Marken, Kommerz
    'mercedes', 'porsche', 'bosch', 'daimler', 'edeka', 'lidl', 'aldi', 'rewe',
    'mcdonalds', 'burger king', 'coca cola', 'red bull', 'netflix', 'amazon',
    'telekom', 'ebay', 'casino', 'kredit', 'bitcoin', 'krypto', 'gewinnspiel',
    'rabatt', 'gutschein', 'angebot', 'sale', 'shop', 'kaufen', 'verkaufe',
    'werbung', 'sponsor',
    // Richtlinie 4.6 — auswaertige Vereine. Entscheidung vom 01.09.2026:
    // VfB und Kickers sind frei, alles gegen andere Vereine faellt unter 4.1.
    'bayern', 'fcb', 'bvb', 'dortmund', 'schalke', 'hsv', 'ksc',
    'karlsruher', 'eintracht', 'hoffenheim', 'hertha', 'sechzig',
    // Richtlinie 4.5 / heikel
    'suizid', 'selbstmord', 'ritzen', 'kokain', 'komasaufen', 'drogen'
  ],

  weichMuster: [
    /\b\d{1,2}\s*[:\/]\s*\d{1,3}\b/   // 168:1 und Verwandte
  ],

  // ------------------------------------------------------------- ausnahmen
  // Steht eine dieser Wendungen im Text, gilt der Treffer als erledigt.
  // Das ist die Stelle, an der Fehlalarme aus dem Betrieb einsortiert werden.
  ausnahmen: {
    'linke': ['linke hand', 'linke seite', 'linke tasche', 'linkes bein', 'von linke nach'],
    'gruene': ['gruene sose', 'gruene wiese', 'gruene welle', 'ins gruene', 'gruene minna'],
    'krieg': ['kriegsberg'],
    '18': ['jahrgang 18', 'seit 18', 'jahre alt', 'geburtstag'],
    '88': ['jahrgang 88', 'seit 88', 'baujahr 88'],
    'bayern': ['gruesse nach bayern', 'aus bayern'],
    'stirb': ['stirbt nie']
  }
};
