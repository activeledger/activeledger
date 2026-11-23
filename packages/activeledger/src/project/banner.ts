/** The logo and the name in letters, for the interactive `project` commands. Plain ASCII so any terminal draws it. */

/** The A of the logo, five rows tall like the letters beside it: it is the first letter of the name */
export const LOGO = [
  "    /\\",
  "   /  \\",
  "  / /\\ \\",
  " / /__\\ \\",
  "/_/    \\_\\",
];
const LOGO_WIDTH = 10;

// 5 rows per letter; only the letters the name needs
const FONT: { [letter: string]: string[] } = {
  A: [" ### ", "#   #", "#####", "#   #", "#   #"],
  C: [" ####", "#    ", "#    ", "#    ", " ####"],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
  I: ["###", " # ", " # ", " # ", "###"],
  V: ["#   #", "#   #", "#   #", " # # ", "  #  "],
  E: ["#####", "#    ", "#### ", "#    ", "#####"],
  L: ["#    ", "#    ", "#    ", "#    ", "#####"],
  D: ["#### ", "#   #", "#   #", "#   #", "#### "],
  G: [" ####", "#    ", "#  ##", "#   #", " ####"],
  R: ["#### ", "#   #", "#### ", "#  # ", "#   #"],
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

/** The name in letters: the logo is its first A, so the letters are the rest of the name, side by side with it */
export const NAME = letters("ACTIVELEDGER");
export const NAME_AFTER_LOGO = letters("CTIVELEDGER");

/** The logo's A joined to the rest of the name, as one line of letters, then the tagline */
export const banner = (tagline = "Contracts, namespaces and transactions from the command line"): string[] => [
  ...LOGO.map((row, r) => row.padEnd(LOGO_WIDTH) + " " + NAME_AFTER_LOGO[r]),
  "",
  `  ${tagline}`,
  "",
];

/** Whether to draw the banner: only to a person at a terminal, and never with --json, --quiet or NO_COLOR-style opt outs */
export const wantBanner = (tty: boolean, env: { [k: string]: string | undefined }, flags: { json?: boolean; quiet?: boolean }): boolean =>
  tty && !flags.json && !flags.quiet && !env.NO_BANNER && !env.CI;
