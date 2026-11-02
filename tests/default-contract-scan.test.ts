import { expect } from "chai";
import "mocha";
import Contract from "../packages/activeledger/src/contracts/default/contract";
import { ActiveOptions } from "@activeledger/activeoptions";

// securityScan() is the only thing between a namespace owner's source and a
// node's process. contract-security-scan.test.ts pins the escapes that were
// found and closed; this covers the rest of the rules, each by the message
// the deployer is given, and the namespace policy that loosens them.
describe("Contract.securityScan() - rules and policy (Activeledger)", () => {
  const NS = "scanns";
  let originalSecurity: any;

  before(() => {
    originalSecurity = ActiveOptions.get("security", undefined);
  });
  after(() => {
    if (originalSecurity === undefined) delete (ActiveOptions as any).config.security;
    else ActiveOptions.set("security", originalSecurity);
  });
  beforeEach(() => {
    delete (ActiveOptions as any).config.security;
  });

  const scan = (source: string, namespace = NS): string | null => {
    try {
      (Contract.prototype as any).securityScan.call({}, source, namespace);
      return null;
    } catch (e: any) {
      return e.message;
    }
  };
  const policy = (p: any, extra: any = {}) =>
    ActiveOptions.set("security", { namespace: { [NS]: { policy: p, ...extra } } });
  const body = (code: string) => `export default class C { run(x: any, k: any) { ${code} } }`;

  describe("violations are reported with their position", () => {
    it("names the line and column of the offending node", () => {
      const msg = scan("export default class C {\n  run() {\n    return process.env;\n  }\n}");
      expect(msg).to.equal("Security Violation [3:12]: Unauthorized use of 'process' global");
    });
  });

  describe("identifiers", () => {
    it("refuses `require` used as a value rather than called", () => {
      expect(scan(body("const r = require; return r;"))).to.match(/Unauthorized use of 'require' identifier/);
    });

    it("refuses each banned global by name", () => {
      for (const id of ["eval", "Function", "globalThis", "Reflect", "Proxy", "console", "setTimeout", "fetch"]) {
        expect(scan(body(`return ${id};`)), id).to.equal(
          `Security Violation [1:${"export default class C { run(x: any, k: any) { return ".length + 1}]: Unauthorized identifier '${id}'`
        );
      }
    });

    it("allows a banned name as a property of something else, which is the property rules' business", () => {
      expect(scan(body("return this.setTimeout;"))).to.equal(null);
      expect(scan(body("return x.console;"))).to.equal(null);
    });

    it("refuses process.nextTick unless the namespace is allowed it, and nothing else on process", () => {
      expect(scan(body("process.nextTick(() => 1);"))).to.match(/Unauthorized use of 'process' global/);
      policy({ allowProcessNextTick: true });
      expect(scan(body("process.nextTick(() => 1);"))).to.equal(null);
      expect(scan(body("return process.env;"))).to.match(/Unauthorized use of 'process' global/);
      expect(scan(body("return process;"))).to.match(/Unauthorized use of 'process' global/);
    });
  });

  describe("protected identifiers", () => {
    const refused: [string, string][] = [
      ["assignment", "Date = null;"],
      ["compound assignment", "Math += 1;"],
      ["increment", "Number++;"],
      ["prefix decrement", "--Buffer;"],
      ["a declaration that shadows", "const JSON = {};"],
      ["a function declaration that shadows", "function Promise() {}"],
      ["a class declaration that shadows", "class Map {}"],
      ["a destructured shadow", "const { a: Error } = x;"],
      ["a for-of target", "for (Set of x) {}"],
      ["a for-in target", "for (Object in x) {}"],
    ];
    for (const [what, code] of refused) {
      it(`refuses ${what}`, () => {
        expect(scan(body(code))).to.match(/Unauthorized modification of protected identifier '\w+'/);
      });
    }

    it("refuses writing a property of a protected object, by dot or by bracket", () => {
      expect(scan(body("Math.floor = null;"))).to.match(/Unauthorized modification of protected object 'Math'/);
      expect(scan(body("(Array as any).prototype2 = 1;"))).to.match(/protected object 'Array'/);
      expect(scan(body("Object['keys2'] = null;"))).to.match(/protected object 'Object'/);
      expect(scan(body("(JSON as any)['x']++;"))).to.match(/protected object 'JSON'/);
    });

    it("allows reading them, and importing a name that is also protected", () => {
      expect(scan(body("return Math.floor(1) + JSON.parse('1') + Object.keys(x).length;"))).to.equal(null);
      policy({}, { external: ["somelib"] });
      expect(scan('import { Standard } from "@activeledger/activecontracts";\nexport default class C extends Standard {}')).to.equal(
        null
      );
    });
  });

  describe("meta-programming", () => {
    it("refuses a computed property name that is not a literal, unless the namespace is allowed", () => {
      const src = body("return { [k]: 1 };");
      expect(scan(src)).to.match(/Dynamic computed property names are forbidden/);
      policy({ allowComputedProperties: true });
      expect(scan(src)).to.equal(null);
    });

    it("allows a computed property name that is a string or number literal", () => {
      expect(scan(body("return { ['a']: 1, [2]: 3 };"))).to.equal(null);
    });

    it("refuses decorators", () => {
      expect(scan("function d(t: any) {}\n@d\nexport default class C {}")).to.match(/Decorators are forbidden/);
    });

    it("refuses tagged templates", () => {
      expect(scan(body("return x`a`;"))).to.match(/Tagged template expressions are forbidden/);
    });

    it("refuses meta properties", () => {
      expect(scan(body("return new.target;"))).to.match(/Meta properties are forbidden/);
      expect(scan(body("return import.meta;"))).to.match(/Meta properties are forbidden/);
    });

    it("refuses private identifiers", () => {
      expect(scan("export default class C { #secret = 1; }")).to.match(/Private identifiers are forbidden/);
    });

    it("refuses debugger statements", () => {
      expect(scan(body("debugger;"))).to.match(/debugger statements are forbidden/);
    });
  });

  describe("module loading", () => {
    it("refuses a require whose argument cannot be known at scan time", () => {
      expect(scan(body("return require(k);"))).to.match(/Dynamic require is forbidden/);
      expect(scan(body("return require();"))).to.match(/Dynamic require is forbidden/);
      expect(scan(body("return require(`a${k}`);"))).to.match(/Dynamic require is forbidden/);
    });

    it("refuses require of an unlisted module by name, and a backtick spelling of it", () => {
      expect(scan('const f = require("fs");')).to.match(/Module 'fs' is not on the allow-list/);
      expect(scan("const f = require(`fs`);")).to.match(/Module 'fs' is not on the allow-list/);
    });

    it("refuses a dynamic import() outright, whatever it names", () => {
      expect(scan(body("return import('@activeledger/activetoolkits');"))).to.match(/Dynamic import\(\) is forbidden/);
    });

    it("refuses an import-equals whose target is not a literal", () => {
      expect(scan("import f = require(k);")).to.match(/Dynamic import specifier is forbidden/);
    });

    it("allows only what the namespace's own configuration adds to the list", () => {
      expect(scan('import x from "somelib";')).to.match(/Import of module 'somelib' is forbidden/);
      policy({}, { external: ["somelib"] });
      expect(scan('import x from "somelib";')).to.equal(null);
      ActiveOptions.set("security", { namespace: { [NS]: { std: ["stdlib"] } } });
      expect(scan('import x from "stdlib";')).to.equal(null);
      // Configuration for another namespace does not leak
      expect(scan('import x from "stdlib";', "elsewhere")).to.match(/is forbidden/);
    });

    it("keeps the built-in allow-list when a namespace has no configuration", () => {
      expect(scan('import { Standard } from "@activeledger/activecontracts";')).to.equal(null);
      expect(scan('import t from "@activeledger/activetoolkits";')).to.equal(null);
    });
  });

  describe("property rules", () => {
    it("refuses deleting a banned property, but allows deleting an ordinary one", () => {
      expect(scan(body("delete x.constructor;"))).to.match(/Unauthorized deletion of property 'constructor'/);
      expect(scan(body("delete x.name;"))).to.equal(null);
      expect(scan(body("delete this.constructor;"))).to.match(/Unauthorized deletion of property 'constructor'/);
    });

    it("refuses dynamic element access on a plain object unless the namespace is allowed it", () => {
      expect(scan(body("return x[k];"))).to.match(/Dynamic element access is forbidden/);
      expect(scan(body("return x[k + 1];"))).to.match(/Dynamic element access is forbidden/);
      expect(scan(body("return x[`a${k}`];"))).to.match(/Dynamic element access is forbidden/);
      policy({ allowDynamicAccess: true });
      expect(scan(body("return x[k];"))).to.equal(null);
    });

    it("keeps refusing a literal banned key when dynamic access is allowed", () => {
      policy({ allowDynamicAccess: true });
      expect(scan(body("return x['constructor'];"))).to.match(/Unauthorized element access 'constructor'/);
      expect(scan(body("return x[`__proto__`];"))).to.match(/Unauthorized element access '__proto__'/);
    });

    it("sees through parentheses, casts and non-null assertions", () => {
      expect(scan(body("return ((x as any)!)[k];"))).to.match(/Dynamic element access is forbidden/);
      expect(scan(body("return (<any>x)[k];"))).to.match(/Dynamic element access is forbidden/);
      expect(scan(body("return (this as any)[k];"))).to.equal(null);
    });

    it("refuses a banned property destructured by a plain name or an alias", () => {
      expect(scan(body("const { exit } = x;"))).to.match(/Unauthorized destructuring of property 'exit'/);
      expect(scan(body("const { exit: leave } = x;"))).to.match(/Unauthorized destructuring of property 'exit'/);
      expect(scan(body("const { name: leave } = x;"))).to.equal(null);
    });
  });

  describe("the privileged default namespace", () => {
    it("is not scanned however bad the source", () => {
      expect(scan('const f = require("fs"); debugger; eval("1"); with (f) {}', "default")).to.equal(null);
    });
  });
});
