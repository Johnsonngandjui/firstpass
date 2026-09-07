// ── Minimal line art ─────────────────────────────────────────────────────────
// Stroke-only monochrome icons that draw themselves in (stroke-dash reveal),
// matching the hairline visual language. Use art only where it carries meaning
// — the footage stays the hero.
import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import { palette, springs } from "../theme";

// viewBox is always 0 0 100 100; paths are simple single-stroke glyphs.
const GLYPHS: Record<string, string[]> = {
  heart:  ["M50 34 C58 20,84 28,68 50 C61 59,55 64,50 74 C45 64,39 59,32 50 C16 28,42 20,50 34 Z"],
  dollar: ["M62 32 C56 26,40 26,38 36 C36 48,64 48,62 62 C60 74,42 74,36 66", "M50 20 L50 80"],
  bolt:   ["M55 18 L35 54 L48 54 L43 82 L66 44 L52 44 Z"],
  crown:  ["M24 66 L20 34 L38 48 L50 26 L62 48 L80 34 L76 66 Z", "M28 76 L72 76"],
  star:   ["M50 22 L57 42 L78 42 L61 55 L67 76 L50 63 L33 76 L39 55 L22 42 L43 42 Z"],
  coffee: ["M30 40 L70 40 L66 76 L34 76 Z", "M70 46 L80 46 C86 46,86 60,78 60 L68 60",
           "M42 32 C42 26,46 26,46 22", "M56 32 C56 26,60 26,60 22"],
  shoe:   ["M22 62 C22 52,30 50,36 46 L44 38 C52 48,66 54,80 56 L80 66 L22 66 Z", "M22 70 L80 70"],
};

export const LineIcon: React.FC<{ name: string; size?: number; delay?: number; opacity?: number }> =
  ({ name, size = 120, delay = 6, opacity = 1 }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const draw = spring({ frame: frame - delay, fps, config: springs.draw });
    const paths = GLYPHS[name];
    if (!paths) return null;
    const LEN = 400;                       // generous upper bound for all glyphs
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" style={{ opacity,
        filter: "drop-shadow(0 3px 12px rgba(0,0,0,0.5))" }}>
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={palette.white} strokeWidth={4.5}
            strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray={LEN} strokeDashoffset={LEN * (1 - draw)} />
        ))}
      </svg>
    );
  };
