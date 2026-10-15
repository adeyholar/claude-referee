# `look`: images as evidence (experimental)

Written 2026-10-15, after the code and a first sanity run (the registration came second). Chosen because the maintainer asked for image support to use locally ("görseli ekle çünkü ben localimde de kullanacağım"), after TypeSafe published its Images page (SDK 0.7.0, 2026-10-14).

## What TypeSafe offers (docs read 2026-10-15)

Images go in `state`, a question's `instructions` or its `criteria`, listed in a top-level `assets` map and sent with the `TypeSafe-Danger-Zone-Images: true` header. The page is labelled dreamer-ready: not production-grade, the format, answers and limits can change between releases. PNG or JPEG, 16 MiB a file, 256 to 1568 px a side, 78,400 to 2,458,624 pixels, 32 MiB a request, no resizing and no EXIF rotation by the API; images are billed as input tokens (no estimate published). Jev 1.13 and 1.14 accept images; `Box` questions need 1.14.

## What was built

`claude-referee look --image <file> (repeat, at most 4) --criteria <text> (repeat, at most 10)`. One request; each criterion is a Noul (`look.shows` in the generic pack) over the same images, which are placed in the state as `screenshots` and sent as SDK assets. Verdicts are `met`, `unsure`, `missing`, with the lowest across criteria; output carries `experimental: true`.

- **Local limits first.** `src/engine/image.ts` reads PNG and JPEG headers, rejects the cases the API rejects (format, size, sides, pixels, animated PNG) with a next step, so a bad file never costs a request or fails the whole call.
- **Conservative band.** `met` needs p of 0.9 (`look.shows.met`); `missing` is below 0.5. No calibration exists for images here.
- **Privacy.** Images leave the machine unredacted and only when named; `--dry-run` shows size, hash and dimensions; the cache and receipts keep answers and counts, never the image. See [privacy.md](../privacy.md).
- The SDK upgrade to 0.7.0 (Node 22.12 or later) was needed for this; request bodies go uncompressed.

## First check (invented, small)

12 screenshots made with headless Firefox from small HTML pages (login with and without an error banner, a saved toast, tables of 3 and 5 rows, a delete dialog, a spinner, dark and light theme, an unread badge 3, a disabled and an enabled button), 21 criteria, 11 expected true and 10 expected false, `--fresh`, each criterion its own call:

| Model | expected true `met` | expected false `met` | p of true | p of false |
|---|---|---|---|---|
| `jev-1.13.0` | 11 of 11 | 0 of 10 | 0.97 to 0.99 | 0.01 to 0.02 |
| `jev-1.14.0` | 10 of 11 (one 0.84, `unsure`) | 0 of 10 | 0.84 to 1.00 | 0.01 |

## Limits

The cases are invented, clean, rendered by one browser and easy; n is 21. It shows the plumbing works and the two classes separate on simple UI states, not how accurate `look` is on real screenshots, small text, dense pages or other themes. The 0.9 band is a guess kept conservative. Not built: resizing, `Box` questions, using screenshots in `done` or the Stop gate.
