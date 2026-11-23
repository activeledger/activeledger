/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The logo and the name in letters, for the banner every command line program
 * shows to a person at a terminal. Plain ASCII, so any terminal draws it.
 *
 * The logo is the first A of the name: it is drawn five rows tall like the
 * letters beside it, so `activeledger` reads as the A followed by CTIVELEDGER.
 */

/** The A of the logo */
export const LOGO = [
  "    /\\",
  "   /  \\",
  "  / /\\ \\",
  " / /__\\ \\",
  "/_/    \\_\\",
];
const LOGO_WIDTH = 10;

// 5 rows per letter; the letters the program names need
const FONT: { [letter: string]: string[] } = {
  A: [" ### ", "#   #", "#####", "#   #", "#   #"],
  B: ["#### ", "#   #", "#### ", "#   #", "#### "],
  C: [" ####", "#    ", "#    ", "#    ", " ####"],
  D: ["#### ", "#   #", "#   #", "#   #", "#### "],
  E: ["#####", "#    ", "#### ", "#    ", "#####"],
  G: [" ####", "#    ", "#  ##", "#   #", " ####"],
  H: ["#   #", "#   #", "#####", "#   #", "#   #"],
  I: ["###", " # ", " # ", " # ", "###"],
  L: ["#    ", "#    ", "#    ", "#    ", "#####"],
  O: [" ### ", "#   #", "#   #", "#   #", " ### "],
  R: ["#### ", "#   #", "#### ", "#  # ", "#   #"],
  S: [" ####", "#    ", " ### ", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
  V: ["#   #", "#   #", "#   #", " # # ", "  #  "],
  Y: ["#   #", " # # ", "  #  ", "  #  ", "  #  "],
};

/** `text` (letters of the font only) as five rows of block letters */
export const letters = (text: string): string[] => {
  const rows = ["", "", "", "", ""];
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`no glyph for ${ch}`);
    for (let r = 0; r < 5; r++) rows[r] += (rows[r] ? " " : "") + glyph[r];
  }
  return rows;
};

/**
 * The program's name as five rows: the logo's A, then the rest of the name in
 * letters. A name that does not start with an a is drawn in letters alone.
 */
export const nameArt = (name: string): string[] => {
  const lower = name.toLowerCase();
  if (!lower.startsWith("a")) return letters(lower);
  const rest = letters(lower.slice(1));
  return LOGO.map((row, r) => row.padEnd(LOGO_WIDTH) + " " + rest[r]);
};

/** The art, then the program and its version, then a line of text (a tagline), as lines to print */
export const bannerLines = (name: string, version: string, tagline: string): string[] => [
  ...nameArt(name),
  "",
  `  ${name} ${version}`,
  `  ${tagline}`,
  "",
];
