import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { auditCommand, auditFiles, auditSource, collect, render } from "../packages/activeledger/src/audit/audit";
import { findDuplicates } from "../packages/activeledger/src/audit/duplicates";
import * as http from "http";
import { checkDependencies, lookupAt, packageOf, registryLookup } from "../packages/activeledger/src/audit/deps";
import { band, fileScore, overallScore } from "../packages/activeledger/src/audit/score";
import { RULES } from "../packages/activeledger/src/audit/rules";

const wrap = (body: string) => `import { Standard } from "@activeledger/activecontracts";\nexport default class C extends Standard {\n${body}\n}\n`;
const rules = (src: string, file = "c.ts") => auditSource(file, src).findings.map((f) => f.rule);
const has = (src: string, rule: string) => expect(rules(src), src).to.include(rule);
const lacks = (src: string, rule: string) => expect(rules(src), src).to.not.include(rule);

describe("audit: rules fire on the pattern and stay quiet on the clean form", () => {
  it("no-eval", () => {
    has(wrap("vote(){ return eval(this.x); }"), "no-eval");
    has(wrap("vote(){ return new Function('return 1')(); }"), "no-eval");
    lacks(wrap("vote(){ return JSON.parse(this.x); }"), "no-eval");
  });
  it("forbidden-global", () => {
    has(wrap("vote(){ return process.env.A; }"), "forbidden-global");
    has(wrap("vote(){ console.log(1); }"), "forbidden-global");
    lacks(wrap("vote(){ return this.process.env; }"), "forbidden-global");
    lacks(wrap("vote(){ return {process: 1}; }"), "forbidden-global");
  });
  it("module-use", () => {
    has(wrap("") + `import x from "lodash";`, "module-use");
    has(wrap("") + `import y from "./local";`, "module-use");
    has(wrap("vote(){ return require(name); }"), "module-use");
    has(wrap("vote(){ return require('left-pad'); }"), "module-use");
    lacks(wrap(""), "module-use");
  });
  it("prototype-access", () => {
    has(wrap("vote(){ return this.x.__proto__; }"), "prototype-access");
    has(wrap("vote(){ return this.x['constructor']; }"), "prototype-access");
    lacks(wrap("vote(){ return Array.prototype.slice.call(this.x); }"), "prototype-access");
  });
  it("computed-write", () => {
    has(wrap("vote(){ const o:any={}; o[this.key] = 1; const key = this.key; o[key] = 2; }"), "computed-write");
    lacks(wrap("vote(){ const a:any[]=[]; for(let i=0;i<3;i++) a[i] = 1; }"), "computed-write");
  });
  it("local-service (from the storage-guard red-team passes)", () => {
    has(wrap("vote(){ return 'http://127.0.0.1:8080/x'; }"), "local-service");
    has(wrap("vote(){ return 'http://localhost/x'; }"), "local-service");
    has(wrap("vote(){ return 'https://db.example.com:5259/a'; }"), "local-service");
    has(wrap("vote(){ return 'activeledger/abc:volatile'; }"), "local-service");
    has(wrap("vote(){ send('https://example.com', { agent: 1 }); }"), "local-service");
    lacks(wrap("vote(){ return 'https://example.com/a'; }"), "local-service");
  });
  it("hardcoded-secret", () => {
    has(wrap("private apiKey = 'abcd1234efgh5678';"), "hardcoded-secret");
    has(wrap("vote(){ const k = '-----BEGIN RSA PRIVATE KEY-----\\nabc'; }"), "hardcoded-secret");
    lacks(wrap("private apiKey = process_env;"), "hardcoded-secret");
    lacks(wrap("private apiKey = 'short';"), "hardcoded-secret");
    lacks(wrap("private name = 'abcd1234efgh5678';"), "hardcoded-secret");
  });
  it("weak-crypto", () => {
    has(wrap("vote(){ crypto.createHash('md5'); }"), "weak-crypto");
    lacks(wrap("vote(){ crypto.createHash('sha256'); }"), "weak-crypto");
  });
  it("nondeterministic only inside the phases, and not inside inter-node comms", () => {
    has(wrap("vote(){ return Date.now() > 1; }"), "nondeterministic");
    has(wrap("commit(){ return new Date(); }"), "nondeterministic");
    has(wrap("vote(){ return Math.random() > 0.5; }"), "nondeterministic");
    lacks(wrap("helper(){ return Date.now(); }"), "nondeterministic");
    lacks(wrap("vote(){ return new Date(this.ts); }"), "nondeterministic");
    lacks(wrap("vote(){ this.setThisInterNodeComms({ t: Math.random() }); }"), "nondeterministic");
  });
  it("contract-shape accepts Standard, Event and PostProcess, refuses a file with none", () => {
    lacks(wrap(""), "contract-shape");
    lacks(`class A extends Event {}`, "contract-shape");
    lacks(`class A extends PostProcess {}`, "contract-shape");
    has(`export const x = 1;`, "contract-shape");
    has(`class A extends Other {}`, "contract-shape");
  });
  it("a leader vote is noted", () => {
    const f = auditSource("c.ts", wrap("vote(){ return { leader: true }; }")).findings.filter((x) => x.rule === "contract-shape");
    expect(f.map((x) => x.severity)).to.deep.equal(["low"]);
  });
  it("unbounded-loop", () => {
    has(wrap("vote(){ while(true){ x++; } }"), "unbounded-loop");
    has(wrap("vote(){ for(;;){ x++; } }"), "unbounded-loop");
    has(wrap("vote(){ do { x++; } while(1); }"), "unbounded-loop");
    lacks(wrap("vote(){ while(true){ if(x) break; } }"), "unbounded-loop");
    lacks(wrap("vote(){ while(true){ if(x) return 1; } }"), "unbounded-loop");
    has(wrap("vote(){ while(true){ for(const a of b){ break; } } }"), "unbounded-loop"); // an inner break does not leave the outer loop
  });
  it("swallowed-error", () => {
    has(wrap("vote(){ try { a(); } catch(e) {} }"), "swallowed-error");
    has(wrap("vote(){ a().catch(() => {}); }"), "swallowed-error");
    lacks(wrap("vote(){ try { a(); } catch(e) { throw e; } }"), "swallowed-error");
    lacks(wrap("vote(){ a().catch((e) => { log(e); }); }"), "swallowed-error");
  });
  it("long-function and nesting", () => {
    has(wrap("vote(){\n" + "a();\n".repeat(90) + "}"), "long-function");
    has(wrap("vote(){ if(a){ if(b){ if(c){ if(d){ if(e){ if(f){ x(); } } } } } } }"), "long-function");
    lacks(wrap("vote(){ a(); }"), "long-function");
    lacks(wrap("vote(){ if(a){ x(); } else if(b){ y(); } else if(c){ z(); } }"), "long-function");
  });
  it("todo and large-file", () => {
    has(wrap("// TODO later\nvote(){}"), "todo");
    lacks(wrap("vote(){ return 'TODO'; }"), "todo");
    has(wrap("vote(){}\n" + "\n".repeat(1600)), "large-file");
  });
  it("every rule has an id, a group and a one-line description", () => {
    expect(new Set(RULES.map((r) => r.id)).size).to.equal(RULES.length);
    for (const r of RULES) expect(r.about.length, r.id).to.be.greaterThan(5);
  });
  it("--only and --skip choose rules", () => {
    const src = wrap("vote(){ eval(1); console.log(2); }");
    expect(auditSource("c.ts", src, { only: ["no-eval"] }).findings.map((f) => f.rule)).to.deep.equal(["no-eval"]);
    expect(auditSource("c.ts", src, { skip: ["no-eval"] }).findings.map((f) => f.rule)).to.not.include("no-eval");
  });
  it("auditSource reads JavaScript text when given it directly", () => {
    expect(rules("class A extends Standard { vote(){ return eval(x); } }", "c.js")).to.include("no-eval");
  });
});

describe("audit: risk score", () => {
  const f = (severity: any) => ({ file: "x", line: 1, severity, group: "security" as any, rule: "r", message: "", fix: "" });
  it("weights by severity and caps at 100", () => {
    expect(fileScore([f("critical"), f("high"), f("medium"), f("low")])).to.equal(40);
    expect(fileScore(Array.from({ length: 10 }, () => f("critical")))).to.equal(100);
    expect(fileScore([])).to.equal(0);
  });
  it("bands", () => {
    expect([0, 9, 10, 39, 40, 69, 70, 100].map(band)).to.deep.equal(["low", "low", "medium", "medium", "high", "high", "critical", "critical"]);
  });
  it("the blend lets the worst file show and the average count", () => {
    const file = (score: number) => ({ file: "x", findings: [], score, band: band(score) });
    expect(overallScore([]).score).to.equal(0);
    // one bad file in nine clean ones: worst 90, average 9 -> 0.6*90 + 0.4*9 = 57.6
    expect(overallScore([file(90), ...Array.from({ length: 9 }, () => file(0))]).score).to.equal(58);
    // all medium: worst equals average
    expect(overallScore([file(20), file(20)]).score).to.equal(20);
  });
});

describe("audit: duplicates", () => {
  const block = (tag: string) => Array.from({ length: 8 }, (_, i) => `const value${i} = compute(${i}, "fixed");`).join("\n") + `\nconst own = "${tag}";\n`;
  it("finds a block repeated in two files and in one", () => {
    const d = findDuplicates([{ file: "a.ts", text: block("a") }, { file: "b.ts", text: "const first = 1;\n" + block("b") }]);
    expect(d).to.have.length(1);
    expect(d[0].lines).to.be.at.least(8);
    expect(d[0].b.from).to.equal(2);
    const same = findDuplicates([{ file: "a.ts", text: block("a") + "\nconst gap = 1;\nconst gap2 = 2;\n" + block("a2") }]);
    expect(same).to.have.length(1);
  });
  it("ignores comments, blanks and short blocks", () => {
    expect(findDuplicates([{ file: "a.ts", text: "// c\n".repeat(30) }, { file: "b.ts", text: "// c\n".repeat(30) }])).to.have.length(0);
    expect(findDuplicates([{ file: "a.ts", text: "const a = 1;\nconst b = 2;\nconst c = 3;\n" }, { file: "b.ts", text: "const a = 1;\nconst b = 2;\nconst c = 3;\n" }])).to.have.length(0);
  });
});

describe("audit: dependencies", () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel: string, content: string) => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), content));

  it("names the package behind an import and ignores the rest", () => {
    expect(packageOf("lodash/fp")).to.equal("lodash");
    expect(packageOf("@scope/pkg/sub")).to.equal("@scope/pkg");
    expect(["./x", "../y", "/z", "node:fs", "fs", "@activeledger/activecontracts"].map(packageOf)).to.deep.equal([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
  it("reports an advisory against the installed version, and an unpinned declaration", async () => {
    write("package.json", JSON.stringify({ dependencies: { lodash: "^4.17.0", mime: "1.2.3" } }));
    write("node_modules/mime/package.json", JSON.stringify({ version: "1.2.3" }));
    const file = path.join(dir, "c.ts");
    let asked: any;
    const r = await checkDependencies([{ file, imports: [{ name: "lodash", line: 3 }, { name: "mime", line: 4 }, { name: "./local", line: 5 }] }], {
      lookup: async (q) => ((asked = q), { mime: [{ id: 1, url: "https://github.com/advisories/GHSA-abcd", title: "ReDoS", severity: "high", vulnerable_versions: "<1.4.0" }] }),
    });
    expect(asked).to.deep.equal({ lodash: ["4.17.0"], mime: ["1.2.3"] });
    expect(r.findings.map((x) => [x.rule, x.severity, x.line])).to.deep.equal([["unpinned-version", "medium", 3], ["GHSA-abcd", "high", 4]]);
    expect(r.findings[1].message).to.include("mime 1.2.3");
  });
  it("says so when a version cannot be found, and when the registry fails or --offline", async () => {
    const file = path.join(dir, "c.ts");
    const unknown = await checkDependencies([{ file, imports: [{ name: "ghost", line: 1 }] }], { offline: true });
    expect(unknown.findings.map((x) => x.rule)).to.deep.equal(["unknown-version"]);
    write("package.json", JSON.stringify({ dependencies: { a: "1.0.0" } }));
    const off = await checkDependencies([{ file, imports: [{ name: "a", line: 1 }] }], { offline: true });
    expect(off.notes[0]).to.include("--offline");
    const bad = await checkDependencies([{ file, imports: [{ name: "a", line: 1 }] }], { lookup: async () => { throw new Error("registry down"); } });
    expect(bad.notes[0]).to.include("registry down");
    expect(bad.findings).to.have.length(0);
  });
});

describe("audit: files, report and command", () => {
  let dir: string;
  const logs: string[] = [];
  const errs: string[] = [];
  const out = { log: (t: string) => logs.push(t), error: (t: string) => errs.push(t) };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
    logs.length = errs.length = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, content: string) => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), content));

  it("collects source files in order, skipping node_modules, hidden, build output and declarations", () => {
    put("b.ts", ""); put("a.ts", ""); put("sub/c.ts", ""); put("legacy.js", ""); put("m.mjs", ""); put("node_modules/x/i.js", ""); put(".git/h.js", ""); put("lib/o.js", ""); put("t.d.ts", ""); put("readme.md", "");
    const skipped: string[] = [];
    expect(collect(dir, skipped).map((p) => path.relative(dir, p))).to.deep.equal(["a.ts", "b.ts", path.join("sub", "c.ts")]);
    expect(skipped).to.deep.equal(["skipped 2 JavaScript files: contracts are TypeScript"]);
    expect(collect(path.join(dir, "b.ts"))).to.have.length(1);
    const notes: string[] = [];
    expect(collect(path.join(dir, "missing"), notes)).to.deep.equal([]);
    expect(notes[0]).to.include("cannot read");
  });
  it("builds a report with a table per file and a summary", async () => {
    put("bad.ts", wrap("vote(){ return eval(this.x); }"));
    put("good.ts", wrap("vote(){ return true; }"));
    const report = await auditFiles(collect(dir), { offline: true });
    expect(report.files.map((f) => [path.basename(f.file), f.score])).to.deep.equal([["bad.ts", 25 + 0], ["good.ts", 0]]);
    expect(report.counts.critical).to.equal(1);
    const text = render(report, dir);
    expect(text).to.include("bad.ts").and.to.include("Line  Severity").and.to.include("no-eval").and.to.include("(no findings)");
    expect(text).to.include("Overall risk").and.to.include("worst file 25");
  });
  it("the command prints text or JSON and returns the exit code for --fail-on", async () => {
    put("bad.ts", wrap("vote(){ return eval(this.x); }"));
    expect(await auditCommand(dir, { offline: true }, out)).to.equal(0);
    expect(logs[0]).to.include("no-eval");
    expect(await auditCommand(dir, { offline: true, failOn: "high" }, out)).to.equal(1);
    expect(await auditCommand(dir, { offline: true, failOn: "critical", skip: "no-eval" }, out)).to.equal(0);
    logs.length = 0;
    await auditCommand(dir, { offline: true, json: true }, out);
    expect(JSON.parse(logs[0]).counts.critical).to.equal(1);
  });
  it("usage errors return 2 and say why", async () => {
    expect(await auditCommand(undefined, {}, out)).to.equal(2);
    expect(await auditCommand(path.join(dir, "nope"), {}, out)).to.equal(2);
    expect(await auditCommand(dir, {}, out)).to.equal(2); // no source files
    put("a.ts", "");
    expect(await auditCommand(dir, { failOn: "urgent" }, out)).to.equal(2);
    expect(errs.join("\n")).to.include("usage").and.to.include("does not exist").and.to.include("no .ts files").and.to.include("--fail-on");
  });
  it("--rules lists every rule", async () => {
    expect(await auditCommand(undefined, { rules: true }, out)).to.equal(0);
    for (const r of RULES) expect(logs.join("\n")).to.include(r.id);
  });
  it("the dependency lookup runs from the command when online", async () => {
    put("package.json", JSON.stringify({ dependencies: { mime: "1.2.3" } }));
    put("c.ts", wrap("") + `import m from "mime";\n`);
    let called = false;
    await auditCommand(dir, {}, out, async () => ((called = true), {}));
    expect(called).to.equal(true);
  });
});

describe("audit: duplicates in a report, unreadable files and the registry call", () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const block = Array.from({ length: 10 }, (_, i) => `const shared${i} = compute(${i}, "same");`).join("\n");

  it("reports a block repeated between two files on both files and in the duplicate list", async () => {
    fs.writeFileSync(path.join(dir, "a.ts"), wrap(block));
    fs.writeFileSync(path.join(dir, "b.ts"), wrap("// other\n" + block));
    const report = await auditFiles(collect(dir), { offline: true });
    expect(report.duplicates).to.have.length(1);
    expect(report.files.every((f) => f.findings.some((x) => x.rule === "duplicate-code"))).to.equal(true);
    const text = render(report, dir);
    expect(text).to.include("Duplicate code").and.to.include("a.ts").and.to.match(/\(\d+ lines\)/);
  });
  it("notes a file it cannot read and carries on", async () => {
    fs.writeFileSync(path.join(dir, "a.ts"), wrap(""));
    const report = await auditFiles([path.join(dir, "a.ts"), path.join(dir, "gone.ts")], { offline: true });
    expect(report.files).to.have.length(1);
    expect(report.notes.join(" ")).to.include("cannot read").and.to.include("gone.ts");
  });
  it("skips a source file over the size limit with a note", () => {
    fs.writeFileSync(path.join(dir, "big.ts"), "x".repeat(1024 * 1024 + 1));
    const notes: string[] = [];
    expect(collect(dir, notes)).to.deep.equal([]);
    expect(notes[0]).to.include("over");
  });
  it("posts the names and versions to the registry and reads the answer, and fails on an error status", async () => {
    let seen = "";
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = body;
        if (req.url === "/bad") {
          res.statusCode = 500;
          return res.end("no");
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ lodash: [{ id: 1, severity: "high" }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      expect(await lookupAt(base + "/ok", { lodash: ["4.17.15"] })).to.deep.equal({ lodash: [{ id: 1, severity: "high" }] });
      expect(JSON.parse(seen)).to.deep.equal({ lodash: ["4.17.15"] });
      await lookupAt(base + "/bad", {}).then(() => expect.fail("should fail"), (e) => expect(e.message).to.include("500"));
      expect(registryLookup).to.be.a("function");
    } finally {
      server.close();
    }
  });
});
