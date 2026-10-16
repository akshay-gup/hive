import { LiquidShapes } from "./liquid-shapes";
import { layoutTiles, openTargets, tintTargets } from "./liquid-tabs-geometry";
import { useSprings } from "./use-springs";
import { useStill } from "./use-still";

/**
 * What sits behind a row of tabs: one slab, with the selected tab pulled away from it, and the one
 * you leave flowing back in. `bounds` are the seams of the tabs at rest (the left end, each place
 * two tabs meet, the right end), which the row measures. `active` is -1 when none is selected.
 * Place it behind the tabs, filling the row.
 */
export function LiquidTrack({
  ids,
  active,
  bounds,
  height,
  gap,
  fill,
  line,
}: {
  ids: string[];
  active: number;
  bounds: number[];
  height: number;
  /** How far the selected tab sits from its neighbours. */
  gap: number;
  fill: string;
  line: string;
}) {
  const still = useStill();
  const count = ids.length;
  const moving = useSprings([...openTargets(count, active), ...tintTargets(count, active)], still);
  const tiles = layoutTiles({
    bounds,
    height,
    ids,
    opens: moving.slice(0, count + 1),
    tints: moving.slice(count + 1),
    gap,
  });
  return (
    <LiquidShapes width={bounds[count]} height={height} tiles={tiles} fill={fill} line={line} />
  );
}
