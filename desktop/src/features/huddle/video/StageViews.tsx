import * as React from "react";

import { ParticipantTile } from "./ParticipantTile";
import type { StageModel, StageTile } from "./stageLayout";
import type { StagePerson } from "./useStageRoster";

type Labels = {
  personFor: (pubkey: string) => StagePerson;
  isSpeaking: (pubkey: string) => boolean;
};

const GAP_PX = 8;
const ASPECT = 16 / 9;

/** Largest 16:9 tile width that fits `count` tiles in `columns` here. */
function useFitWidth(count: number, columns: number) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const rows = Math.max(1, Math.ceil(count / Math.max(columns, 1)));
      const byWidth = (node.clientWidth - GAP_PX * (columns - 1)) / columns;
      const byHeight =
        ((node.clientHeight - GAP_PX * (rows - 1)) / rows) * ASPECT;
      setWidth(Math.max(0, Math.floor(Math.min(byWidth, byHeight))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [columns, count]);
  return { ref, width };
}

function Tile({
  tile,
  large,
  fit,
  labels,
  compact,
  className,
  style,
}: {
  tile: StageTile;
  large: boolean;
  fit: "cover" | "contain";
  labels: Labels;
  compact?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <ParticipantTile
      className={className}
      compact={compact}
      fit={fit}
      large={large}
      person={labels.personFor(tile.pubkey)}
      speaking={labels.isSpeaking(tile.pubkey)}
      style={style}
      tile={tile}
    />
  );
}

export function StageGrid({
  model,
  labels,
}: {
  model: Extract<StageModel, { mode: "grid" }>;
  labels: Labels;
}) {
  const { ref, width } = useFitWidth(model.tiles.length, model.columns);
  return (
    <div
      className="flex min-h-0 flex-1 flex-wrap content-center items-center justify-center gap-2 overflow-hidden"
      data-testid="huddle-stage-grid"
      ref={ref}
    >
      {model.tiles.map((tile) => (
        <Tile
          fit={tile.kind === "screen" ? "contain" : "cover"}
          key={tile.key}
          labels={labels}
          large={model.large.has(tile.key)}
          style={{ width, height: width / ASPECT }}
          tile={tile}
        />
      ))}
    </div>
  );
}

export function StagePresentation({
  model,
  labels,
  focused,
}: {
  model: Extract<StageModel, { mode: "presentation" }>;
  labels: Labels;
  /** Hide the strip so the main tile gets the whole stage. */
  focused: boolean;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 gap-2"
      data-testid="huddle-stage-presentation"
    >
      <div className="relative min-h-0 min-w-0 flex-1">
        <Tile
          className="absolute inset-0"
          fit="contain"
          labels={labels}
          large
          tile={model.main}
        />
      </div>
      {focused || model.strip.length === 0 ? null : (
        <ul
          aria-label="Other participants"
          className="flex w-56 shrink-0 flex-col gap-2 overflow-y-auto"
        >
          {model.strip.map((tile) => (
            <li className="shrink-0" key={tile.key}>
              <Tile
                className="aspect-video w-full"
                compact
                fit={tile.kind === "screen" ? "contain" : "cover"}
                labels={labels}
                large={false}
                tile={tile}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
