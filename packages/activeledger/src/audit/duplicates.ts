import { Duplicate } from "./types";

const WINDOW = 6;

/** Lines that carry meaning: comments, blanks and bare punctuation are dropped, spacing is normalised */
const meaningful = (text: string): { line: number; norm: string }[] => {
  const out: { line: number; norm: string }[] = [];
  text.split("\n").forEach((raw, i) => {
    const norm = raw.replace(/\/\/.*$/, "").replace(/\s+/g, " ").trim();
    if (norm.length >= 6 && /[A-Za-z0-9]/.test(norm)) out.push({ line: i + 1, norm });
  });
  return out;
};

/**
 * Blocks of at least WINDOW meaningful lines that appear twice, in two files or twice in one.
 * Overlapping windows are merged into one block.
 */
export const findDuplicates = (files: { file: string; text: string }[]): Duplicate[] => {
  const seen = new Map<string, { f: number; i: number }[]>();
  const lines = files.map((f) => meaningful(f.text));
  lines.forEach((ls, f) => {
    for (let i = 0; i + WINDOW <= ls.length; i++) {
      const key = ls.slice(i, i + WINDOW).map((l) => l.norm).join("\n");
      const at = seen.get(key);
      if (at) at.push({ f, i });
      else seen.set(key, [{ f, i }]);
    }
  });
  // run key: file a, file b, offset between them; value: the start indexes in a
  const runs = new Map<string, number[]>();
  for (const at of seen.values()) {
    if (at.length < 2 || at.length > 8) continue; // a block repeated many times is boilerplate, not a copy
    for (let x = 0; x < at.length; x++) {
      for (let y = x + 1; y < at.length; y++) {
        const a = at[x], b = at[y];
        if (a.f === b.f && b.i - a.i < WINDOW) continue;
        const key = `${a.f}|${b.f}|${b.i - a.i}`;
        (runs.get(key) || runs.set(key, []).get(key)!).push(a.i);
      }
    }
  }
  const found: Duplicate[] = [];
  for (const [key, starts] of runs) {
    const [fa, fb, off] = key.split("|").map(Number);
    starts.sort((p, q) => p - q);
    let s = starts[0], prev = starts[0];
    const close = () => {
      const n = prev - s + WINDOW;
      if (fa === fb && off < n) return; // the two copies overlap each other
      const la = lines[fa], lb = lines[fb];
      found.push({
        a: { file: files[fa].file, from: la[s].line, to: la[s + n - 1].line },
        b: { file: files[fb].file, from: lb[s + off].line, to: lb[s + off + n - 1].line },
        lines: n,
      });
    };
    for (let k = 1; k < starts.length; k++) {
      if (starts[k] === prev + 1) prev = starts[k];
      else (close(), (s = prev = starts[k]));
    }
    close();
  }
  return found.sort((p, q) => q.lines - p.lines).slice(0, 25);
};
