// Reads a PNG or JPEG for `look` and checks TypeSafe's image limits locally (docs.typesafe.ai/images.md, experimental), so a bad file fails before any request.
// The API rejects the whole request for one bad image and never resizes, so the sizes are read from the file headers here; the reference is derived from the file hash.
// Not checked: EXIF orientation (the API ignores it, rotate the pixels first) and progressive JPEG (the API prefers baseline).

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "./cache.ts";
import { RefereeError } from "./errors.ts";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
export const MIN_SIDE = 256;
export const MAX_SIDE = 1568;
export const MIN_PIXELS = 78_400;
export const MAX_PIXELS = 2_458_624;

export interface ImageFile {
  readonly ref: string;
  readonly bytes: Uint8Array;
  readonly format: "png" | "jpeg";
  readonly width: number;
  readonly height: number;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bad = (message: string, next_step: string): RefereeError => new RefereeError("bad_input", message, { next_step });
const RESIZE = "Resize so the longest side is at most 1568 pixels and send a PNG or JPEG (macOS: sips -Z 1568 in.png --out out.png).";

function pngSize(b: Buffer, name: string): { width: number; height: number } {
  let at = 8;
  let size: { width: number; height: number } | undefined;
  while (at + 8 <= b.length) {
    const type = b.toString("latin1", at + 4, at + 8);
    if (type === "IHDR" && !size && at + 16 <= b.length) size = { width: b.readUInt32BE(at + 8), height: b.readUInt32BE(at + 12) };
    if (type === "acTL") throw bad(`${name} is an animated PNG; the API rejects animations.`, "Export one frame as a still PNG or JPEG.");
    if (type === "IDAT") break;
    at += 12 + b.readUInt32BE(at);
  }
  if (!size) throw bad(`${name} is not a readable PNG (no header).`, "Export it again as a PNG or JPEG.");
  return size;
}

function jpegSize(b: Buffer, name: string): { width: number; height: number } {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) break;
    const marker = b[at + 1] as number;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > b.length) break;
      return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
    }
    at += marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) ? 2 : 2 + b.readUInt16BE(at + 2);
  }
  throw bad(`${name} is not a readable JPEG (no frame header).`, "Export it again as a standard baseline JPEG or a PNG.");
}

export function readImage(path: string, cwd: string): ImageFile {
  const file = resolve(cwd, path);
  let bytes: Buffer;
  try {
    const info = statSync(file);
    if (!info.isFile()) throw bad(`${path} is not a regular file.`, "Give the path of a PNG or JPEG file.");
    if (info.size > MAX_IMAGE_BYTES) throw bad(`${path} is larger than 16 MiB.`, RESIZE);
    bytes = readFileSync(file);
  } catch (error) {
    if (error instanceof RefereeError) throw error;
    throw bad(`Cannot read the image file: ${path}`, "Check the path; it is resolved from the current directory.");
  }
  const png = PNG.every((v, i) => bytes[i] === v);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpeg) throw bad(`${path} is not a PNG or JPEG.`, "Convert it (GIF, WebP and HEIC are not accepted) and try again.");
  const { width, height } = png ? pngSize(bytes, path) : jpegSize(bytes, path);
  if (width < MIN_SIDE || height < MIN_SIDE || width * height < MIN_PIXELS) throw bad(`${path} is ${width}x${height}; the API needs at least ${MIN_SIDE} pixels on each side and ${MIN_PIXELS} pixels in all.`, "Capture a larger area, or scale up or pad the image.");
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw bad(`${path} is ${width}x${height}; the API takes at most ${MAX_SIDE} pixels on a side and ${MAX_PIXELS} pixels in all, and never resizes.`, RESIZE);
  return { ref: `img_${sha256(bytes).slice(0, 12)}`, bytes, format: png ? "png" : "jpeg", width, height };
}

export function readImages(paths: readonly string[], cwd: string): ImageFile[] {
  if (paths.length === 0) throw bad("Give at least one --image.", "Example: --image screenshot.png");
  if (paths.length > MAX_IMAGES) throw bad(`At most ${MAX_IMAGES} images per call.`, "Send the most relevant ones, or split the check.");
  const read = paths.map((p) => readImage(p, cwd));
  const images = read.filter((image, i) => read.findIndex((o) => o.ref === image.ref) === i);
  if (images.reduce((sum, i) => sum + i.bytes.length, 0) > MAX_TOTAL_BYTES) throw bad("The images together are larger than 24 MiB.", RESIZE);
  return images;
}
