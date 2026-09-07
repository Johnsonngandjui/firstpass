// Headroom highlight overlay: dims everything OUTSIDE a rounded focus box and
// strokes the box's outline. Styles: fade (opacity), draw (outline draws
// around the box), wipe (reveals left→right). Timing comes as explicit
// in/out frame counts (hold = the remainder), because Headroom's UI works in
// frames like an editor does.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

export const Highlight: React.FC<{
  x: number; y: number; w: number; h: number;      // box, fractions of frame
  color?: string; thickness?: number; radius?: number;
  dim?: number;                                     // 0..1 outside dim opacity
  style?: "fade" | "draw" | "wipe";
  inFrames?: number; outFrames?: number;
}> = ({ x, y, w, h, color = "#f5f5f5", thickness = 6, radius = 18,
        dim = 0.5, style = "fade", inFrames = 24, outFrames = 24 }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H, durationInFrames } = useVideoConfig();

  const bx = x * W, by = y * H, bw = w * W, bh = h * H;
  const r = Math.min(radius, bw / 2, bh / 2);

  const tin  = interpolate(frame, [0, Math.max(1, inFrames)], [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const tout = interpolate(frame, [durationInFrames - Math.max(1, outFrames), durationInFrames],
    [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const life = Math.min(tin, tout);
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);

  // per-style progress: what the entrance animates (exit is always a fade)
  const enter = ease(tin);
  const dimOp = dim * ease(life);

  const perim = 2 * (bw + bh);
  const boxPath =
    `M ${bx + r} ${by} H ${bx + bw - r} Q ${bx + bw} ${by} ${bx + bw} ${by + r}` +
    ` V ${by + bh - r} Q ${bx + bw} ${by + bh} ${bx + bw - r} ${by + bh}` +
    ` H ${bx + r} Q ${bx} ${by + bh} ${bx} ${by + bh - r}` +
    ` V ${by + r} Q ${bx} ${by} ${bx + r} ${by} Z`;

  const outlineOpacity = style === "fade" ? enter * tout : tout;
  const dash = style === "draw"
    ? { strokeDasharray: perim, strokeDashoffset: perim * (1 - enter) }
    : {};
  const wipeClip = style === "wipe"
    ? { clipPath: `inset(0 ${(1 - enter) * 100}% 0 0)` } : {};

  return (
    <AbsoluteFill>
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        {/* outside dim: full frame with the focus box punched out */}
        <path fillRule="evenodd"
          d={`M 0 0 H ${W} V ${H} H 0 Z ${boxPath}`}
          fill={`rgba(0,0,0,${dimOp})`} />
      </svg>
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, ...wipeClip }}>
        <path d={boxPath} fill="none" stroke={color} strokeWidth={thickness}
          strokeLinecap="round" opacity={outlineOpacity} {...dash} />
      </svg>
    </AbsoluteFill>
  );
};
