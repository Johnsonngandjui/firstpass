---
name: motion-graphics
description: Design and render FirstPass motion graphics for a Premiere sequence from its exported transcript — spec-driven Remotion, minimal monochrome A24-style language. Use when asked to create, update, or restyle motion graphics for a video/sequence.
---

# Motion graphics for FirstPass

You are the motion designer for this video. The user has (or will) run
**Graphics → Transcribe & export** in the FirstPass panel; your job is to read
that transcript, choose the beats, author a spec, render, and hand back a folder
the panel's Graphics tab can apply. Read `graphics/GRAPHICS.md` first.

## Workflow

1. **Get the transcript.** The sandbox cannot read `~/Documents` — fetch via the
   helper instead:
   `curl -s http://localhost:7742/list_transcripts` then
   `curl -s -G http://localhost:7742/read_transcript --data-urlencode "name=<file>.json"`.
   If the helper is down, ask the user to open Premiere (the watcher starts it).
   Word `startSec` values are FINAL timeline seconds — design directly against them.

2. **Choose beats like an editor, not a decorator.** Rules:
   - 80% footage / 15% typography / 5% wow. For a ~30s piece that's 3–5 graphics;
     scale with duration. Never wall-to-wall.
   - Land graphics on *spoken* moments: an emphasized word, an enumeration, a
     question, a number. Use pauses (gaps between words) as hold time.
   - One idea per graphic. If a sentence has two ideas, pick the stronger.
   - Vary templates across the video; don't repeat the same card back-to-back.

3. **Author the spec.** Copy an existing file in `graphics/spec/`, keep the
   `sequence` block matching the transcript's (frame size + fps). The spec is
   the ONLY per-video file — never edit theme/templates for a one-off.

4. **Render.** `cd graphics && node render.mjs spec/<video>.json <outFolder>`
   (deps: `npm install` first time). The script bakes in the two load-bearing
   flags (`--pixel-format=yuva444p10le` for alpha, `--muted` for no audio) and
   writes `manifest.json` from the same spec.

5. **Verify before handing over** (all three, every time):
   - every MOV: exactly one stream, `yuva444p12le` (ffmpeg lives at
     `helper/firstpass-env/lib/python3.11/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1`)
   - extract 2–3 peak frames, composite over a mid-gray RGBA canvas with PIL,
     and LOOK at them (legibility, position, timing sanity)
   - manifest timings match the spec.

6. **Hand back.** Tell the user the folder path; they apply it via
   Graphics → Pick graphics folder → Add to timeline.

## Template catalog (spec `template` values)

| id | what | when |
|---|---|---|
| `lowerThird` | kicker: rule + eyebrow + two-weight headline (`icon` optional) | hooks, topic statements |
| `punch` | one huge centered word (`style: "outline"` for hollow letters) | landing on a single spoken word |
| `listStack` | right-aligned staggered list; items `{text, icon}` | spoken enumerations |
| `locationCard` | time ── place, quiet lower-left | establishing shots |
| `timeCard` | huge thin time, 105%→100% settle | moment markers |
| `thoughtCard` | centered lines resolving one by one (`voice: "editorial"` = serif italic) | reflective beats, quotes |
| `dataCard` | stat rows, numeric values count up | metrics/fitness |
| `chapterCard` | dim oversized number + tracked title | section breaks |
| `figureCard` | stick figure draws itself in (`pose`, `caption`) | playful/human moments |
| `imageCard` | framed photo from `graphics/public/` (`image`, `caption`) | stills, memories |

Art assets: icons `heart dollar bolt crown star coffee shoe`; figure poses
`run think lift victory walk`. Photos go in `graphics/public/` first.

## Style law (do not violate)

Monochrome only — white/off-white/dim, zero hue. Motion resolves into place and
holds; no spins, glitches, particles. Springs from `theme.ts` only. Everything
silent. If a graphic calls attention to itself, cut it. New *kinds* of graphics
= new template composing theme tokens + `components/` — never inline styles.

## Extending (only when the user asks for a new kind)

Add a template in `graphics/src/templates/`, register it in `Root.tsx`'s
TEMPLATES map, document it in GRAPHICS.md's catalog and the table above.
