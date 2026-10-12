// Geometry for the time axis. Time runs along a line `angle` degrees below horizontal, so
// older works sit up and to the left and newer works down and to the right. In screen
// coordinates (y grows downward):
//   u = position along the axis (increases with time)
//   v = position across it (increases toward the upper right)

export const DEFAULT_AXIS_ANGLE = 30;
export const MIN_AXIS_ANGLE = 0; // Horizontal: older on the left.
export const MAX_AXIS_ANGLE = 90; // Vertical: older at the top.

/**
 * @param {number} angleDeg  Degrees below horizontal.
 */
export function axisGeometry(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    toU: (x, y) => x * cos + y * sin,
    toV: (x, y) => x * sin - y * cos,
    fromUV: (u, v) => ({ x: u * cos + v * sin, y: u * sin - v * cos }),
    /** Converts a velocity along/across the axis to x/y components. */
    alongAcross: (along, across) => ({
      vx: along * cos + across * sin,
      vy: along * sin - across * cos,
    }),
  };
}
