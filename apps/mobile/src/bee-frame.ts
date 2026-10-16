/** The animation frames are 352 by 288, with room around the bee for its wings. */
export const FRAME_RATIO = 352 / 288;

/**
 * How tall a frame is for each unit of `Mascot` size, so that the bee in it is as wide as the
 * still bee in the same size. Measured from the art: the still bee is 466 of its 512 pixels wide,
 * and across the three loops the moving bee averages 721 of a frame's 880, which is as wide as the
 * frame is tall (721 / 880 * 352 / 288 is 1.0). So a frame is 466 / 512 of the size tall.
 */
export const FRAME_PER_SIZE = 466 / 512;

/** How far below the middle of the frame the bee sits: it rests a little above it, to leave room for the wings. */
const DROP = 0.025;

/** Where the frame goes inside a box `size` on a side, as the still bee fills it, so the two swap without moving. */
export function beeFrame(size: number) {
  const height = Math.round(size * FRAME_PER_SIZE);
  const width = Math.round(height * FRAME_RATIO);
  return {
    width,
    height,
    left: Math.round((size - width) / 2),
    top: Math.round((size - height) / 2 + height * DROP),
  };
}
