import Svg, { Rect } from "react-native-svg";
import type { LiquidTile } from "./liquid-tabs-geometry";
import { colors } from "./theme";

/** The width of a selected tile's outline. */
const OUTLINE = 1.5;

/**
 * The tiles of a row of tabs. React Native has no blur-and-sharpen filter, so here the tiles slide
 * through each other and apart without the stretching neck the web has. The selected tab's fill
 * and outline are drawn over its tile.
 */
export function LiquidShapes({
  width,
  height,
  tiles,
  fill,
  line,
}: {
  width: number;
  height: number;
  tiles: LiquidTile[];
  /** What the selected tile is filled with, and the outline round it. */
  fill: string;
  line: string;
}) {
  const radius = height / 2;
  const inset = OUTLINE / 2;
  return (
    <Svg
      width={width}
      height={height}
      pointerEvents="none"
      style={{ position: "absolute", left: 0, top: 0 }}
    >
      {tiles.map((tile) => (
        <Rect
          key={tile.id}
          x={tile.x}
          y={0}
          width={tile.width}
          height={height}
          rx={radius}
          fill={colors.tile}
        />
      ))}
      {tiles.map(
        (tile) =>
          tile.tint > 0.01 && (
            <Rect
              key={tile.id}
              x={tile.x + inset}
              y={inset}
              width={Math.max(0, tile.width - OUTLINE)}
              height={height - OUTLINE}
              rx={radius - inset}
              fill={fill}
              fillOpacity={tile.tint}
              stroke={line}
              strokeWidth={OUTLINE}
              strokeOpacity={tile.tint}
            />
          ),
      )}
    </Svg>
  );
}
