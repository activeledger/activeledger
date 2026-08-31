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

import * as fs from "fs";
import * as ts from "typescript";
import { Standard, Activity } from "@activeledger/activecontracts";
import { ActiveOptions } from "@activeledger/activeoptions";

// Read-only security denylists used by securityScan() below. Unlike
// allowedModules/policy (which get extended per-call from namespace
// config), these three are never mutated - only ever looked up via
// indexOf() - so they're safe to build once at module load instead of
// on every single contract deploy/update.

// Definitive denylist for identifiers (Globals and sensitive objects)
const BANNED_IDENTIFIERS = [
  "process",
  "global",
  "globalThis",
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "atob",
  "btoa",
  "Reflect",
  "Proxy",
  "WebAssembly",
  "Symbol",
  "arguments",
  "caller",
  "callee",
  "console",
  "debugger",
  "fetch",
  "SharedArrayBuffer",
  "Atomics",
  "performance",
  "Performance",
  "Intl",
  "FinalizationRegistry",
  "WeakRef",
  "gc",
  "v8",
  "vm",
  "worker_threads",
  "cluster",
  "child_process",
  "os",
  "path",
  "fs",
  "http",
  "https",
  "net",
  "tls",
  "crypto",
  "root",
  "window",
  "top",
  "stop",
  "close",
  "InternalError",
];

// Identifiers that can be used but not reassigned or shadowed
const PROTECTED_IDENTIFIERS = [
  "ActiveLogger",
  "ActiveRequest",
  "ActiveCrypto",
  "ActiveOptions",
  "ActiveDefinitions",
  "ActiveGZip",
  "Standard",
  "Activity",
  "ActivityStream",
  "EventEngine",
  "PostProcessQueryEvent",
  "Math",
  "Date",
  "JSON",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Error",
  "Promise",
  "Buffer",
  "Map",
  "Set",
  "Uint8Array",
  "BigInt",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "self",
];

// Definitive denylist for property access (Reflection and System methods)
const BANNED_PROPERTIES = [
  "exit",
  "kill",
  "spawn",
  "fork",
  "exec",
  "readFile",
  "writeFile",
  "unlink",
  "rmdir",
  "mkdir",
  "appendFile",
  "readdir",
  "stat",
  "lstat",
  // Sync counterparts of the fs methods above - originally missing
  // entirely, which meant a module reachable only through the also-fixed
  // ImportEqualsDeclaration/ExportDeclaration gaps (see checkNode()'s
  // module-loading checks) could still call e.g. readFileSync freely even
  // once module-loading itself was locked down. Kept as defense-in-depth
  // for any future path that lets a real fs-like object reach here.
  "readFileSync",
  "writeFileSync",
  "unlinkSync",
  "rmdirSync",
  "rmSync",
  "mkdirSync",
  "appendFileSync",
  "readdirSync",
  "statSync",
  "lstatSync",
  "existsSync",
  "realpathSync",
  "copyFileSync",
  "renameSync",
  "cpSync",
  "chmodSync",
  "chownSync",
  "symlinkSync",
  "linkSync",
  "truncateSync",
  "opendirSync",
  "watchFile",
  "unwatchFile",
  "execSync",
  "execFileSync",
  "spawnSync",
  "constructor",
  "__proto__",
  "prototype",
  "defineProperty",
  "defineProperties",
  "setPrototypeOf",
  "getPrototypeOf",
  "assign",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "binding",
  "internalBinding",
  "allocUnsafe",
  "bind",
  "call",
  "apply",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "preventExtensions",
  "isExtensible",
  "seal",
  "isSealed",
  "freeze",
  "isFrozen",
  "toSource",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "captureStackTrace",
  "stackTraceLimit",
  "stack",
  "fileName",
  "lineNumber",
  "columnNumber",
  "__count__",
  "__noSuchMethod__",
  "__parent__",
  "eval",
  "Function",
  "global",
  "globalThis",
  "process",
  "module",
  "require",
];
// Set for O(1) lookup instead of Array.indexOf()'s O(n) scan - this list
// has grown to ~50 entries and is checked at several points per AST node
// walked during securityScan().
const BANNED_PROPERTIES_SET = new Set(BANNED_PROPERTIES);

/**
 * Default Onboarding (New Account) contract
 *
 * @export
 * @class Onboard
 * @extends {Standard}
 */
export default class Contract extends Standard {
  /**
   * Requested Contract Name
   *
   * @private
   * @type string
   */
  private name: string;

  /**
   * Requested Namespace
   *
   * @private
   * @type string
   */
  private namespace: string;

  /**
   * Requested Contract File
   *
   * @private
   * @type string
   */
  private contract: string;

  /**
   * Requested Link File
   *
   * @private
   * @type string
   */
  private link: string;

  /**
   * Requested Version File
   *
   * @private
   * @type string
   */
  private version: string = "";

  /**
   * Reference input stream name
   *
   * @private
   * @type {string}
   */
  private identity: Activity;

  /**
   * The Root for contract files
   *
   * @type {string}
   */
  readonly rootDir: string = "./contracts/";

  /**
   * Quick Check, Allow all data but make sure it is signatureless
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   */
  public verify(signatureless: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Get Stream id
      let stream = Object.keys(this.transactions.$i)[0];

      // Get Stream Activity
      this.identity = this.getActivityStreams(stream);
      if (!signatureless) {
        // Need Version
        if (
          typeof this.transactions.$i[this.identity.getName()].version ==
            "string" ||
          (this.transactions.$entry &&
            this.transactions.$entry.indexOf("link") !== -1)
        ) {
          resolve(true);
        } else {
          reject("No Version Found");
        }
      } else {
        reject("Signatures Needed");
      }
    });
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   */
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      switch (this.transactions.$entry) {
        case "update":
          this.voteUpdate(resolve, reject);
          break;
        case "link":
          this.voteLink(resolve, reject);
          break;
        case "unlink":
          this.voteUnlink(resolve, reject);
          break;
        case "lock":
          this.voteLock(resolve, reject);
          break;
        case "unlock":
          this.voteUnlock(resolve, reject);
          break;
        default:
          this.voteAdd(resolve, reject);
          break;
      }
    });
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   */
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      switch (this.transactions.$entry) {
        case "update":
          this.commitUpdate(resolve, reject);
          break;
        case "link":
          this.commitLink(resolve, reject);
          break;
        case "unlink":
          this.commitUnlink(resolve, reject);
          break;
        case "lock":
          this.commitLock(resolve, reject);
          break;
        case "unlock":
          this.commitUnlock(resolve, reject);
          break;
        default:
          this.commitAdd(resolve, reject);
          break;
      }
    });
  }

  /**
   * Transpile Typescript to Javascript
   *
   * @private
   * @returns {string}
   */
  private transpile(): string {
    // Base64 Decode & Transpile to javascript
    return ts.transpileModule(
      Buffer.from(
        this.transactions.$i[this.identity.getName()].contract as string,
        "base64"
      ).toString(),
      {
        compilerOptions: {
          alwaysStrict: true,
          strictNullChecks: true,
          noImplicitAny: true,
          removeComments: true,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.Classic,
          target: ts.ScriptTarget.ES2017,
        },
      }
    ).outputText;
  }

  /**
   * Scan TypeScript source for security violations
   *
   * @private
   * @param {string} sourceCode
   * @param {string} namespace
   */
  private securityScan(sourceCode: string, namespace: string): void {
    // Allowed modules for require/import
    const allowedModules: string[] = ["@activeledger/activetoolkits", "@activeledger/activecontracts"];
    const policy = {
        allowDynamicAccess: false,
        allowRequire: false,
        allowEval: false,
        allowComputedProperties: false,
        allowProcessNextTick: false,
        allowLocalLibs: false
    };

    // Fetch dynamic security configuration
    const securityConfig = ActiveOptions.get<any>("security", { namespace: {} });
    if (securityConfig && securityConfig.namespace && securityConfig.namespace[namespace]) {
        const nsConfig = securityConfig.namespace[namespace];
        if (nsConfig.std) allowedModules.push(...nsConfig.std);
        if (nsConfig.external) allowedModules.push(...nsConfig.external);
        if (nsConfig.policy) Object.assign(policy, nsConfig.policy);
    }

    // Skip scan for privileged namespaces?
    const privilegedNamespaces = ["default"];
    if (privilegedNamespaces.indexOf(namespace) !== -1) {
      return;
    }

    const sourceFile = ts.createSourceFile(
      "contract.ts",
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    );

    /**
     * Helper to report security violations with line numbers
     */
    const report = (node: ts.Node, message: string): never => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart()
      );
      throw new Error(
        `Security Violation [${line + 1}:${character + 1}]: ${message}`
      );
    };

    /**
     * A same-namespace sibling file reference (e.g. "./mylib@1.0.0"), never
     * one that climbs out of the namespace's own directory. require()/import
     * resolve relative paths lexically against wherever this contract file
     * ends up living on disk - always its own namespace's directory - so
     * rejecting any ".." path segment is sufficient to keep this contained
     * to that one directory, however deep the traversal attempt nests it
     * (e.g. "./a/../../escape" still contains a literal ".." segment).
     */
    const isLocalLibSpecifier = (spec: string): boolean =>
      spec.startsWith("./") && !spec.split("/").includes("..");

    /**
     * Single source of truth for "is this module specifier permitted",
     * shared by every AST shape that can load a module (plain require(),
     * import ... from, TypeScript's import x = require(...), and
     * export ... from re-exports) - see checkNode()'s module-loading
     * checks below for why all four need this, not just the two that
     * were originally covered.
     */
    const isModuleAllowed = (spec: string): boolean =>
      allowedModules.indexOf(spec) !== -1 ||
      (policy.allowLocalLibs && isLocalLibSpecifier(spec));

    /**
     * A module specifier is only ever legitimately a string literal or a
     * no-substitution template literal (`fs` with no ${}) - both resolve
     * to a fixed, known-at-scan-time value. Anything else (an identifier,
     * a real template expression, a call, etc.) can't be resolved
     * statically and must be rejected outright by the caller, not
     * silently ignored - a backtick literal in place of quotes was a real
     * bypass of every module-loading check below before this existed,
     * since each only ever tested ts.isStringLiteral.
     */
    const resolveModuleSpecifierText = (expr: ts.Expression): string | null =>
      ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)
        ? expr.text
        : null;

    /**
     * Helper to unwrap parenthesized or cast expressions
     */
    const unwrap = (node: ts.Expression): ts.Expression => {
      while (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node)
      ) {
        node = node.expression;
      }
      return node;
    };

    const checkNode = (node: ts.Node): void => {
      // Helper to detect if an identifier is being written to or shadowed
      const isWriteAccess = (node: ts.Node): boolean => {
        const parent = node.parent;
        if (!parent) return false;

        // Allow Import Declarations
        if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportDeclaration(parent)) return false;

        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          parent.left === node
        )
          return true;
        if (
          ts.isPrefixUnaryExpression(parent) &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken ||
            parent.operator === ts.SyntaxKind.MinusMinusToken)
        )
          return true;
        if (ts.isPostfixUnaryExpression(parent)) return true;
        if (ts.isVariableDeclaration(parent) && parent.name === node)
          return true;
        if (ts.isFunctionDeclaration(parent) && parent.name === node)
          return true;
        if (ts.isClassDeclaration(parent) && parent.name === node) return true;
        if (ts.isBindingElement(parent) && parent.name === node) return true;

        if (
          (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
          parent.initializer === node
        )
          return true;

        return false;
      };

      // Helper to check if an expression is accessing 'this'
      const isThisAccess = (expr: ts.Expression): boolean => {
          const unwrapped = unwrap(expr);
          if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) return true;
          if (ts.isPropertyAccessExpression(unwrapped)) return isThisAccess(unwrapped.expression);
          return false;
      };

      // 1. Block Banned Identifiers or Protected Shadows
      if (ts.isIdentifier(node)) {
        if (node.text === "require") {
          const parent = node.parent;
          if (!ts.isCallExpression(parent) || parent.expression !== node) {
            report(node, `Unauthorized use of 'require' identifier`);
          }
        }
        // Special Handling for Process
        if (node.text === "process") {
             if (ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === "nextTick" && policy.allowProcessNextTick) {
                 // Safe, allow access
             } else {
                 report(node, `Unauthorized use of 'process' global`);
             }
             // Skip further checks for process
             return;
        }
        if (BANNED_IDENTIFIERS.indexOf(node.text) !== -1) {
            // Allow if part of a property access (e.g. this.setTimeout)
            if (!(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
                report(node, `Unauthorized identifier '${node.text}'`);
            }
        }
        if (
          PROTECTED_IDENTIFIERS.indexOf(node.text) !== -1 &&
          isWriteAccess(node)
        ) {
          report(
            node,
            `Unauthorized modification of protected identifier '${node.text}'`
          );
        }
      }

      // 2. Block Banned Properties (Direct access)
      if (ts.isPropertyAccessExpression(node)) {
        if (
          ts.isIdentifier(node.name) &&
          BANNED_PROPERTIES_SET.has(node.name.text)
        ) {
          // Allow access if it is on 'this'
          if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
            // Safe, continue
          } else {
            report(node.name, `Unauthorized property access '${node.name.text}'`);
          }
        }
        const unwrappedExpr = unwrap(node.expression);

        if (
          ts.isIdentifier(unwrappedExpr) &&
          PROTECTED_IDENTIFIERS.indexOf(unwrappedExpr.text) !== -1 &&
          isWriteAccess(node)
        ) {
          report(
            node,
            `Unauthorized modification of protected object '${unwrappedExpr.text}'`
          );
        }
      }

      // 3. Block Banned Properties (Bracket access)
      if (ts.isElementAccessExpression(node)) {
        let key = "";
        let dynamicAccess = false;
        const unwrappedExpr = unwrap(node.expression);
        
        if (ts.isStringLiteral(node.argumentExpression)) {
          key = node.argumentExpression.text;
        } else if (
          ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)
        ) {
          key = node.argumentExpression.text;
        } else if (ts.isTemplateExpression(node.argumentExpression) || ts.isIdentifier(node.argumentExpression)) {
            dynamicAccess = true;
        } else if (ts.isNumericLiteral(node.argumentExpression)) {
        } else {
          // If we don't know the key, it's dynamic
          dynamicAccess = true;
        }

        // A resolved literal key (obj["constructor"]) is semantically the
        // same as dot notation (obj.constructor) and must be checked the
        // same way, unconditionally - NOT nested inside the dynamicAccess
        // branch below. It never was: dynamicAccess is only ever true for
        // an *unresolvable* key, so a literal-string banned key silently
        // skipped this whole check entirely, on any object, this or not.
        // Confirmed live: ({})["constructor"]["constructor"]("return
        // process")() passed this scan with zero violations - a complete,
        // classic Function-constructor sandbox escape needing no module
        // access at all. Uses the same narrow direct-`this` exemption rule
        // 2 (dot notation) uses (`this.constructor` allowed, but not a
        // chain through it) - not the broader recursive isThisAccess()
        // below, which trusts an entire this.a.b.c chain and would still
        // let a second hop like this.constructor["constructor"] through.
        if (!dynamicAccess && key && BANNED_PROPERTIES_SET.has(key)) {
          if (node.expression.kind !== ts.SyntaxKind.ThisKeyword) {
            report(node.argumentExpression, `Unauthorized element access '${key}'`);
          }
        }

        // Always allow dynamic access on 'this' properties
        if (isThisAccess(node.expression)) {
            // Continue
        } else {
            // Check for trusted objects defined in configuration
            //const objectName = ts.isIdentifier(unwrappedExpr) ? unwrappedExpr.text : "";

            if (policy.allowDynamicAccess) {
                // Allow, it's a known safe object and dynamic access is enabled for it
            } else {
                // Block all other dynamic accesses unless they are demonstrably safe
                if (dynamicAccess) {
                    // If the key is entirely dynamic (unresolvable), block it for non-this
                    report(node, `Dynamic element access is forbidden`);
                }
            }
        }

        if (
          ts.isIdentifier(unwrappedExpr) &&
          PROTECTED_IDENTIFIERS.indexOf(unwrappedExpr.text) !== -1 &&
          isWriteAccess(node)
        ) {
          report(
            node,
            `Unauthorized modification of protected object '${unwrappedExpr.text}'`
          );
        }
      }

      // 4. Block Banned Properties in Destructuring (const { exit } = obj)
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
        // A computed key (const { ["constructor"]: c } = obj) previously
        // fell through to "" here (not a plain Identifier) and was also
        // explicitly allowed by rule 5 below since it's a string literal -
        // resolve it the same way a plain `propertyName` identifier would
        // be, closing that gap.
        let propertyName = "";
        if (!node.propertyName) {
          propertyName = node.name.text;
        } else if (ts.isIdentifier(node.propertyName)) {
          propertyName = node.propertyName.text;
        } else if (
          ts.isComputedPropertyName(node.propertyName) &&
          (ts.isStringLiteral(node.propertyName.expression) ||
            ts.isNoSubstitutionTemplateLiteral(node.propertyName.expression))
        ) {
          propertyName = node.propertyName.expression.text;
        }
        if (propertyName && BANNED_PROPERTIES_SET.has(propertyName)) {
          report(node, `Unauthorized destructuring of property '${propertyName}'`);
        }
      }

      // 5. Block Meta-Programming & Introspection Nodes
      if (ts.isComputedPropertyName(node)) {
        if (!policy.allowComputedProperties && !ts.isStringLiteral(node.expression) && !ts.isNumericLiteral(node.expression)) {
          report(node, `Dynamic computed property names are forbidden`);
        }
      }
      if (ts.isDecorator(node)) {
        report(node, `Decorators are forbidden`);
      }
      if (ts.isTaggedTemplateExpression(node)) {
        report(node, `Tagged template expressions are forbidden`);
      }
      if (ts.isMetaProperty(node)) {
        report(node, `Meta properties are forbidden`);
      }
      if (ts.isPrivateIdentifier(node)) {
        report(node, `Private identifiers are forbidden`);
      }

      // 6. Block Module Loading
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const arg = node.arguments[0];
        const spec = arg ? resolveModuleSpecifierText(arg) : null;
        if (spec === null) {
          report(node, `Dynamic require is forbidden`);
        } else if (!isModuleAllowed(spec)) {
          report(node, `Module '${spec}' is not on the allow-list`);
        }
      }
      // Every one of these four module-loading shapes must resolve to a
      // real literal (string or no-substitution template) or be rejected
      // outright - no silent "didn't recognise this node shape, so do
      // nothing" fallthrough. That fallthrough is exactly how a backtick
      // instead of quotes (`import x = require(\`fs\`)`, even plain
      // `import x from \`fs\`;`) bypassed every one of these checks before
      // this fix - each only ever tested ts.isStringLiteral.
      if (ts.isImportDeclaration(node)) {
        const spec = resolveModuleSpecifierText(node.moduleSpecifier);
        if (spec === null) {
          report(node, `Dynamic import specifier is forbidden`);
        } else if (!isModuleAllowed(spec)) {
          report(node, `Import of module '${spec}' is forbidden`);
        }
      }
      // TypeScript's `import x = require("y")` legacy syntax is a distinct
      // ImportEqualsDeclaration/ExternalModuleReference node, not a
      // CallExpression or ImportDeclaration - neither of the two checks
      // above ever saw it, so it was a complete, silent bypass of the
      // module allow-list (confirmed live: `import fs = require("fs")`
      // passed the scan and could then read real files at runtime).
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const spec = resolveModuleSpecifierText(node.moduleReference.expression);
        if (spec === null) {
          report(node, `Dynamic import specifier is forbidden`);
        } else if (!isModuleAllowed(spec)) {
          report(node, `Module '${spec}' is not on the allow-list`);
        }
      }
      // `export ... from "y"` (ExportDeclaration with a moduleSpecifier) is
      // also a distinct node from ImportDeclaration and was equally
      // unchecked - lower severity since a re-export alone doesn't bind a
      // usable local name in the same file, but still real module loading
      // that should be gated the same way.
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const spec = resolveModuleSpecifierText(node.moduleSpecifier);
        if (spec === null) {
          report(node, `Dynamic re-export specifier is forbidden`);
        } else if (!isModuleAllowed(spec)) {
          report(node, `Re-export of module '${spec}' is forbidden`);
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        report(node, `Dynamic import() is forbidden`);
      }

      // 7. Residual Safety
      if (ts.isDebuggerStatement(node)) {
        report(node, `debugger statements are forbidden`);
      }
      if (ts.isDeleteExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (BANNED_PROPERTIES_SET.has(node.expression.name.text)) {
           report(node.expression.name, `Unauthorized deletion of property '${node.expression.name.text}'`);
        }
      }

      ts.forEachChild(node, checkNode);
    };

    checkNode(sourceFile);
  }

  /**
   * Are we allowed to create a link?
   *
   * @returns {Promise<boolean>}
   */
  public voteLock(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // Get namespace and set to lowercase
    this.namespace = (
      this.transactions.$i[stream].namespace as string
    ).toLowerCase();

    // Get Contract
    this.contract = (
      this.transactions.$i[stream].contract as string
    ).toLowerCase();

    // Get Version Name
    if (this.transactions.$i[stream].version) {
      this.version =
        "@" + (this.transactions.$i[stream].version as string).toLowerCase();
    }

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      // Does the Contract File exist?
      if (
        fs.existsSync(
          this.rootDir + this.namespace + "/" + this.contract + ".js"
        )
      ) {
        // Does the Link file not exist!
        if (
          !fs.existsSync(
            this.rootDir +
              this.namespace +
              "/_LOCK." +
              this.contract +
              this.version
          )
        ) {
          return resolve(true);
        } else {
          return reject("Lock already exists");
        }
      } else {
        return reject("Contract not found in namespace");
      }
    }
    return reject("Invalid Namespace");
  }

  /**
   * Are we allowed to remove a link?
   *
   * @returns {Promise<boolean>}
   */
  public voteUnlock(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // Get namespace and set to lowercase
    this.namespace = (
      this.transactions.$i[stream].namespace as string
    ).toLowerCase();

    // Get Contract
    this.contract = (
      this.transactions.$i[stream].contract as string
    ).toLowerCase();

    // Get Version Name
    if (this.transactions.$i[stream].version) {
      this.version =
        "@" + (this.transactions.$i[stream].version as string).toLowerCase();
    }

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      // Does the Link file exist!
      if (
        fs.existsSync(
          this.rootDir +
            this.namespace +
            "/_LOCK." +
            this.contract +
            this.version
        )
      ) {
        return resolve(true);
      } else {
        return reject("Lock doesn't exists");
      }
    }
    return reject("Invalid Namespace");
  }

  /**
   * Create the symlink to the contract
   *
   * @returns {Promise<any>}
   */
  public commitLock(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Create File
    fs.closeSync(
      fs.openSync(
        this.rootDir +
          this.namespace +
          "/_LOCK." +
          this.contract +
          this.version,
        "w"
      )
    );
    resolve(true);
  }

  /**
   * Removes the symlink to the contract
   *
   * @returns {Promise<any>}
   */
  public commitUnlock(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Remove File
    fs.unlinkSync(
      this.rootDir + this.namespace + "/_LOCK." + this.contract + this.version
    );

    resolve(true);
  }

  /**
   * Are we allowed to create a link?
   *
   * @returns {Promise<boolean>}
   */
  public voteLink(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // Get namespace and set to lowercase
    this.namespace = (
      this.transactions.$i[stream].namespace as string
    ).toLowerCase();

    // Get Contract
    this.contract = (
      this.transactions.$i[stream].contract as string
    ).toLowerCase();

    // Get Link Name
    this.link = (this.transactions.$i[stream].link as string).toLowerCase();

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      // Does the Contract File exist?
      if (
        fs.existsSync(
          this.rootDir + this.namespace + "/" + this.contract + ".js"
        )
      ) {
        // Does the Link file not exist!
        if (
          !fs.existsSync(
            this.rootDir + this.namespace + "/" + this.link + ".js"
          )
        ) {
          return resolve(true);
        } else {
          return reject("Link already exists");
        }
      } else {
        return reject("Contract not found in namespace");
      }
    }
    return reject("Invalid Namespace");
  }

  /**
   * Are we allowed to remove a link?
   *
   * @returns {Promise<boolean>}
   */
  public voteUnlink(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // Get namespace and set to lowercase
    this.namespace = (
      this.transactions.$i[stream].namespace as string
    ).toLowerCase();

    // Get Contract
    this.contract = (
      this.transactions.$i[stream].contract as string
    ).toLowerCase();

    // Get Link Name
    this.link = (this.transactions.$i[stream].link as string).toLowerCase();

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      // Does the Link file exist!
      if (
        fs.existsSync(this.rootDir + this.namespace + "/" + this.link + ".js")
      ) {
        return resolve(true);
      } else {
        return reject("Link doesn't exists");
      }
    }
    return reject("Invalid Namespace");
  }

  /**
   * Create the symlink to the contract
   *
   * @returns {Promise<any>}
   */
  public commitLink(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Create Symlink
    fs.symlinkSync(
      `${this.contract}.js`,
      `${this.rootDir}${this.namespace}/${this.link}.js`,
      "file"
    );

    resolve(true);
  }

  /**
   * Removes the symlink to the contract
   *
   * @returns {Promise<any>}
   */
  public commitUnlink(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Create Symlink
    fs.unlinkSync(`${this.rootDir}${this.namespace}/${this.link}.js`);

    resolve(true);
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   */
  public voteAdd(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // TODO : Verify Contract Doesn't Exist

    // Get namespace and set to lowercase
    this.namespace = (
      this.transactions.$i[stream].namespace as string
    ).toLowerCase();

    // Get name as lowercase
    this.name = (this.transactions.$i[stream].name as string).toLowerCase();

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      try {
        // Security Scan
        this.securityScan(
          Buffer.from(
            this.transactions.$i[this.identity.getName()].contract as string,
            "base64"
          ).toString(),
          this.namespace
        );
        resolve(true);
      } catch (e) {
        reject(e.message);
      }
    } else {
        return reject("Invalid Namespace");
    }
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   */
  public commitAdd(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Check Namespace folder exists, Make if it doesn't
    if (!fs.existsSync(this.rootDir + this.namespace))
      fs.mkdirSync(this.rootDir + this.namespace);

    // Transaction Inputs
    let txi = this.transactions.$i[this.identity.getName()];

    // Get Executable contract code
    let code = this.transpile();

    // Get new stream to hold this contract
    let stream = this.newActivityStream(
      `contract.${this.namespace}.${this.name}@${txi.version}`
    );

    // Get Stream state to manipulate
    let state = stream.getState();

    // Set Signing Authority
    stream.setAuthority(this.identity.getName());

    // Add Contract details
    state.name = this.name;
    state.namespace = this.namespace;

    // Version Management
    state.contract = {};
    state.contract[txi.version] = txi.contract;

    // Compiled Management
    state.compiled = {};
    state.compiled[txi.version] = stream.getName();

    // Write the contract to its location as latest (Using its stream name)
    fs.writeFileSync(
      `${this.rootDir}${this.namespace}/${stream.getName()}.js`,
      code
    );

    // Write the contract to its location as a version (Using its stream name)
    fs.writeFileSync(
      `${this.rootDir}${this.namespace}/${stream.getName()}@${txi.version}.js`,
      code
    );

    // Save State
    stream.setState(state);

    resolve(true);
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   */
  public voteUpdate(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // TODO : Verify Version doesn't exist

    // Get namespace and set to lowercase
    this.namespace = (
      this.transactions.$i[stream].namespace as string
    ).toLowerCase();

    // Get name as lowercase
    this.name = (this.transactions.$i[stream].name as string).toLowerCase();

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      try {
        // Security Scan
        this.securityScan(
          Buffer.from(
            this.transactions.$i[this.identity.getName()].contract as string,
            "base64"
          ).toString(),
          this.namespace
        );
        resolve(true);
      } catch (e) {
        reject(e.message);
      }
    } else {
        return reject("Invalid Namespace");
    }
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   */
  public commitUpdate(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Transaction Inputs
    let txi = this.transactions.$i[this.identity.getName()];

    // Get Output id
    let output = Object.keys(this.transactions.$o)[0];

    // Get Stream Activity
    let stream = this.getActivityStreams(output);

    // Get Executable contract code
    let code = this.transpile();

    // Get Stream state to manipulate
    let state = stream.getState();

    // Version Management
    state.contract[txi.version] = txi.contract;

    // Compiled Management
    state.compiled[txi.version] = stream.getName();

    // Write the contract to its location as latest (Using its stream name)
    fs.writeFileSync(
      `${this.rootDir}${this.namespace}/${stream.getName()}.js`,
      code
    );

    // Write the contract to its location (Using its stream name)
    fs.writeFileSync(
      `${this.rootDir}${this.namespace}/${stream.getName()}@${txi.version}.js`,
      code
    );

    // Save State
    stream.setState(state);

    resolve(true);
  }
}
