// Spec-driven root: compositions are generated from spec/active.json, so a new
// video means editing a spec file — never this code. render.mjs copies the
// chosen spec to spec/active.json before rendering.
import React from "react";
import { Composition } from "remotion";
import spec from "../spec/active.json";
import { LowerThird } from "./templates/LowerThird";
import { Punch } from "./templates/Punch";
import { ListStack } from "./templates/ListStack";
import { LocationCard, TimeCard, ThoughtCard, DataCard, ChapterCard } from "./templates/VlogCards";
import { FigureCard } from "./templates/FigureCard";
import { ImageCard } from "./templates/ImageCard";

// Remotion needs an integer-friendly fps; we render 30 and the ~0.1% drift vs a
// 29.97 timeline is <5ms on clips this short (see graphics/GRAPHICS.md).
const FPS = 30;

const TEMPLATES: Record<string, React.FC<any>> = {
  lowerThird: LowerThird,
  punch: Punch,
  listStack: ListStack,
  // the vlog visual language (see VlogCards.tsx)
  locationCard: LocationCard,
  timeCard: TimeCard,
  thoughtCard: ThoughtCard,
  dataCard: DataCard,
  chapterCard: ChapterCard,
  // art
  figureCard: FigureCard,
  imageCard: ImageCard,
};

export const RemotionRoot: React.FC = () => (
  <>
    {spec.graphics.map((g: any) => {
      const C = TEMPLATES[g.template];
      if (!C) throw new Error(`Unknown template "${g.template}" in spec (id ${g.id})`);
      return (
        <Composition key={g.id} id={g.id} component={C}
          durationInFrames={Math.max(1, Math.round(g.durationSec * FPS))}
          fps={FPS} width={spec.sequence.frameWidth} height={spec.sequence.frameHeight}
          defaultProps={g.props} />
      );
    })}
  </>
);
