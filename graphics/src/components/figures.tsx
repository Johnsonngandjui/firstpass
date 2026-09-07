// ── Stick figures ────────────────────────────────────────────────────────────
// Line-drawn characters in the same stroke language as the icons: they draw
// themselves in (staggered per limb), then idle with a barely-there bob.
// Deliberately naive/hand-drawn in spirit — charm over realism.
import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import { palette, springs } from "../theme";

// viewBox 0 0 120 160. Each pose = ordered stroke paths (head first).
const POSES: Record<string, string[]> = {
  run: [
    "M74 26 a13 13 0 1 0 0.1 0",                       // head (leaning forward)
    "M70 40 L58 92",                                    // torso
    "M66 54 L36 66", "M66 54 L94 42",                   // arms swinging
    "M58 92 L32 118 L18 136",                           // back leg
    "M58 92 L84 114 L96 142",                           // front leg
  ],
  think: [
    "M56 30 a13 13 0 1 0 0.1 0",                       // head
    "M56 44 L52 98",                                    // torso
    "M54 60 L74 46",                                    // hand to chin
    "M52 98 L82 102 L78 136",                           // bent legs (seated)
    "M30 136 L96 136",                                  // ground line
  ],
  lift: [
    "M60 36 a12 12 0 1 0 0.1 0",                       // head
    "M60 48 L60 102",                                   // torso
    "M60 58 L34 30", "M60 58 L86 30",                   // arms up to the bar
    "M60 102 L40 142", "M60 102 L80 142",               // stance
    "M18 26 L102 26",                                   // barbell
    "M14 16 L14 36", "M106 16 L106 36",                 // plates
  ],
  victory: [
    "M60 30 a13 13 0 1 0 0.1 0",                       // head
    "M60 44 L60 100",                                   // torso
    "M60 54 L28 18", "M60 54 L92 18",                   // arms in a V
    "M60 100 L42 144", "M60 100 L78 144",               // legs
  ],
  walk: [
    "M62 26 a13 13 0 1 0 0.1 0",                       // head
    "M60 40 L56 94",                                    // torso
    "M58 54 L40 76", "M58 54 L78 70",                   // arms
    "M56 94 L40 124 L36 148",                           // back leg
    "M56 94 L74 122 L80 148",                           // front leg
  ],
};

export const StickFigure: React.FC<{ pose: string; size?: number; delay?: number; opacity?: number }> =
  ({ pose, size = 600, delay = 4, opacity = 1 }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const paths = POSES[pose];
    if (!paths) return null;
    const bob = Math.sin((frame / fps) * Math.PI * 2 * 0.4) * 3;   // idle life
    const LEN = 300;
    return (
      <svg width={size} height={size * (160 / 120)} viewBox="0 0 120 160"
        style={{ opacity, transform: `translateY(${bob}px)`,
          filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.5))" }}>
        {paths.map((d, i) => {
          const draw = spring({ frame: frame - delay - i * 3, fps, config: springs.draw });
          return (
            <path key={i} d={d} fill="none" stroke={palette.white} strokeWidth={5}
              strokeLinecap="round" strokeLinejoin="round"
              strokeDasharray={LEN} strokeDashoffset={LEN * (1 - draw)} />
          );
        })}
      </svg>
    );
  };
