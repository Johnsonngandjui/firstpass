// ── Shared cinematic building blocks ─────────────────────────────────────────
// Every template composes these instead of re-implementing effects, so grain,
// glow, camera motion and enter/exit behave IDENTICALLY across all graphics.
// Everything is a pure function of the frame → renders are deterministic.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, random } from "remotion";
import { palette, springs, timing, texture, camera } from "../theme";

// Animated film grain (~5% opacity). SVG turbulence with a per-frame seed —
// remotion's random() is seeded, so frame N looks the same on every render.
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = texture.grainOpacity }) => {
  const frame = useCurrentFrame();
  const seed = Math.floor(random(`grain-${frame}`) * 1000);
  return (
    <AbsoluteFill style={{ opacity, pointerEvents: "none", mixBlendMode: "overlay" }}>
      <svg width="100%" height="100%">
        <filter id={`gr${seed}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#gr${seed})`} />
      </svg>
    </AbsoluteFill>
  );
};

// Warm radial glow with a slow breathing pulse.
export const Glow: React.FC<{ x: number; y: number; w: number; h: number; opacity?: number }> =
  ({ x, y, w, h, opacity = 1 }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const pulse = 0.7 + 0.3 * Math.sin((frame / fps) * Math.PI * 2 * texture.glowPulseHz);
    return (
      <div style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: "50%",
        background: `radial-gradient(closest-side, ${palette.glow}, transparent)`,
        filter: `blur(${texture.glowBlurPx}px)`, opacity: opacity * pulse }} />
    );
  };

// Slow camera push-in + barely-perceptible drift across the graphic's life —
// the "cinematic camera move" applied uniformly to the whole composition.
export const CameraDrift: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = frame / Math.max(1, durationInFrames - 1);
  const scale = interpolate(t, [0, 1], [camera.pushFrom, camera.pushTo]);
  const dx = Math.sin(t * Math.PI) * camera.driftPx;
  return (
    <AbsoluteFill style={{ transform: `scale(${scale}) translateX(${dx}px)` }}>
      {children}
    </AbsoluteFill>
  );
};

// Standardized lifecycle: spring enter (rise + settle) and uniform tail fade.
// Wrap a template's content in this so every graphic breathes the same way.
export const EnterExit: React.FC<{ children: React.ReactNode; risePx?: number }> =
  ({ children, risePx = 100 }) => {
    const frame = useCurrentFrame();
    const { fps, durationInFrames } = useVideoConfig();
    const enter = spring({ frame, fps, config: springs.settle });
    const exit = interpolate(frame,
      [durationInFrames - timing.exitFrames, durationInFrames], [1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return (
      <AbsoluteFill style={{
        opacity: enter * exit,
        transform: `translateY(${interpolate(enter, [0, 1], [risePx, 0]) + interpolate(exit, [1, 0], [0, 20])}px)`,
      }}>
        {children}
      </AbsoluteFill>
    );
  };

// Uniform exit-only opacity (for elements that manage their own entrance).
export const useExit = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return interpolate(frame,
    [durationInFrames - timing.exitFrames, durationInFrames], [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
};
