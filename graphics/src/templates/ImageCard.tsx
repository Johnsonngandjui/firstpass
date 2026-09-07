// Image card — a photo (from graphics/public/) in a thin frame, fading up with
// a slow settle and optional caption. Put stills in graphics/public/ and refer
// to them by filename in the spec.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Img, staticFile } from "remotion";
import { palette, type, springs } from "../theme";
import { CameraDrift, useExit } from "../components/cinematic";

export const ImageCard: React.FC<{ image: string; caption?: string; width?: number; tilt?: number }> =
  ({ image, caption, width = 1400, tilt = -1.5 }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const exit = useExit();
    const inn = spring({ frame, fps, config: springs.settle });
    const cap = spring({ frame: frame - 12, fps, config: springs.draw });
    return (
      <CameraDrift>
        <AbsoluteFill style={{ fontFamily: type.family, justifyContent: "center", alignItems: "center" }}>
          <div style={{ opacity: inn * exit, transform:
            `translateY(${interpolate(inn, [0, 1], [70, 0])}px) rotate(${tilt}deg) scale(${interpolate(inn, [0, 1], [0.96, 1])})` }}>
            <div style={{ padding: 24, background: "rgba(245,245,245,0.96)",
              boxShadow: "0 50px 140px rgba(0,0,0,0.55)" }}>
              <Img src={staticFile(image)} style={{ width, display: "block" }} />
            </div>
            {caption ? (
              <div style={{ marginTop: 44, textAlign: "center", fontSize: 52, ...type.eyebrow,
                letterSpacing: 12, color: palette.white, opacity: cap, textShadow: type.shadow }}>{caption}</div>
            ) : null}
          </div>
        </AbsoluteFill>
      </CameraDrift>
    );
  };
