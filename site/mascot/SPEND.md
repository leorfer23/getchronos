# Mascot image-gen spend ledger

Hard cap: **USD 5.00 total.** Stop and report at **USD 4.00**.
Provider: fal.ai, model `fal-ai/nano-banana/edit`. The key is a workspace var (`FAL_KEY`) — never
printed, logged or committed.

Character locked: **Tock**, the toy hourglass. Every call is **reference-conditioned** on two images —
the operator's risograph style reference and a rasterised frame of the hand-built SVG — so the
character and the print style are both held. Nothing was prompted from scratch.

## Real prices, checked at https://fal.ai/pricing BEFORE the first call
| model | price |
|---|---|
| Seedream V4 | USD 0.03 / image |
| **Nanobanana** (used) | **USD 0.0398 / image** |
| Flux Kontext Pro | USD 0.04 / image |
| Qwen | USD 0.02 / megapixel |

Priced on 1MP output; higher resolutions cost proportionally more. All calls here were 1024².

## Ledger

| # | date (UTC) | model | res | n | unit | cost | running | what for | kept? |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.0398 | 2×2 style grid that chose the risograph direction | yes — drove the style decision |
| 1 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.0398 | 2×2 exploration: four hero compositions, Tock against a wall of terminals | yes |
| 2 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.0796 | 2×2: product empty states — all quiet / needs you / stalled / done | yes |
| 3 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.1194 | 2×2 exploration: four social-card banner layouts | yes |
| 4 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.1592 | Hero final: Tock on a desk against a wall of terminals | yes |
| 5 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.1990 | Hero final, low angle: Tock before a curved bank of monitors | yes |
| 6 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.2388 | 03:07 final: nearly empty, phone buzzing on the desk | yes |
| 7 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.2786 | 03:07 alt: close three-quarter, arm raised | yes |
| 8 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.3184 | Dawn final on cream paper: sunrise + finished document | yes |
| 9 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.3582 | Dawn alt on cream paper: window, morning light | yes |
| 10 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.3980 | 404: both bulbs empty, loose grains on the floor | yes |
| 11 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.4378 | OG card: Tock right, terminals receding, space for a headline left | yes |
| 12 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.4776 | OG card: Tock low centre, dawn glow, headline space above | yes |
| 13 | 2026-09-21 | nano-banana/edit | 1024² | 0 | 0.0398 | 0.0000 | 0.4776 | Tileable halftone paper texture — REFUSED by the model (422). Built natively instead as texture-halftone.svg, which actually tiles. | — (no charge) |

| 14 | 2026-09-21 | nano-banana/edit | 1344×768 | 1 | 0.0398 | 0.0398 | 0.5572 | OG retake: Tock large right, clean headline space left (came back letterboxed; cropped to `og-card-alt.png`) | alt |
| 15 | 2026-09-21 | nano-banana/edit | 1344×768 | 1 | 0.0398 | 0.0398 | 0.5970 | OG retake: Tock large right under an amber lamp, clean left half → **`site/assets/og-card.png` 1200×630** | yes — shipped |
| 16 | 2026-09-21 | nano-banana/edit | 1024² | 1 | 0.0398 | 0.0398 | 0.6368 | Empty states retake, prompted for identical proportions across all four panels | **no — rejected, see below** |

**Total: USD 0.6368 of 5.00.** 16 images kept, 1 call refused at no charge.
Remaining before the 4.00 stop line: USD 3.3632.

## Note on the one failure
`grain` returned **HTTP 422** — the model refused a subject-less pure-texture prompt. No charge.
That asset is better built natively anyway: a generated texture does not tile, and
`texture-halftone.svg` does, because the dot screen is an SVG `<pattern>` and the grain uses
`stitchTiles="stitch"`.

## Rejected: the generated empty states
Both generated attempts at the four empty states were discarded. The retake (#16) came back with
**four eyes in three of the four panels** — the model duplicated the face into both bulbs. Nothing
in the prompt can reliably hold "one face per character" across a set.

`site/assets/mascot-states.png` is now **rendered from the SVG poses**, which are consistent by
construction, and a `stalled` pose was added to cover the fourth state. No further spend was made
chasing it. Total stands at USD 0.6368.
