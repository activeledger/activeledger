/**
 * Compares two files from behaviour-snapshot.ts step by step and prints every
 * difference. Exit status 1 if there is any, or if either file shows nodes that
 * do not hold the same documents.
 *
 *   npm run test:behaviour:compare -- /tmp/release.json /tmp/candidate.json
 */
import * as fs from "fs";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: behaviour-compare <release.json> <candidate.json>");
  process.exit(2);
}
const load = (f: string): { name: string; result: any }[] => JSON.parse(fs.readFileSync(f, "utf8")).steps;
const A = load(a);
const B = load(b);
let differences = 0;
for (const step of A) {
  const other = B.find((s) => s.name === step.name);
  const left = JSON.stringify(step.result);
  const right = other ? JSON.stringify(other.result) : "(missing)";
  if (left !== right) {
    differences++;
    console.log(`DIFFERENT  ${step.name}\n   ${a}: ${left}\n   ${b}: ${right}`);
  }
}
for (const step of B) if (!A.some((s) => s.name === step.name)) {
  differences++;
  console.log(`DIFFERENT  ${step.name} only in ${b}`);
}
let unconverged = 0;
for (const [file, steps] of [[a, A], [b, B]] as [string, typeof A][]) {
  const c = steps.find((s) => s.name === "every node holds the same documents")?.result;
  const bad = !c || c.documentsMissingOnSomeNode || c.revisionsThatDiffer || c.umidDocumentsThatDiffer || !c.eventRowsIdenticalOnEveryNode;
  if (bad) {
    unconverged++;
    console.log(`NODES DISAGREE in ${file}: ${JSON.stringify(c)}`);
  }
}
console.log(`${A.length} steps compared: ${differences} difference(s), ${unconverged} file(s) with nodes that disagree`);
process.exit(differences || unconverged ? 1 : 0);
