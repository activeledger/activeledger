import * as ts from "typescript-api";
import { Group, Severity } from "./types";

export interface Ctx {
  sf: ts.SourceFile;
  text: string;
  report(node: ts.Node | number, message: string, fix: string, severity?: Severity): void;
}

export interface Rule {
  id: string;
  group: Group;
  severity: Severity;
  /** One line for `--rules` */
  about: string;
  run(ctx: Ctx): void;
}

const walk = (n: ts.Node, f: (n: ts.Node) => void) => {
  f(n);
  ts.forEachChild(n, (c) => walk(c, f));
};

/** An identifier that is a use of a name, not a property or declaration name */
const isUse = (id: ts.Identifier): boolean => {
  const p: any = id.parent;
  return !(p && p.name === id && !ts.isShorthandPropertyAssignment(p));
};

const calleeName = (call: ts.CallExpression | ts.NewExpression): string => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
};

const strings = (sf: ts.SourceFile, f: (lit: ts.StringLiteralLike) => void) =>
  walk(sf, (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) f(n);
  });

/** This machine by name or address, in the common spellings (the deploy scan reads more of them) */
export const isLocalHost = (host: string): boolean => {
  const h = host.normalize("NFKC").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "0" || h === "2130706433" || /^0x7f/i.test(h);
};

const FORBIDDEN: Record<string, Severity> = {
  process: "critical", global: "critical", globalThis: "critical", module: "high", exports: "high", __dirname: "high", __filename: "high",
  Reflect: "high", Proxy: "high", WebAssembly: "high", SharedArrayBuffer: "high", Atomics: "high",
  setTimeout: "medium", setInterval: "medium", setImmediate: "medium", queueMicrotask: "medium", console: "medium",
};

const CONNECTION_OPTIONS = new Set(["agent", "createConnection", "dispatcher", "lookup", "socketPath", "setHost"]);
const SECRET_NAME = /(secret|passw(or)?d|token|api_?key|private_?key|auth_?key)/i;
const ALLOWED_MODULE = /^@activeledger\/(activetoolkits|activecontracts)(\/|$)/;
const PHASES = new Set(["verify", "vote", "commit"]);

/** The classes a contract extends (Event, PostProcess and PostProcessEvent are all Standard underneath) */
const CONTRACT_BASES = ["Standard", "Event", "PostProcess", "PostProcessEvent"];

const classesExtending = (sf: ts.SourceFile, names: string[]): ts.ClassLikeDeclaration[] => {
  const out: ts.ClassLikeDeclaration[] = [];
  walk(sf, (n) => {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      for (const h of n.heritageClauses || []) {
        if (h.token === ts.SyntaxKind.ExtendsKeyword && h.types.some((t) => names.some((name) => t.expression.getText(sf) === name || t.expression.getText(sf).endsWith("." + name)))) out.push(n);
      }
    }
  });
  return out;
};

const methodName = (m: ts.Node): string => ((m as any).name && ts.isIdentifier((m as any).name) ? (m as any).name.text : "");

/** A body that can end: it has a break, return or throw outside any nested function */
const canLeave = (body: ts.Node): boolean => {
  let found = false;
  const visit = (n: ts.Node, nestedLoop: boolean) => {
    if (found) return;
    if (ts.isFunctionLike(n) && n !== body) return;
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) found = true;
    else if (ts.isBreakStatement(n) && (n.label || !nestedLoop)) found = true;
    const loop = nestedLoop || ts.isIterationStatement(n, false) || ts.isSwitchStatement(n);
    ts.forEachChild(n, (c) => visit(c, loop));
  };
  visit(body, false);
  return found;
};

const isTrue = (e: ts.Expression | undefined): boolean => !e || e.kind === ts.SyntaxKind.TrueKeyword || (ts.isNumericLiteral(e) && Number(e.text) !== 0) || (ts.isParenthesizedExpression(e) && isTrue(e.expression));

export const RULES: Rule[] = [
  {
    id: "no-eval", group: "security", severity: "critical", about: "eval, Function and AsyncFunction calls",
    run({ sf, report }) {
      walk(sf, (n) => {
        if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && ts.isIdentifier(n.expression) && ["eval", "Function", "AsyncFunction", "GeneratorFunction"].includes(n.expression.text)) {
          report(n, `${n.expression.text}() runs text as code`, "Remove it. Parse the data instead of running it.");
        }
      });
    },
  },
  {
    id: "forbidden-global", group: "security", severity: "high", about: "process, global, module, timers and other globals a contract may not use",
    run({ sf, report }) {
      walk(sf, (n) => {
        if (ts.isIdentifier(n) && FORBIDDEN[n.text] && isUse(n)) report(n, `${n.text} is not available to a contract and the node refuses it at deploy`, `Remove the use of ${n.text}.`, FORBIDDEN[n.text]);
      });
    },
  },
  {
    id: "module-use", group: "security", severity: "medium", about: "require/import of anything but the toolkits and contracts packages, and dynamic loading",
    run({ sf, report }) {
      const check = (node: ts.Node, arg: ts.Expression | undefined, how: string) => {
        if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          report(node, `${how} with a name that is not a plain string loads code the audit cannot see`, "Import a fixed module name.", "high");
        } else if (arg.text.startsWith(".") || arg.text.startsWith("/") || arg.text.startsWith("file:")) {
          report(node, `${how} of a local file (${arg.text})`, "Contracts cannot read local files; remove it, or enable allowLocalLibs for the namespace on purpose.", "high");
        } else if (!ALLOWED_MODULE.test(arg.text)) {
          report(node, `${how} of "${arg.text}", which the namespace must list under "external" or "std"`, "Remove it, or list it in the namespace config and keep the version pinned.");
        }
      };
      walk(sf, (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require") check(n, n.arguments[0], "require()");
        else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) check(n, n.arguments[0], "import()");
        else if (ts.isImportDeclaration(n)) check(n, n.moduleSpecifier as ts.Expression, "import");
        else if (ts.isExportDeclaration(n) && n.moduleSpecifier) check(n, n.moduleSpecifier, "export from");
      });
    },
  },
  {
    id: "prototype-access", group: "security", severity: "high", about: "__proto__, constructor and prototype reached by name",
    run({ sf, report }) {
      const bad = new Set(["__proto__", "constructor", "prototype"]);
      walk(sf, (n) => {
        if (ts.isPropertyAccessExpression(n) && bad.has(n.name.text)) {
          if (n.name.text === "prototype" && ts.isIdentifier(n.expression) && /^[A-Z]/.test(n.expression.text)) return; // Array.prototype.slice is ordinary
          report(n, `.${n.name.text} reaches the object's prototype, the usual way out of a sandbox or a pollution bug`, "Use plain property names; copy data with spread or JSON.");
        } else if (ts.isElementAccessExpression(n) && n.argumentExpression && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression)) && bad.has(n.argumentExpression.text)) {
          report(n, `["${n.argumentExpression.text}"] reaches the object's prototype`, "Use plain property names.");
        }
      });
    },
  },
  {
    id: "computed-write", group: "security", severity: "low", about: "obj[key] = value with a key taken from data",
    run({ sf, report }) {
      walk(sf, (n) => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(n.left)) {
          const k = n.left.argumentExpression;
          const named = ts.isIdentifier(k) ? !/^(i|j|n|idx|index|pos)$/.test(k.text) : ts.isPropertyAccessExpression(k);
          if (named) report(n, `writing to [${k.getText(sf)}] with a key that may come from the transaction can set __proto__ or overwrite fields`, "Check the key against a list of allowed names, or use a Map.");
        }
      });
    },
  },
  {
    id: "local-service", group: "security", severity: "high", about: "storage, volatile and loopback addresses, and request options that change the connection (from the storage-guard red-team passes)",
    run({ sf, report }) {
      strings(sf, (lit) => {
        const t = lit.text;
        if (/volatile/i.test(t)) report(lit, `"${t.slice(0, 40)}" names volatile data; contracts reach it only through the stream API`, "Use getVolatile/setVolatile, never a path.");
        const m = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?/i.exec(t);
        if (m && (isLocalHost(m[1]) || m[2] === "5259")) report(lit, `"${t.slice(0, 40)}" is this machine or the storage port`, "A contract cannot reach local services unless the namespace sets allowLocalhost; remove it.");
        else if (/:5259(\/|$)/.test(t)) report(lit, `"${t.slice(0, 40)}" is the storage port`, "Remove it; read ledger data through the contract API.");
      });
      walk(sf, (n) => {
        if (ts.isObjectLiteralExpression(n) && ts.isCallExpression(n.parent)) {
          for (const p of n.properties) {
            const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "";
            if (CONNECTION_OPTIONS.has(name)) report(p, `the request option "${name}" changes how the connection is made and is refused at run time`, `Remove "${name}".`);
          }
        }
      });
    },
  },
  {
    id: "hardcoded-secret", group: "security", severity: "high", about: "keys, tokens and passwords written into the source",
    run({ sf, report }) {
      strings(sf, (lit) => {
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(lit.text)) report(lit, "a private key is written in the source", "Remove it and rotate the key; it is now in every copy of the contract.", "critical");
      });
      walk(sf, (n) => {
        let name = "";
        let init: ts.Expression | undefined;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) (name = n.name.text), (init = n.initializer);
        else if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) (name = n.name.text), (init = n.initializer);
        else if (ts.isPropertyDeclaration(n) && ts.isIdentifier(n.name)) (name = n.name.text), (init = n.initializer);
        if (name && init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) && init.text.length >= 8 && SECRET_NAME.test(name) && !/^(your|change|example|<|\$\{)/i.test(init.text)) {
          report(n, `"${name}" holds a literal value that looks like a secret`, "Keep secrets out of contract source; pass them in the transaction or the namespace config.");
        }
      });
    },
  },
  {
    id: "weak-crypto", group: "security", severity: "medium", about: "md5 and sha1, Math.random for anything but a toy",
    run({ sf, report }) {
      walk(sf, (n) => {
        if (ts.isCallExpression(n) && calleeName(n) === "createHash" && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && /^(md5|sha1|md4)$/i.test(n.arguments[0].text)) {
          report(n, `${n.arguments[0].text} is broken for security uses`, "Use sha256 or better.");
        }
      });
    },
  },
  {
    id: "nondeterministic", group: "contract", severity: "high", about: "time and randomness inside verify, vote and commit (nodes would disagree)",
    run({ sf, report }) {
      for (const cls of classesExtending(sf, CONTRACT_BASES)) {
        for (const m of cls.members) {
          if (!PHASES.has(methodName(m))) continue;
          // Values handed to setThisInterNodeComms are meant to differ per node
          const inComms = (n: ts.Node): boolean => {
            for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && calleeName(p) === "setThisInterNodeComms") return true;
            return false;
          };
          walk(m, (n) => {
            if (inComms(n)) return;
            if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === "Date" && !(n.arguments && n.arguments.length)) report(n, `the current time in ${methodName(m)}() differs on each node`, "Take the time from the transaction ($datetime) instead.");
            else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && ((n.expression.text === "Date" && n.name.text === "now") || (n.expression.text === "Math" && n.name.text === "random"))) report(n, `${n.expression.text}.${n.name.text} in ${methodName(m)}() gives each node a different answer`, "Derive the value from the transaction so every node computes the same one.");
          });
        }
      }
    },
  },
  {
    id: "contract-shape", group: "contract", severity: "medium", about: "a file with no class extending Standard, or a vote that returns leader without saying how it is used",
    run({ sf, report, text }) {
      if (!classesExtending(sf, CONTRACT_BASES).length) report(1, "no class extends Standard (or Event, PostProcess), so the node will not run this as a contract", "Export a class that extends Standard and implements verify, vote and commit.");
      for (const cls of classesExtending(sf, CONTRACT_BASES)) {
        for (const m of cls.members) {
          if (methodName(m) !== "vote") continue;
          walk(m, (n) => {
            if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "leader" && n.initializer.kind === ts.SyntaxKind.TrueKeyword) report(n, "vote returns { leader: true }: it only takes effect when the transaction sets $tx.$leader and the stream's owner node leads it", "Check the contract's callers set $tx.$leader; otherwise this is a plain yes.", "low");
          });
        }
      }
    },
  },
  {
    id: "unbounded-loop", group: "contract", severity: "high", about: "while(true) and for(;;) with no way out",
    run({ sf, report }) {
      walk(sf, (n) => {
        if (ts.isWhileStatement(n) && isTrue(n.expression) && !canLeave(n.statement)) report(n, "a loop that never ends hangs the vote on every node", "Add a bound or a break.");
        else if (ts.isDoStatement(n) && isTrue(n.expression) && !canLeave(n.statement)) report(n, "a loop that never ends hangs the vote on every node", "Add a bound or a break.");
        else if (ts.isForStatement(n) && isTrue(n.condition) && !canLeave(n.statement)) report(n, "a loop that never ends hangs the vote on every node", "Add a bound or a break.");
      });
    },
  },
  {
    id: "swallowed-error", group: "best-practice", severity: "medium", about: "empty catch blocks and .catch(() => {})",
    run({ sf, report }) {
      walk(sf, (n) => {
        if (ts.isCatchClause(n) && n.block.statements.length === 0) report(n, "an empty catch hides the failure", "Reject with the error, or handle it.");
        else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "catch" && n.arguments[0] && (ts.isArrowFunction(n.arguments[0]) || ts.isFunctionExpression(n.arguments[0]))) {
          const f = n.arguments[0] as ts.ArrowFunction | ts.FunctionExpression;
          if (ts.isBlock(f.body) && f.body.statements.length === 0) report(n, ".catch with an empty handler hides the failure", "Reject with the error, or handle it.");
        }
      });
    },
  },
  {
    id: "long-function", group: "best-practice", severity: "low", about: "functions over 80 lines or nested more than 5 deep",
    run({ sf, report }) {
      walk(sf, (n) => {
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body)) {
          const a = sf.getLineAndCharacterOfPosition(n.body.getStart(sf)).line;
          const b = sf.getLineAndCharacterOfPosition(n.body.getEnd()).line;
          if (b - a > 80) report(n, `a function of ${b - a} lines is hard to review`, "Split it into named steps.");
        }
      });
      const deep = (n: ts.Node, depth: number): void => {
        const nest = ts.isIfStatement(n) || ts.isIterationStatement(n, false) || ts.isSwitchStatement(n) || ts.isTryStatement(n);
        const d = nest && !(ts.isIfStatement(n) && ts.isIfStatement(n.parent) && (n.parent as ts.IfStatement).elseStatement === n) ? depth + 1 : depth;
        if (nest && d === 6) report(n, "code nested more than 5 deep", "Return early or move the inner part into a function.");
        ts.forEachChild(n, (c) => deep(c, ts.isFunctionLike(c) ? 0 : d));
      };
      deep(sf, 0);
    },
  },
  {
    id: "todo", group: "hygiene", severity: "low", about: "TODO, FIXME and HACK left in comments",
    run({ text, report }) {
      text.split("\n").forEach((l, i) => {
        if (/(\/\/|\/\*|^\s*\*).*\b(TODO|FIXME|HACK|XXX)\b/.test(l)) report(i + 1, "an unfinished note is left in the source", "Finish it or remove it.");
      });
    },
  },
  {
    id: "large-file", group: "hygiene", severity: "low", about: "files over 1500 lines",
    run({ text, report }) {
      const n = text.split("\n").length;
      if (n > 1500) report(1, `${n} lines in one file`, "Split it.");
    },
  },
];
