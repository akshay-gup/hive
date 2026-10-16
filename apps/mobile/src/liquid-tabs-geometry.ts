/**
 * The shapes of a liquid row of tabs. The row is a line of pill-shaped tiles, one to a tab. Where
 * two neighbours are joined, their rounded ends sit inside each other so the row reads as one
 * unbroken slab. Where the selected tab has pulled away, they are a gap apart. Between the two,
 * on the way, the ends slide through each other, and the web blurs and sharpens the whole row so
 * the ends stretch into a thinning neck before they let go.
 */

/** A spring that bounces a little, so the neck snaps back rather than just stopping. */
export const SPRING = { stiffness: 180, damping: 17 } as const;

export interface LiquidTile {
  id: string;
  /** Left edge and width, in the row's own pixels. */
  x: number;
  width: number;
  /** How much of the selected tab's colour it shows, 0 to 1. */
  tint: number;
}

/**
 * Which seams should be open for tab `active` (or none, when it is -1). Seam `s` is the one to the
 * left of tab `s`, so seams 1 to `count - 1` lie between tabs; the ends of the row have none. The
 * list is one longer than the tabs, and its first and last entries are never used.
 */
export function openTargets(count: number, active: number): number[] {
  return Array.from({ length: count + 1 }, (_, seam) =>
    active >= 0 && seam > 0 && seam < count && (seam === active || seam === active + 1) ? 1 : 0,
  );
}

/** How tinted each tile should be: all of it for the selected tab, none for the rest. */
export function tintTargets(count: number, active: number): number[] {
  return Array.from({ length: count }, (_, i) => (i === active ? 1 : 0));
}

/**
 * How far apart the ends of the two tiles at a seam are, for how open it is (0 joined, 1 apart).
 * Joined, each end reaches a whole radius past the seam, so the two overlap by a full diameter and
 * the flat tops and bottoms run on without a break.
 */
export function seamSeparation(open: number, radius: number, gap: number): number {
  return -2 * radius + open * (2 * radius + gap);
}

/**
 * Where each tile is, given how open each seam is and how tinted each tile. `bounds` are the
 * seams at rest, left to right: the left end of the row, each place two tabs meet, and the right
 * end. The tabs need not be the same width.
 */
export function layoutTiles({
  bounds,
  height,
  ids,
  opens,
  tints,
  gap,
}: {
  bounds: number[];
  height: number;
  /** One for each tile, in order. */
  ids: string[];
  opens: number[];
  /** One for each tile. */
  tints: number[];
  gap: number;
}): LiquidTile[] {
  const count = ids.length;
  const radius = height / 2;
  return ids.map((id, i) => {
    const left = i === 0 ? bounds[0] : bounds[i] + seamSeparation(opens[i], radius, gap) / 2;
    const right =
      i === count - 1
        ? bounds[count]
        : bounds[i + 1] - seamSeparation(opens[i + 1], radius, gap) / 2;
    return { id, x: left, width: right - left, tint: Math.max(0, Math.min(1, tints[i])) };
  });
}

/** One step of a spring, small enough steps to stay steady however long the frame took. */
export function stepSpring(
  position: number,
  velocity: number,
  target: number,
  seconds: number,
): { position: number; velocity: number } {
  const steps = Math.max(1, Math.ceil(seconds * 240));
  const h = seconds / steps;
  let x = position;
  let v = velocity;
  for (let i = 0; i < steps; i++) {
    v += (-SPRING.stiffness * (x - target) - SPRING.damping * v) * h;
    x += v * h;
  }
  return { position: x, velocity: v };
}

/** Close enough to its target, and slow enough, to stop moving it. */
export function settled(position: number, velocity: number, target: number): boolean {
  return Math.abs(position - target) < 0.002 && Math.abs(velocity) < 0.01;
}
