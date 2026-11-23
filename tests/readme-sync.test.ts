import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as path from "path";

// npm shows each package's own README, so they have to read well away from the repository: the activeledger package's is
// the root README made absolute (by scripts/sync-readme.mjs), and every other package's must carry no relative link or image.
const root = path.join(__dirname, "..");
const packages = fs.readdirSync(path.join(root, "packages")).filter((p) => fs.existsSync(path.join(root, "packages", p, "package.json")) && fs.existsSync(path.join(root, "packages", p, "README.md")));

describe("Package READMEs (what npm shows)", () => {
  it("packages/activeledger/README.md is the root README made absolute", async () => {
    const { transform } = await import(path.join(root, "scripts", "sync-readme.mjs"));
    const want = transform(fs.readFileSync(path.join(root, "README.md"), "utf8"));
    expect(fs.readFileSync(path.join(root, "packages", "activeledger", "README.md"), "utf8")).to.equal(want);
  });

  it("the transform makes guide links site URLs, other files GitHub URLs, and images raw URLs, and drops the repository-only line", async () => {
    const { transform } = await import(path.join(root, "scripts", "sync-readme.mjs"));
    const out = transform(
      [
        "![a](docs/guide/assets/screens/x.png)",
        '<img src="docs/assets/Asset-23.png" alt="">',
        "[g](docs/guide/cli/project.md) [n](docs/guide/operate/nodes.md#leader-mode) [i](docs/guide/index.md) [f](DEVELOPING.md) [e](https://example.com)",
        "- [Developing Activeledger](DEVELOPING.md): building",
        "- keep",
      ].join("\n")
    );
    expect(out).to.include("![a](https://raw.githubusercontent.com/activeledger/activeledger/master/docs/guide/assets/screens/x.png)");
    expect(out).to.include('<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png"');
    expect(out).to.include("[g](https://activeledger.github.io/activeledger/cli/project/)");
    expect(out).to.include("[n](https://activeledger.github.io/activeledger/operate/nodes/#leader-mode)");
    expect(out).to.include("[i](https://activeledger.github.io/activeledger/)");
    expect(out).to.include("[f](https://github.com/activeledger/activeledger/blob/master/DEVELOPING.md)");
    expect(out).to.include("[e](https://example.com)");
    expect(out).to.not.include("Developing Activeledger");
    expect(out).to.include("- keep");
  });

  for (const pkg of packages) {
    it(`${pkg}: a title, the logo, a docs link, and no relative link or image`, () => {
      const text = fs.readFileSync(path.join(root, "packages", pkg, "README.md"), "utf8");
      expect(text).to.match(/^(<img|<picture|\[!\[|#)/);
      expect(text).to.include("activeledger.github.io/activeledger");
      const relative = [...text.matchAll(/!?\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)].map((m) => m[1]);
      const srcs = [...text.matchAll(/(?:src|srcset)="(?!https?:)([^"]+)"/g)].map((m) => m[1]);
      expect([...relative, ...srcs], pkg).to.deep.equal([]);
    });
  }
});
