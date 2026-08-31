// Die 33 Botschaftsflächen am Königsbau.
//
// "band" ist die Lage auf der Resolume-Canvas (7680 x 1200) — dort rendert der
// Wire-Patch FVG_Message_Wall_v2 den Text. "fassade" ist die Lage am Gebäude,
// also das Ausgangsrechteck des Slices. Für Zuteilung und Simulator zählt allein
// die Breite: sie entscheidet, welche Botschaft auf welche Fläche passt.
//
// Quelle: Bandlayout_33_Flaechen_v2.csv und Slices_Ein_und_Ausgang.csv

const BANDHOEHE = 44;

/** @type {{nr:number,name:string,gruppe:string,breite:number,band:{x:number,y:number},fassade:{x:number,y:number,gedreht:boolean}}[]} */
const FLAECHEN = [
  { nr:  1, name: 'Stirn Mitte',              gruppe: 'stirn',  breite: 2280, band: { x: 2695, y:   40 }, fassade: { x: 2703, y: 460, gedreht: false } },
  { nr:  2, name: 'Stirn linker Flügel',      gruppe: 'stirn',  breite: 1680, band: { x:   30, y:   40 }, fassade: { x:  116, y: 460, gedreht: false } },
  { nr:  3, name: 'Stirn rechter Flügel',     gruppe: 'stirn',  breite: 1680, band: { x: 5960, y:   40 }, fassade: { x: 5884, y: 460, gedreht: false } },
  { nr:  4, name: 'Stirn linkes Portal',      gruppe: 'stirn',  breite:  785, band: { x: 1810, y:   40 }, fassade: { x: 1848, y: 350, gedreht: false } },
  { nr:  5, name: 'Stirn rechtes Portal',     gruppe: 'stirn',  breite:  785, band: { x: 5075, y:   40 }, fassade: { x: 5038, y: 350, gedreht: false } },
  { nr:  6, name: 'Säule 01 linkes Portal',   gruppe: 'portal', breite:  488, band: { x: 1810, y:  150 }, fassade: { x: 1848, y: 572, gedreht: true } },
  { nr:  7, name: 'Säule 02 linkes Portal',   gruppe: 'portal', breite:  488, band: { x: 1810, y:  255 }, fassade: { x: 2592, y: 572, gedreht: true } },
  { nr:  8, name: 'Säule 01 rechtes Portal',  gruppe: 'portal', breite:  488, band: { x: 5075, y:  150 }, fassade: { x: 5040, y: 572, gedreht: true } },
  { nr:  9, name: 'Säule 02 rechtes Portal',  gruppe: 'portal', breite:  488, band: { x: 5075, y:  255 }, fassade: { x: 5784, y: 572, gedreht: true } },
];

// Die 24 Kolonnadensäulen: Links 01-07, Mitte 01-10, Rechts 01-07
const RASTER = 105;
function saeulen (startNr, gruppe, anzahl, bandX, fassadeXs) {
  for (let i = 0; i < anzahl; i++) {
    FLAECHEN.push({
      nr: startNr + i,
      name: `Säule ${gruppe} ${String(i + 1).padStart(2, '0')}`,
      gruppe: gruppe.toLowerCase(),
      breite: 437,
      band: { x: bandX, y: 150 + i * RASTER },
      fassade: { x: fassadeXs[i], y: 629, gedreht: true }
    });
  }
}
saeulen(10, 'Links',  7,   30, [309, 527, 743, 965, 1179, 1401, 1620]);
saeulen(17, 'Mitte', 10, 3616, [2836, 3054, 3270, 3492, 3706, 3928, 4148, 4362, 4580, 4800]);
saeulen(27, 'Rechts', 7, 5960, [6013, 6231, 6447, 6669, 6883, 7105, 7325]);

module.exports = { FLAECHEN, BANDHOEHE };
