// ── The vlog visual language: five recurring cards ───────────────────────────
// A24/documentary restraint: footage is the hero; each card is typography that
// resolves into place, holds, and leaves. No effects that announce themselves.
// All monochrome, all token-driven, all wrapped in the same slow camera push.
//
//   locationCard  06:14 AM ─── LYNN, MASSACHUSETTS   (slow fade + upward move)
//   timeCard      5:00 AM                            (large type, 105% → 100%)
//   thoughtCard   DISCIPLINE / IS FREEDOM            (lines resolve one by one)
//   dataCard      5.2 MI · 8:42 /MI · 152 BPM        (numbers count up subtly)
//   chapterCard   01 / THE MORNING                   (signature chapter break)
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { palette, type, springs, timing } from "../theme";
import { CameraDrift, useExit } from "../components/cinematic";

// A. Location card — quiet establishing info, lower-left. Slow fade + rise.
export const LocationCard: React.FC<{ time: string; place: string }> = ({ time, place }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit();
  const inn = spring({ frame, fps, config: springs.draw });
  const rule = spring({ frame: frame - 6, fps, config: springs.draw });
  const op = inn * exit;
  return (
    <CameraDrift>
      <AbsoluteFill style={{ fontFamily: type.family }}>
        <div style={{ position: "absolute", left: 260, bottom: 380, opacity: op,
          transform: `translateY(${interpolate(inn, [0, 1], [26, 0])}px)`, textShadow: type.shadow }}>
          <div style={{ fontSize: 92, fontWeight: 300, color: palette.white,
            fontVariantNumeric: "tabular-nums", letterSpacing: 2 }}>{time}</div>
          <div style={{ height: 2, width: interpolate(rule, [0, 1], [0, 330]),
            background: palette.hairline, margin: "26px 0" }} />
          <div style={{ fontSize: 44, ...type.eyebrow, letterSpacing: 12 }}>{place}</div>
        </div>
      </AbsoluteFill>
    </CameraDrift>
  );
};

// B. Time card — the moment, huge. Settles from 105% → 100% while fading in.
export const TimeCard: React.FC<{ time: string; meridiem?: string }> = ({ time, meridiem }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit();
  const inn = spring({ frame, fps, config: springs.draw });
  const op = inn * exit;
  const scale = interpolate(inn, [0, 1], [1.05, 1.0]);
  return (
    <CameraDrift>
      <AbsoluteFill style={{ fontFamily: type.family, justifyContent: "center", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 40, opacity: op,
          transform: `scale(${scale})`, textShadow: type.shadow }}>
          <span style={{ fontSize: 440, fontWeight: 200, letterSpacing: -6, color: palette.white,
            fontVariantNumeric: "tabular-nums" }}>{time}</span>
          {meridiem ? <span style={{ fontSize: 110, fontWeight: 500, letterSpacing: 10,
            color: palette.soft }}>{meridiem}</span> : null}
        </div>
      </AbsoluteFill>
    </CameraDrift>
  );
};

// C. Thought card — centered lines that resolve one by one. Slow. No tricks.
// voice "editorial": serif italic sentence case — for quieter, human beats.
export const ThoughtCard: React.FC<{ lines: string[]; voice?: "caps" | "editorial" }> =
  ({ lines, voice = "caps" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit();
  const lineStyle = voice === "editorial"
    ? { fontFamily: type.serif, fontStyle: "italic" as const, fontWeight: 400,
        fontSize: 132, letterSpacing: 1 }
    : { fontFamily: type.family, fontWeight: 600, fontSize: 150, letterSpacing: 20 };
  return (
    <CameraDrift>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 34 }}>
          {lines.map((ln, k) => {
            const s = spring({ frame: frame - k * (timing.staggerFrames + 6), fps, config: springs.draw });
            return (
              <div key={k} style={{ ...lineStyle,
                color: palette.white, opacity: s * exit, textShadow: type.shadow,
                transform: `translateY(${interpolate(s, [0, 1], [18, 0])}px)` }}>{ln}</div>
            );
          })}
        </div>
      </AbsoluteFill>
    </CameraDrift>
  );
};

// D. Data card — stat rows; purely numeric values count up (tabular digits, no
// jitter), everything else fades in. Right-aligned lower third.
const CountUp: React.FC<{ value: string; progress: number }> = ({ value, progress }) => {
  const n = Number(value);
  if (!isFinite(n) || value.trim() === "") return <>{value}</>;
  const decimals = (value.split(".")[1] || "").length;
  return <>{(n * Math.min(1, progress)).toFixed(decimals)}</>;
};

export const DataCard: React.FC<{ rows: { value: string; unit: string }[] }> = ({ rows }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit();
  return (
    <CameraDrift>
      <AbsoluteFill style={{ fontFamily: type.condensed, justifyContent: "flex-end",
        alignItems: "flex-end", paddingRight: 300, paddingBottom: 340 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 40 }}>
          {rows.map((r, k) => {
            const s = spring({ frame: frame - (4 + k * timing.staggerFrames), fps, config: springs.draw });
            const count = spring({ frame: frame - (4 + k * timing.staggerFrames), fps,
              config: { damping: 30, mass: 1.4 } });
            return (
              <div key={k} style={{ display: "flex", alignItems: "baseline", gap: 30,
                opacity: s * exit, textShadow: type.shadow,
                transform: `translateY(${interpolate(s, [0, 1], [20, 0])}px)` }}>
                <span style={{ fontSize: 170, ...type.stat, color: palette.white }}>
                  <CountUp value={r.value} progress={count} />
                </span>
                <span style={{ fontSize: 60, fontWeight: 500, letterSpacing: 8,
                  color: palette.soft }}>{r.unit}</span>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </CameraDrift>
  );
};

// E. Chapter card — the signature break. Oversized dim number, hairline, title.
export const ChapterCard: React.FC<{ number: string; title: string }> = ({ number, title }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = useExit();
  const num = spring({ frame, fps, config: springs.draw });
  const rule = spring({ frame: frame - 8, fps, config: springs.draw });
  const ttl = spring({ frame: frame - 12, fps, config: springs.draw });
  return (
    <CameraDrift>
      <AbsoluteFill style={{ fontFamily: type.family, justifyContent: "center", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ fontSize: 520, fontWeight: 100, letterSpacing: 8, lineHeight: 1,
            color: palette.dim, opacity: num * exit, fontVariantNumeric: "tabular-nums",
            transform: `translateY(${interpolate(num, [0, 1], [30, 0])}px)` }}>{number}</div>
          <div style={{ height: 2, width: interpolate(rule, [0, 1], [0, 460]),
            background: palette.hairline, margin: "40px 0 44px", opacity: exit }} />
          <div style={{ fontSize: 120, fontWeight: 700, letterSpacing: 30, color: palette.white,
            opacity: ttl * exit, textShadow: type.shadow,
            transform: `translateY(${interpolate(ttl, [0, 1], [16, 0])}px)` }}>{title}</div>
        </div>
      </AbsoluteFill>
    </CameraDrift>
  );
};
