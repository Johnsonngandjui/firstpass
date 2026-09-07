// Figure card — a stick figure draws itself into the scene with an optional
// tracked caption beneath. Charm over realism; still monochrome, still quiet.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { palette, type, springs } from "../theme";
import { CameraDrift, useExit } from "../components/cinematic";
import { StickFigure } from "../components/figures";

export const FigureCard: React.FC<{ pose: string; caption?: string; align?: "center" | "right" }> =
  ({ pose, caption, align = "center" }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const exit = useExit();
    const cap = spring({ frame: frame - 16, fps, config: springs.draw });
    return (
      <CameraDrift>
        <AbsoluteFill style={{ fontFamily: type.family, justifyContent: "center",
          alignItems: align === "right" ? "flex-end" : "center",
          paddingRight: align === "right" ? 340 : 0 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 40 }}>
            <StickFigure pose={pose} size={560} opacity={exit} />
            {caption ? (
              <div style={{ fontSize: 56, ...type.eyebrow, letterSpacing: 14,
                color: palette.white, opacity: cap * exit, textShadow: type.shadow,
                transform: `translateY(${interpolate(cap, [0, 1], [14, 0])}px)` }}>{caption}</div>
            ) : null}
          </div>
        </AbsoluteFill>
      </CameraDrift>
    );
  };
