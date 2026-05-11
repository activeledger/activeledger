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
    // Definitive denylist for identifiers (Globals and sensitive objects)
    const bannedIdentifiers = [
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
    const protectedIdentifiers = [
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
    const bannedProperties = [
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

    // Allowed modules for require/import
    const allowedModules: string[] = ["@activeledger/activetoolkits", "@activeledger/activecontracts"];
    const policy = {
        allowDynamicAccess: false,
        allowRequire: false,
        allowEval: false,
        allowComputedProperties: false,
        allowProcessNextTick: false
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
        if (bannedIdentifiers.indexOf(node.text) !== -1) {
            // Allow if part of a property access (e.g. this.setTimeout)
            if (!(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
                report(node, `Unauthorized identifier '${node.text}'`);
            }
        }
        if (
          protectedIdentifiers.indexOf(node.text) !== -1 &&
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
          bannedProperties.indexOf(node.name.text) !== -1
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
          protectedIdentifiers.indexOf(unwrappedExpr.text) !== -1 &&
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
                    // If the key is known and banned, block it
                    if (key && bannedProperties.indexOf(key) !== -1) {
                        report(node.argumentExpression, `Unauthorized element access '${key}'`);
                    } else if (!key) {
                        // If the key is entirely dynamic, block it for non-this
                        report(node, `Dynamic element access is forbidden`);
                    }
                }
            }
        }

        if (
          ts.isIdentifier(unwrappedExpr) &&
          protectedIdentifiers.indexOf(unwrappedExpr.text) !== -1 &&
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
        const propertyName = node.propertyName ? (ts.isIdentifier(node.propertyName) ? node.propertyName.text : "") : node.name.text;
        if (propertyName && bannedProperties.indexOf(propertyName) !== -1) {
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
        if (arg && ts.isStringLiteral(arg)) {
          if (allowedModules.indexOf(arg.text) === -1) {
            report(node, `Module '${arg.text}' is not on the allow-list`);
          }
        } else {
          report(node, `Dynamic require is forbidden`);
        }
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (allowedModules.indexOf(node.moduleSpecifier.text) === -1) {
          report(node, `Import of module '${node.moduleSpecifier.text}' is forbidden`);
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
        if (bannedProperties.indexOf(node.expression.name.text) !== -1) {
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
