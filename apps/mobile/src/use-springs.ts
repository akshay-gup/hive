import { useEffect, useRef, useState } from "react";
import { settled, stepSpring } from "./liquid-tabs-geometry";

/**
 * Springs that follow `targets`, one for each, redrawing on every frame while any is moving and not
 * at all once they have settled. With `still` they jump straight to the targets.
 */
export function useSprings(targets: number[], still: boolean): number[] {
  const [values, setValues] = useState(targets);
  const motion = useRef({ x: targets, v: targets.map(() => 0) });
  const key = targets.join(",");

  useEffect(() => {
    const goal = key.split(",").map(Number);
    const state = motion.current;
    if (still) {
      state.x = goal;
      state.v = goal.map(() => 0);
      setValues(goal);
      return;
    }
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      const seconds = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      let moving = false;
      const next = state.x.map((x, i) => {
        const step = stepSpring(x, state.v[i], goal[i], seconds);
        const done = settled(step.position, step.velocity, goal[i]);
        state.v[i] = done ? 0 : step.velocity;
        if (!done) moving = true;
        return done ? goal[i] : step.position;
      });
      state.x = next;
      setValues(next);
      if (moving) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [key, still]);

  return values;
}
