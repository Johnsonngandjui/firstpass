// Minimal list build: white items entering with staggered springs, each marked
// by a small hollow circle — no color, no fills.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { palette, type, springs, timing } from "../theme";
import { CameraDrift, useExit } from "../components/cinematic";
import { LineIcon } from "../components/art";

// items: strings, or { text, icon } for a line-art glyph in place of the circle.
export const ListStack: React.FC<{ items: (string | { text: string; icon?: string })[] }> = ({ items }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit();
  return (
    <CameraDrift>
      <AbsoluteFill style={{ fontFamily: type.family, justifyContent: "center",
        alignItems: "flex-end", paddingRight: 320 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 56 }}>
          {items.map((raw, k) => {
            const it = typeof raw === "string" ? { text: raw } : raw;
            const s = spring({ frame: frame - (6 + k * timing.staggerFrames), fps, config: springs.settle });
            return (
              <div key={k} style={{ display: "flex", alignItems: "center",
                justifyContent: "flex-end", gap: 44, opacity: s * exit,
                transform: `translateX(${interpolate(s, [0, 1], [120, 0])}px)` }}>
                <span style={{ fontSize: 170, ...type.headline, color: palette.white,
                  textShadow: type.shadow }}>{it.text}</span>
                {it.icon
                  ? <LineIcon name={it.icon} size={130} delay={8 + k * timing.staggerFrames} opacity={exit} />
                  : <span style={{ width: 30, height: 30, borderRadius: "50%",
                      border: `4px solid ${palette.hairline}`, transform: `scale(${s})` }} />}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </CameraDrift>
  );
};
