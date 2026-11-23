/** The logo and the name in letters, for the interactive `project` commands. Plain ASCII so any terminal draws it. */

export const LOGO = [
  "        /\\",
  "       /  \\",
  "      / /\\ \\",
  "     / /  \\ \\",
  "    / /____\\ \\",
  "   /_/      \\_\\",
];

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

export const NAME = letters("ACTIVELEDGER");

/** Logo and name together, as lines (the logo beside the first rows of the name is too wide, so one above the other) */
export const banner = (tagline = "Contracts, namespaces and transactions from the command line"): string[] => [
  ...LOGO,
  "",
  ...NAME,
  "",
  `  ${tagline}`,
  "",
];

/** Whether to draw the banner: only to a person at a terminal, and never with --json, --quiet or NO_COLOR-style opt outs */
export const wantBanner = (tty: boolean, env: { [k: string]: string | undefined }, flags: { json?: boolean; quiet?: boolean }): boolean =>
  tty && !flags.json && !flags.quiet && !env.NO_BANNER && !env.CI;
