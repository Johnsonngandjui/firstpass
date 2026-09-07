// Minimal lower-third: hairline rule, wide-tracked eyebrow, two-weight headline
// (light support + bold accent) wiped in left→right. Type directly over footage
// with a soft shadow — no panel, no icon.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { palette, type, springs, timing } from "../theme";
import { CameraDrift, useExit } from "../components/cinematic";
import { LineIcon } from "../components/art";

export const LowerThird: React.FC<{ eyebrow: string; pre: string; accent: string; icon?: string }> =
  ({ eyebrow, pre, accent, icon }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const exit = useExit();

    const enter = spring({ frame, fps, config: springs.settle });
    const rise = interpolate(enter, [0, 1], [60, 0]);
    const op = enter * exit;

    const rule = spring({ frame: frame - 2, fps, config: springs.draw });
    const eyeIn = spring({ frame: frame - timing.eyebrowDelay, fps, config: springs.draw });
    const wipe = interpolate(spring({ frame: frame - 14, fps, config: springs.draw }), [0, 1], [0, 100]);

    return (
      <CameraDrift>
        <AbsoluteFill style={{ fontFamily: type.family }}>
          <div style={{ position: "absolute", left: 260, bottom: 340, opacity: op,
            transform: `translateY(${rise}px)` }}>
            {/* hairline rule grows in */}
            <div style={{ height: 3, width: interpolate(rule, [0, 1], [0, 420]),
              background: palette.hairline, marginBottom: 34 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 34, marginBottom: 26 }}>
              {icon ? <LineIcon name={icon} size={96} delay={4} opacity={eyeIn * exit} /> : null}
              <div style={{ fontSize: 52, ...type.eyebrow, opacity: eyeIn,
                transform: `translateX(${interpolate(eyeIn, [0, 1], [24, 0])}px)` }}>{eyebrow}</div>
            </div>
            <div style={{ fontSize: 190, lineHeight: 1.04, whiteSpace: "nowrap",
              textShadow: type.shadow, clipPath: `inset(0 ${100 - wipe}% 0 -10%)` }}>
              <span style={{ ...type.support, color: palette.soft }}>{pre} </span>
              <span style={{ ...type.headline, color: palette.white }}>{accent}</span>
            </div>
          </div>
        </AbsoluteFill>
      </CameraDrift>
    );
  };
