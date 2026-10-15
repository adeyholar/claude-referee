// look (experimental): do the images show that each criterion holds? One request; every criterion is a Noul on the same images.
// TypeSafe's image support is "dreamer-ready" and not measured here, so met needs p at the look.shows band (0.9 by default) and the output says experimental.
// Images leave the machine only when named with --image; nothing is redacted (pixels cannot be), stored or cached beyond the answer, and --dry-run shows only size and hash.

import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { RefereeError } from "../../engine/errors.ts";
import { readImages, type ImageFile } from "../../engine/image.ts";
import { threshold, type Pack, type Thresholds } from "../../engine/pack.ts";
import type { Outcome, Planned } from "../../engine/session.ts";
import type { Result } from "../../engine/output.ts";
import type { Command } from "../types.ts";
import { JEV_ERRORS, jevCommand, list, openPack, question, withData } from "../shared.ts";

type Verdict = "met" | "unsure" | "missing";

const NEXT: Readonly<Record<Exclude<Verdict, "met">, string>> = {
  missing: "The images do not show the criterion. Check the state of the page or app, take a fresh capture, and ask again; the same images give the same answer.",
  unsure: "The images are ambiguous. Crop to the relevant area, send a sharper capture, or narrow the criterion; image answers are experimental, so look at the image yourself too.",
};

export function lookRequest(pack: Pack, thresholds: Thresholds | undefined, criteria: readonly string[], images: readonly ImageFile[]): { planned: Planned[]; finish: (outcomes: Outcome[]) => Result } {
  const base = question(pack, "look.shows");
  const questions: Questions = Object.fromEntries(criteria.map((criterion, i) => [`c${i + 1}`, { ...base, instructions: withData(base.instructions, { criterion }) }]));
  const met = threshold(pack, thresholds, "look.shows", "met", 0.9);
  const missing = threshold(pack, thresholds, "look.shows", "missing", 0.5);
  const state = { screenshots: images.map((i) => i.ref) } as EntryType;
  const assets = Object.fromEntries(images.map((i) => [i.ref, i.bytes]));
  const finish = ([outcome]: Outcome[]): Result => {
    const per = criteria.map((_, i) => {
      const answer = outcome?.answers?.[`c${i + 1}`];
      const p = answer?.type === "noul" ? answer.noul : 0;
      const verdict: Verdict = p >= met ? "met" : p < missing ? "missing" : "unsure";
      return { i: i + 1, verdict, p };
    });
    const verdict: Verdict = per.some((c) => c.verdict === "missing") ? "missing" : per.some((c) => c.verdict === "unsure") ? "unsure" : "met";
    return {
      ok: true,
      verdict,
      p: Math.min(...per.map((c) => c.p)),
      experimental: true,
      images: images.length,
      ...(per.length > 1 ? { criteria: per } : {}),
      ...(verdict === "met" ? {} : { next_step: NEXT[verdict] }),
    };
  };
  return { planned: [{ id: "look", state, questions, assets }], finish };
}

export const look: Command = {
  name: "look",
  describe: {
    summary: "Experimental: check whether PNG or JPEG images, such as screenshots, show that each criterion holds. Uses TypeSafe's image support, which is not yet production-grade.",
    inputs: {
      "--image <file>": "A PNG or JPEG file. Repeat for several; at most 4, 16 MiB each. Each side 256 to 1568 pixels, 78,400 to 2,458,624 pixels in all, still images only; the API never resizes and ignores EXIF orientation, so rotate the pixels first (macOS: sips -Z 1568 in.png --out out.png).",
      "--criteria <text>": "What the images must show, e.g. \"the login page shows a red error banner\". Repeat for several; max 10.",
    },
    outputs: {
      verdict: "met, unsure or missing; the lowest across criteria. met needs p of 0.9 or more by default (the look.shows band), because the image feature is experimental and not calibrated here",
      p: "Lowest probability that a criterion holds",
      experimental: "Always true: TypeSafe documents images as dreamer-ready, and the request format and accuracy can change between releases",
      images: "How many images were sent",
      criteria: "Per criterion, by position, when more than one",
      next_step: "Only when not met",
    },
    errors: [...JEV_ERRORS],
    effects:
      "Sends the named image files, unredacted (pixels cannot be redacted), and the criteria to the TypeSafe API with the TypeSafe-Danger-Zone-Images header, unless --dry-run, which prints only each image's size and hash (its token estimate leaves the images out). Screenshots can show secrets: send only what the criterion needs. Writes a receipt and a cache entry (answers only, never the image) to the data directory.",
    cost: "One Jev request. Images are billed as input tokens at $0.042 per million; TypeSafe has not published an estimate of image tokens, so read the cost from --verbose after a run.",
  },
  options: { image: { type: "string", multiple: true }, criteria: { type: "string", multiple: true } },
  async run(context) {
    const criteria = list(context, "criteria").map((c) => c.trim()).filter(Boolean);
    if (criteria.length === 0) throw new RefereeError("bad_input", "Give at least one --criteria.", { next_step: 'Example: --criteria "the page shows the saved confirmation"' });
    if (criteria.length > 10) throw new RefereeError("bad_input", "At most 10 criteria per call.");
    const images = readImages(list(context, "image"), context.io.cwd);
    const { pack, project } = openPack(context);
    const { planned, finish } = lookRequest(pack, project?.thresholds, criteria, images);
    return jevCommand(context, "look", pack, planned, finish);
  },
};
