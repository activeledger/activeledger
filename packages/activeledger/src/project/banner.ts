import { Banner } from "@activeledger/activeoptions";

/** The logo and the name in letters are shared with every command line program; see packages/options/src/banner.ts */
export const LOGO = Banner.LOGO;
export const letters = Banner.letters;
export const NAME = letters("ACTIVELEDGER");
/** The rest of the name beside the logo's A */
export const NAME_AFTER_LOGO = letters("CTIVELEDGER");

/** The banner, as lines: the art, the program and its version, and a line about the command */
export const banner = (version = "", tagline = "Contracts, namespaces and transactions from the command line"): string[] =>
  Banner.bannerLines("activeledger", version, tagline);

/** Whether to draw the banner: only to a person at a terminal, and never with --json, --quiet, in CI or with NO_BANNER */
export const wantBanner = (tty: boolean, env: { [k: string]: string | undefined }, flags: { json?: boolean; quiet?: boolean }): boolean =>
  tty && !flags.json && !flags.quiet && !env.NO_BANNER && !env.CI;
