# Tock — the Chronos mascot

Tock is a small hourglass creature who works the night shift. He is the character on the landing
page, the favicon, the 404 and the OG card. He is drawn in one house style: **risograph halftone,
three inks on a navy ground.**

> **Scope.** Tock is a *visual mascot and nothing else.* He is not an agent, not an assistant, and
> not a persona you can talk to. The product's assistant is **Robert**, and that name is unchanged
> in the code and the docs. Never use "Tock" as an agent name, a handle, or a speaker in copy.

## The files

**`site/assets/` is the source of truth.** The landing imports from there, and so do the pages in
this directory. Nothing here is a copy — edit `site/assets/mascot.svg` and the landing changes.

| File (under `site/assets/`) | What it is |
|---|---|
| `mascot.svg` | The canonical character, at rest. Start here. |
| `logo.svg` | Lockup: mark + the `chronos` wordmark. The wordmark is outlines, so it needs no font. |
| `favicon.svg` | 64×64 mark. **Solid ink, not halftone** — see below. |
| `poses/idle.svg` | Nothing is happening. The resting state. |
| `poses/alert.svg` | A run is live and he is watching it. |
| `poses/asking.svg` | 03:07. A run stopped to ask you something. Heavy lids, under-eye bags. |
| `poses/done.svg` | Dawn. Printed on cream paper stock instead of navy. |
| `poses/stalled.svg` | A run stopped emitting. Sand sits in both bulbs and **nothing is flowing**. |
| `poses/404.svg` | Both bulbs empty. Lost. |
| `texture-halftone.svg` | A genuinely tileable 96×96 halftone paper texture for page backgrounds. |
| `site/mascot/animations.html` | Live demo of every animated state. |
| `site/mascot/gen/` | Generated illustrations for the landing hero and OG card. Not the mark. |

## The three inks

The whole system is three inks plus a ground. Nothing else.

| Token | Hex | Used for |
|---|---|---|
| ink · slate | `#8D97AC` | Body, frame, limbs, lids, brows |
| ink · amber | `#E8A33D` | Sand, and the single accent. Nothing else is amber. |
| ink · white | `#F2EDE3` | Eyes, wordmark, type highlights |
| ground · night | `#1E2430` | The default ground |
| ground · paper | `#EFE6D4` | Dawn only |
| misregistration | `#C0506A` | Stray flecks only. Never a fill. |

**One documented exception: the two status inks.** The `app-fleet*` illustrations add a muted riso
green and a dusty riso red. These are not decoration — they are **the Desk's real semantic status
colours**: green for a finished card, red for a `BLOCKED` badge. `working`, `blocked` and `done` are
real run states in `src/`.

The rule: **green and red are only ever status.** They may appear inside a terminal panel or on a
state badge, and nowhere else — never on Tock, never on the mark, never on UI chrome, never as
decoration or an accent. Amber remains the only accent colour. Everything outside status stays three
inks.

## How the halftone is built

Every fill is a `<pattern>` of dots at a **3-unit pitch**, one pattern per ink, each on its own
screen angle (slate 15°, amber 45°, white 75°) so overlapping inks moiré like a real separation.
Each ink is laid down on its own `<g id="plate-*">` offset 1–2px, which is the misregistration.
Paper grain is a stitched `feTurbulence` overlay at ~6% opacity.

It is all native SVG. There is no raster anywhere in the mark, and no build step.

## Animation

Animate the **named groups**, never the paths inside them: `#stream`, `#sand-top`, `#sand-bottom`,
`#eye`, `#lid`, `#bags`, `#brow`, `#body`, `#ground`. `animations.html` is the reference
implementation.

The sand stream loops by translating exactly **3 units** — one halftone pitch — so the dots scroll
seamlessly and never tear. If you change the pitch, change the loop to match.

Everything must survive `prefers-reduced-motion: reduce`: switch the animations off and park the
sand mid-run, so Tock is a correct static illustration rather than a frozen first frame.

## Clear space and sizing

- Clear space on all sides = the height of the top cap. Nothing enters it.
- Minimum size for the halftone character: **96px tall.** Below that the dot screen fills in and
  turns to mud.
- **Below 32px, use `favicon.svg`**, which is solid ink by design. A halftone screen cannot survive
  16px — this is a deliberate exception, not an inconsistency.

## What Tock never does

- Never in a colour outside the three inks. No gradients, no gloss, no drop shadows, no 3D.
- Never stretched, rotated (except the 180° rework flip), skewed or outlined.
- Never given a mouth. The eyes, lids and brows carry every expression.
- Never cheerful about being awake at 3am. He is competent and tired, not excited.
- Never used as a loading spinner. He is a character, not a progress indicator.

## Generated illustrations

Everything in `gen/` was produced with fal.ai `nano-banana/edit`, **conditioned on the hand-built
SVG** so the character stays on model — never prompted from scratch. Spend is logged per call in
`SPEND.md`.

They are illustrations for the landing page and social card only. **The mark, the favicon and every
pose stay hand-built SVG.** If a generated image and the SVG ever disagree, the SVG is right.

**Do not generate UI states.** An attempt to produce the four empty states by generation gave three
panels with *four eyes* — a face duplicated into both bulbs — because the model has no constraint
keeping one face per character. Anything that must be consistent across a set is built from the
poses, where consistency is structural. Generation is for the big one-off illustrations only.

## What the landing consumes: `site/assets/`

The landing page imports these **fixed names**. This is the canonical location — there is exactly
one copy of every vector asset, so nothing can drift out of sync.

| Path | What |
|---|---|
| `site/assets/mascot.svg` | **Self-animating.** Drop it in as `<img src>` and it bobs, blinks and pours on its own. |
| `site/assets/logo.svg` | Mark + wordmark lockup |
| `site/assets/favicon.svg` | Solid-ink mark for ≤32px |
| `site/assets/poses/*.svg` | idle · alert · asking · stalled · done · 404 |
| `site/assets/texture-halftone.svg` | Tileable 96×96 page background |
| `site/assets/og-card.png` | **1200×630** social card, headline space on the left |
| `site/assets/og-card-alt.png` | Alternate social card |
| `site/assets/mascot-hero.png` | Landing hero: Tock against a wall of terminals |
| `site/assets/mascot-hero-alt.png` | Hero, low angle |
| `site/assets/mascot-asking.png` | 03:07, the phone buzzing |
| `site/assets/mascot-dawn.png` | Dawn, on cream paper |
| `site/assets/mascot-404.png` | 404 |
| `site/assets/mascot-states.png` | Four empty states in one sheet — **rendered from the SVG poses**, not generated |
| `site/assets/app-fleet-scale.png` | **Lead capacity image.** Desk-level perspective, the wall receding — Tock small on the desk gives the proportion. Use this where the point is scale. |
| `site/assets/app-fleet.png` | The cleanest, most orderly version: a curved wall of terminals, Tock centred. Use as a section image or a card. |
| `site/assets/app-fleet-grid.png` | Orderly head-on grid. Alternate. |

`mascot.svg` carries its own `<style>` block, so the animation works **without any page CSS** and
still honours `prefers-reduced-motion`. If you inline it instead, the same named groups are there
to drive from your own stylesheet — see `animations.html`.
