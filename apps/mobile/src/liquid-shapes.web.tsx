import { useId } from "react";
import type { LiquidTile } from "./liquid-tabs-geometry";
import { colors } from "./theme";

/** The width of a selected tile's outline. */
const OUTLINE = 1.5;

/**
 * The tiles of a row of tabs, made liquid. Every tile is drawn in one plain colour, the whole row
 * is blurred and its edge sharpened again, so two tiles that come close grow a neck between them
 * and then let go. The selected tab's fill and outline go on top as a plain rounded shape, outside
 * that filter, so the colours never bleed into each other. The blur is in proportion to the
 * height, since that sets how far a neck can reach.
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
  const id = `liquid${useId().replace(/\W/g, "")}`;
  const radius = height / 2;
  const blur = height * 0.09;
  const reach = Math.ceil(blur * 2.5);
  const inset = OUTLINE / 2;
  return (
    <svg
      aria-hidden
      focusable="false"
      width={width}
      height={height}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}
    >
      <defs>
        <filter
          id={id}
          filterUnits="userSpaceOnUse"
          x={-reach}
          y={-reach}
          width={width + reach * 2}
          height={height + reach * 2}
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11"
          />
        </filter>
      </defs>
      <g filter={`url(#${id})`}>
        {tiles.map((tile) => (
          <rect
            key={tile.id}
            x={tile.x}
            y={0}
            width={tile.width}
            height={height}
            rx={radius}
            fill={colors.tile}
          />
        ))}
      </g>
      {tiles.map(
        (tile) =>
          tile.tint > 0.01 && (
            <rect
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
    </svg>
  );
}
