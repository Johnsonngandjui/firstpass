// Minimal emphasis beat: small eyebrow, one big white word with a slight spring
// pop, hairline underline sweep. Soft white bloom for presence, no color.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { palette, type, springs } from "../theme";
import { Glow, CameraDrift, useExit } from "../components/cinematic";

// style "outline": hollow stroked letters — louder without being heavier.
export const Punch: React.FC<{ eyebrow: string; word: string; style?: "solid" | "outline" }> =
  ({ eyebrow, word, style = "solid" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit();

  const pop = spring({ frame, fps, config: springs.pop });
  const fade = spring({ frame, fps, config: springs.draw });
  const eye = spring({ frame: frame - 4, fps, config: springs.draw });
  const underline = spring({ frame: frame - 8, fps, config: springs.draw });
  const op = fade * exit;

  return (
    <CameraDrift>
      <AbsoluteFill style={{ fontFamily: type.family, justifyContent: "flex-end",
        alignItems: "center", paddingBottom: 560 }}>
        <Glow x={1320} y={1150} w={1200} h={560} opacity={op * 0.5} />
        <div style={{ fontSize: 56, ...type.eyebrow, opacity: eye * exit,
          transform: `translateY(${interpolate(eye, [0, 1], [20, 0])}px)`,
          marginBottom: 30 }}>{eyebrow}</div>
        <div style={{ fontSize: 380, ...type.headline, letterSpacing: -4,
          opacity: op, transform: `scale(${interpolate(pop, [0, 1], [0.78, 1])})`,
          ...(style === "outline"
            ? { color: "transparent", WebkitTextStroke: `4px ${palette.white}`,
                filter: "drop-shadow(0 6px 24px rgba(0,0,0,0.55))" }
            : { color: palette.white, textShadow: type.shadow }) }}>{word}</div>
        <div style={{ height: 4, borderRadius: 4, marginTop: 26, opacity: op,
          width: interpolate(underline, [0, 1], [0, 820]), background: palette.hairline }} />
      </AbsoluteFill>
    </CameraDrift>
  );
};
