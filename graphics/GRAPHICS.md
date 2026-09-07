# FirstPass Motion Graphics — authoring & rendering

Deterministic pipeline: a per-video **spec** goes in, alpha ProRes MOVs + a
`manifest.json` come out, and the plugin's **Graphics** tab drops them on the
timeline. Same spec ⇒ same output, every time.

## The one-command workflow

```
cd graphics
npm install                       # first time only (versions are pinned)
node render.mjs spec/<video>.json <outputFolder>
```

Then in Premiere: FirstPass panel → **Graphics** → Pick `<outputFolder>` → Add
to timeline.

## Making graphics for a new video

1. In the panel's **Graphics** tab, hit **Transcribe & export** — it transcribes
   the current timeline (whatever state it's in) and writes
   `~/Documents/IG Reels Final/post reorder transcript/<seqName>.json`
   (word-level `startSec` values are FINAL timeline seconds).
2. Copy an existing file in `spec/` and edit it: pick beats from the transcript,
   choose a `template` per graphic, set `startSec`/`durationSec`/`props`.
3. Run `render.mjs`. Do not edit templates or theme for a one-off video —
   **the spec is the only per-video file.**

## Where the look lives (edit in this order, sparingly)

| File | Owns | Change when |
|---|---|---|
| `spec/<video>.json` | text, timing, template choice | every video |
| `src/theme.ts` | palette, type, springs, grain %, camera push | rebranding only |
| `src/components/cinematic.tsx` | Grain, Glow, CameraDrift, EnterExit | new shared effect |
| `src/templates/*.tsx` | LowerThird, Punch, ListStack + vlog cards | new graphic *kind* |

### Template catalog

| template id | card | use for |
|---|---|---|
| `lowerThird` | kicker lower-third | hook/topic statements |
| `punch` | centered emphasis word | landing on one spoken word |
| `listStack` | staggered list build | spoken enumerations |
| `locationCard` | time ── place (lower-left, quiet) | establishing shots |
| `timeCard` | huge thin time, 105%→100% settle | moment markers (alarm, transitions) |
| `thoughtCard` | tracked caps lines resolving one by one | reflective beats, quotes |
| `dataCard` | stat rows, numeric values count up | fitness/metrics moments |
| `chapterCard` | dim oversized number + tracked title | section breaks (signature) |
| `figureCard` | stick figure draws itself in (`pose`: run/think/lift/victory/walk, `caption`) | playful/human moments |
| `imageCard` | framed photo from `graphics/public/` (`image`, `caption`, `tilt`) | stills, memories |
| `highlight` | dim-outside + outlined focus box (fade/draw/wipe) | machine-rendered by the helper for Headroom — not hand-authored |

Typography variants: `punch` takes `style: "outline"` (hollow stroked letters);
`thoughtCard` takes `voice: "editorial"` (serif italic, sentence case — quiet
human beats). Default is always the caps sans voice.

Vlog language ground rules (from the vlog research): footage is the hero —
~80% footage / 15% typography / 5% wow; motion resolves into place and holds
(no effects that announce themselves); graphics are silent — sound/music are
layered by the editor in Premiere, never baked in.

Templates must compose theme tokens + shared components only — no inline
colors/easings. That constraint is what keeps every video consistent.

## Cinematic rules baked in (don't undo them)

- **2–3 hue palette** (amber → coral → violet) — everything derives from it.
- **~5% animated film grain** on panel surfaces (`texture.grainOpacity`).
- **Slow camera push** 1.00→1.03 + tiny drift on every graphic (`CameraDrift`).
- **Spring easing only**: `settle` (blocks), `pop` (emphasis, visible
  overshoot), `draw` (wipes/fades, no overshoot). Nothing linear.
- **Uniform exit**: every graphic fades over its last 12 frames.
- **No vignettes/LUTs in overlays** — grade belongs to the footage, not the
  graphic.

## Load-bearing technical facts

- `--pixel-format=yuva444p10le` is **required**. Without it Remotion silently
  renders ProRes 4444 as `yuv422` — no alpha, opaque black background.
  `render.mjs` always passes it; verify a render with
  `ffmpeg -i file.mov` → must show `yuva444p12le`.
- `--muted` is **required**. Without it Remotion muxes a silent PCM audio
  track that lands on the editor's timeline as a real audio clip.
- Line-art icons (`components/art.tsx`): `heart dollar bolt crown star coffee
  shoe`. Use via `icon` prop (lowerThird) or `{ text, icon }` items (listStack).
  Art only where it carries meaning — footage stays the hero.
- `remotion.config.ts` pins PNG frame format — also required for alpha.
- Compositions render at **30 fps**; on a 29.97 timeline the drift is <5 ms on
  clips this short. Premiere conforms it silently.
- Frame size comes from the spec's `sequence` block — match the target
  sequence (the transcript export records it).
- Deterministic randomness only: use remotion's `random(seed)`, never
  `Math.random()`.
- `spec/active.json` is machine-written by `render.mjs` (gitignored).

## Manifest contract (consumed by plugin/main.js Graphics tab)

```json
{ "version": 1, "sequence": { "name", "frameWidth", "frameHeight", "fps" },
  "graphics": [ { "file": "gfx_01.mov", "startSec": 0.3,
                  "durationSec": 3.5, "label": "kicker" } ] }
```

`file` is relative to the folder; graphics land on a new top video track at
`startSec`, trimmed to `durationSec`.
