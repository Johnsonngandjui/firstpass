// ── FirstPass graphics design tokens ─────────────────────────────────────────
// The single source of truth for the look. Templates may ONLY take colors,
// fonts, timing and easing from here — never inline literals — so every graphic
// in every video renders with the same visual language.
//
// Current direction (user brief): MINIMAL MONOCHROME. No color — white type
// over footage, hairline rules as the only decoration, soft shadows for
// legibility, restrained motion. Pleasant through spacing and rhythm, not hue.

export const palette = {
  white:  "#f5f5f5",                    // primary type
  soft:   "rgba(245,245,245,0.72)",     // supporting type (eyebrows, pres)
  dim:    "rgba(245,245,245,0.45)",     // tertiary
  hairline: "rgba(245,245,245,0.85)",   // rules / underlines / markers
  shadow: "rgba(0,0,0,0.55)",           // soft legibility shadow behind type
  glow:   "rgba(255,255,255,0.30)",     // barely-there white bloom
};

export const gradients = {
  // monochrome "gradients" kept as tokens so templates stay theme-agnostic
  hairline: `linear-gradient(90deg, ${palette.hairline}, rgba(245,245,245,0.2))`,
};

export const type = {
  family: "Helvetica Neue, Arial, sans-serif",
  // secondary/condensed voice (vlog data + labels) — research: 1–2 fonts max
  condensed: "Arial Narrow, Arial, sans-serif",
  // editorial accent voice: serif italic, for reflective/quote moments only
  serif: "Georgia, 'Times New Roman', serif",
  // emphasis: heavy but not black — minimal reads lighter
  headline: { fontWeight: 700, letterSpacing: -1 } as const,
  // supporting words inside a headline
  support:  { fontWeight: 300, letterSpacing: 0 } as const,
  // small kicker/eyebrow: airy via wide tracking
  eyebrow:  { fontWeight: 500, letterSpacing: 18, color: palette.soft } as const,
  // stat values: condensed, tabular so digits don't jitter while counting
  stat: { fontWeight: 700, letterSpacing: 1, fontVariantNumeric: "tabular-nums" } as const,
  // one soft shadow everywhere type sits directly on footage
  shadow: `0 4px 24px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.4)`,
};

// Spring presets — the ONLY easings templates use.
export const springs = {
  settle: { damping: 18,  mass: 0.9 },  // blocks entering (near-no overshoot: minimal)
  pop:    { damping: 14,  mass: 0.8 },  // emphasis words (slight overshoot)
  draw:   { damping: 200 },             // wipes, line draws, fades (none)
};

// Standardized timing so every graphic breathes the same.
export const timing = {
  exitFrames: 12,          // uniform ease-out at the tail of every graphic
  staggerFrames: 14,       // delay between siblings in list builds
  eyebrowDelay: 8,         // eyebrow enters shortly after the main element
};

export const texture = {
  grainOpacity: 0.04,      // only on solid surfaces (unused when type-only)
  glowBlurPx: 100,
  glowPulseHz: 0.5,
};

export const camera = {
  pushFrom: 1.0,           // slow push-in across the whole graphic's life
  pushTo: 1.02,            // gentler than before — minimal
  driftPx: 4,
};
