// look (experimental images): local checks of PNG and JPEG headers against TypeSafe's limits, the request it builds, and the whole command against a fake Jev that reads multipart.
// Image files are minimal headers written here (signature, size, no pixels); nothing real is committed.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commands } from "../src/cli/commands/index.ts";
import { run } from "../src/cli/run.ts";
import { readImage, readImages } from "../src/engine/image.ts";
import { fakeJev } from "./fake-jev.ts";
import { memoryIo, pngHeader, tempDir } from "./helpers.ts";

const png = pngHeader;

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.set([0xff, 0xc0, 0x00, 0x0b, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(20)]);
}

const dir = tempDir();
const write = (name: string, bytes: Buffer): string => {
  writeFileSync(join(dir, name), bytes);
  return name;
};

test("PNG and JPEG sizes are read from the headers, and the reference follows the content", () => {
  const a = readImage(write("a.png", png(800, 600)), dir);
  assert.deepEqual([a.format, a.width, a.height], ["png", 800, 600]);
  const j = readImage(write("a.jpg", jpeg(1568, 1000)), dir);
  assert.deepEqual([j.format, j.width, j.height], ["jpeg", 1568, 1000]);
  assert.match(a.ref, /^img_[0-9a-f]{12}$/);
  assert.equal(readImage(write("b.png", png(800, 600)), dir).ref, a.ref);
  assert.notEqual(readImage(write("c.png", png(801, 600)), dir).ref, a.ref);
});

test("every limit fails locally with a next step, and the edges pass", () => {
  const fails = (name: string, bytes: Buffer, pattern: RegExp) => assert.throws(() => readImage(write(name, bytes), dir), (e: Error & { code?: string; details?: { next_step?: string } }) => e.code === "bad_input" && pattern.test(e.message) && Boolean(e.details?.next_step));
  fails("small.png", png(255, 400), /at least 256/);
  fails("thin.png", png(400, 100), /at least 256/);
  fails("wide.png", png(1569, 800), /at most 1568/);
  fails("big.jpg", jpeg(1568, 1569), /at most 1568/);
  fails("notimage.png", Buffer.from("hello world, not an image at all"), /not a PNG or JPEG/);
  fails("animated.png", png(800, 600, [Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("acTL", "latin1"), Buffer.alloc(12)])]), /animated/);
  fails("broken.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), /not a readable JPEG/);
  assert.throws(() => readImage("missing.png", dir), /Cannot read the image file/);
  assert.equal(readImage(write("min.png", png(280, 280)), dir).width, 280);
  assert.equal(readImage(write("max.png", png(1568, 1568)), dir).height, 1568, "1568 x 1568 is 2,458,624 pixels, the inclusive maximum");
  assert.throws(() => readImage(write("over.png", png(1568, 1569)), dir), /at most/);
});

test("image count, duplicates and the empty list", () => {
  const paths = ["a.png", "b.png", "c.png", "d.png", "e.png"].map((n, i) => write(n, png(300 + i, 300)));
  assert.throws(() => readImages(paths, dir), /At most 4/);
  assert.throws(() => readImages([], dir), /at least one --image/);
  const same = write("same.png", png(500, 500));
  assert.equal(readImages([same, write("same2.png", png(500, 500))], dir).length, 1);
});

async function runLook(args: string[], env: Record<string, string>): Promise<{ code: number; out: Record<string, unknown> }> {
  const home = tempDir();
  const io = memoryIo({ cwd: dir, home, env: { HOME: home, ...env } });
  const code = await run(["look", ...args], io, commands);
  return { code, out: JSON.parse(io.out.join("").trim().split("\n").at(-1) ?? "{}") as Record<string, unknown> };
}

test("--dry-run prints size and hash of each image and sends nothing", async () => {
  const fake = await fakeJev();
  try {
    const file = write("shot.png", png(800, 600));
    const { code, out } = await runLook(["--image", file, "--criteria", "the page shows a banner", "--dry-run"], { TYPESAFE_BASE_URL: fake.url, REFEREE_BASE_URL_KEY: "test-key" });
    assert.equal(code, 0);
    const sent = out["sent"] as { state: { screenshots: string[] }; images: { ref: string; bytes: number; sha256: string }[] }[];
    assert.equal(sent[0]?.images[0]?.bytes, png(800, 600).length);
    assert.equal(sent[0]?.state.screenshots[0], sent[0]?.images[0]?.ref);
    assert.equal(JSON.stringify(out).includes("iVBOR"), false);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test("look sends the image as a multipart asset with the images header, and judges by the 0.9 band", async () => {
  const fake = await fakeJev((request) => ({ c1: { type: "noul", noul: 0.95 }, ...(request.questions["c2"] ? { c2: { type: "noul", noul: 0.8 } } : {}) }));
  try {
    const file = write("shot2.png", png(800, 600));
    const env = { TYPESAFE_BASE_URL: fake.url, REFEREE_BASE_URL_KEY: "test-key" };
    const one = await runLook(["--image", file, "--criteria", "the page shows a banner"], env);
    assert.deepEqual([one.code, one.out["verdict"], one.out["experimental"], one.out["images"]], [0, "met", true, 1], JSON.stringify(one.out));
    const request = fake.requests[0];
    assert.equal(request?.headers?.["typesafe-danger-zone-images"], "true");
    const ref = Object.keys(request?.assets ?? {})[0];
    assert.ok(ref !== undefined && JSON.stringify(request?.state).includes(ref), "the state names the asset by its reference");
    assert.equal(Object.values(request?.fileSizes ?? {})[0], png(800, 600).length);
    const two = await runLook(["--image", file, "--criteria", "the page shows a banner", "--criteria", "the page shows a menu"], env);
    assert.equal(two.out["verdict"], "unsure", "0.8 is under the 0.9 met band and over the 0.5 missing band");
  } finally {
    await fake.close();
  }
});

test("look needs criteria and an image, and refuses a bad file before any request", async () => {
  const fake = await fakeJev();
  try {
    const env = { TYPESAFE_BASE_URL: fake.url, REFEREE_BASE_URL_KEY: "test-key" };
    assert.equal((await runLook(["--image", write("ok.png", png(800, 600))], env)).out["error"], "bad_input");
    assert.equal((await runLook(["--criteria", "x"], env)).out["error"], "bad_input");
    assert.equal((await runLook(["--image", write("tiny.png", png(100, 100)), "--criteria", "x"], env)).out["error"], "bad_input");
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test("review: a path that is not a regular file is refused before it is read, and duplicates are counted once against the size cap", () => {
  assert.throws(() => readImage(dir, dir), /not a regular file/);
  const big = png(800, 600, [Buffer.alloc(10 * 1024 * 1024)]);
  const same = [write("d1.png", big), write("d2.png", big), write("d3.png", big)];
  assert.equal(readImages(same, dir).length, 1, "three copies of a 10 MB file are one image of 10 MB");
  const first = png(300, 300, [Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR", "latin1"), Buffer.alloc(13), Buffer.alloc(4)])]);
  assert.equal(readImage(write("two-ihdr.png", first), dir).width, 300, "the first IHDR wins");
});
