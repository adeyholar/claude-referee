// scripts/verify-release.mjs: the integrity value and the byte comparison of a registry tarball against a git tag, on invented trees (the download and git steps were run by hand against the real 0.2.7 package).

import assert from "node:assert/strict";
import { test } from "node:test";
import { compareTrees, integrityOf } from "../scripts/verify-release.mjs";

const tree = (files: Record<string, string>) => new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]));

test("integrityOf is the registry's sha512 form, base64 of the digest", () => {
  assert.equal(integrityOf(Buffer.alloc(0)), "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==");
});

test("compareTrees names every file that differs or exists on one side only", () => {
  const same = tree({ "cli.mjs": "a", "packs/x.json": "b" });
  assert.deepEqual(compareTrees(same, tree({ "cli.mjs": "a", "packs/x.json": "b" })), { identical: ["cli.mjs", "packs/x.json"], different: [], only_in_tarball: [], only_in_tag: [] });
  const drift = compareTrees(tree({ "cli.mjs": "a!", "extra.js": "x", "README.md": "r" }), tree({ "cli.mjs": "a", "README.md": "r", "LICENSE": "l" }));
  assert.deepEqual(drift, { identical: ["README.md"], different: ["cli.mjs"], only_in_tarball: ["extra.js"], only_in_tag: ["LICENSE"] });
});
