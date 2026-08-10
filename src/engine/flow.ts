// Advected streakline flow: a velocity field (wind + fBm curl) plus helpers to
// seed, advance, and sample arc-length-spaced trails. Pure and framework-agnostic.
import { curlFbm } from './noise';

export interface FlowParams {
  windX: number; // wind velocity x (px/frame)
  windY: number; // wind velocity y (px/frame)
  invScale: number; // 1 / spatial wavelength (noise-units per px)
  strength: number; // curl velocity scale (px/frame)
  driftX: number; // domain drift offset x (noise units)
  driftY: number; // domain drift offset y (noise units)
  octaves: number; // fBm octaves
  gain: number; // fBm amplitude falloff
}

export interface TrailPoint {
  x: number;
  y: number;
}

export interface TrailState {
  pts: TrailPoint[]; // most-recent (head) first, spaced ~spacing by arc length
  carry: number; // leftover arc length since the last pushed point
}

export interface Placement {
  x: number;
  y: number;
  tx: number; // unit tangent x (flow direction at this point)
  ty: number; // unit tangent y
  env: number; // [0,1] envelope, fades head and tail
}

export function flowVelocity(
  x: number,
  y: number,
  t: number,
  p: FlowParams,
): [number, number] {
  if (p.strength === 0) return [p.windX, p.windY];
  const [cx, cy] = curlFbm(
    x * p.invScale + p.driftX,
    y * p.invScale + p.driftY,
    t,
    p.octaves,
    p.gain,
  );
  return [p.windX + cx * p.strength, p.windY + cy * p.strength];
}

export function seedTrail(
  hx: number,
  hy: number,
  t: number,
  p: FlowParams,
  spacing: number,
  cap: number,
  st: TrailState,
): void {
  st.pts.length = 0;
  st.carry = 0;
  let x = hx;
  let y = hy;
  st.pts.push({ x, y });
  while (st.pts.length < cap) {
    const [vx, vy] = flowVelocity(x, y, t, p);
    let sp = Math.hypot(vx, vy);
    let ux: number;
    let uy: number;
    if (sp < 1e-6) {
      // Calm spot: fall back to the wind direction so seeding still progresses.
      sp = Math.hypot(p.windX, p.windY) || 1;
      ux = p.windX / sp;
      uy = p.windY / sp;
    } else {
      ux = vx / sp;
      uy = vy / sp;
    }
    // Step one spacing upstream (against the local flow direction).
    x -= ux * spacing;
    y -= uy * spacing;
    st.pts.push({ x, y });
  }
}

export function advanceTrail(
  st: TrailState,
  hx: number,
  hy: number,
  t: number,
  p: FlowParams,
  spacing: number,
  cap: number,
): TrailPoint {
  let x = hx;
  let y = hy;
  // Sub-step the frame so each step moves at most ~spacing, keeping the pushed
  // points evenly arc-spaced even when the flow is fast.
  let v = flowVelocity(x, y, t, p);
  let vx = v[0];
  let vy = v[1];
  const sub = Math.max(1, Math.ceil((Math.hypot(vx, vy) / spacing) * 4));
  const h = 1 / sub;
  for (let s = 0; s < sub; s++) {
    // Reuse the velocity sampled before the loop; re-sample only after moving.
    if (s > 0) {
      v = flowVelocity(x, y, t, p);
      vx = v[0];
      vy = v[1];
    }
    const nx = x + vx * h;
    const ny = y + vy * h;
    st.carry += Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
    while (st.carry >= spacing) {
      st.carry -= spacing;
      st.pts.unshift({ x, y });
    }
  }
  while (st.pts.length > cap) st.pts.pop();
  return { x, y };
}

// Resample the body each frame by walking back from the LIVE head along the
// polyline [head, pts[0], pts[1], ...] at arc-length multiples of `spacing`.
// Because blob 0 sits on the continuously-advancing head (not on a discrete
// stored point that only updates on spacing crossings), the body moves smoothly
// every frame. Pushing a new trail point doesn't change the polyline's shape,
// so it causes no discontinuity. Returns [] if there isn't a head + >=1 point.
export function walkTrail(
  headX: number,
  headY: number,
  pts: TrailPoint[],
  count: number,
  spacing: number,
): Placement[] {
  const out: Placement[] = [];
  if (count < 2 || pts.length < 1) return out;

  // Polyline vertices, head (newest) first.
  const vx = [headX];
  const vy = [headY];
  for (const p of pts) {
    vx.push(p.x);
    vy.push(p.y);
  }
  const m = vx.length;

  // Cumulative arc length from the head.
  const cum = [0];
  for (let k = 1; k < m; k++) {
    cum.push(cum[k - 1] + Math.hypot(vx[k] - vx[k - 1], vy[k] - vy[k - 1]));
  }
  const total = cum[m - 1];

  // First pass: resample positions + envelope at arc-length multiples of spacing.
  // `target` only increases, so the segment cursor `k` never moves backward —
  // carry it across iterations for an O(m + count) walk instead of O(m * count).
  let k = 0;
  for (let i = 0; i < count; i++) {
    const target = Math.min(i * spacing, total);
    // Advance the segment cursor to the one containing `target`.
    while (k + 1 < m && cum[k + 1] < target) k++;

    let x: number;
    let y: number;
    if (k + 1 < m) {
      const segLen = cum[k + 1] - cum[k];
      const f = segLen > 1e-9 ? (target - cum[k]) / segLen : 0;
      x = vx[k] + (vx[k + 1] - vx[k]) * f;
      y = vy[k] + (vy[k + 1] - vy[k]) * f;
    } else {
      // Past the last vertex (trail too short): clamp to the tail.
      x = vx[m - 1];
      y = vy[m - 1];
    }
    const env = Math.sin((i / (count - 1)) * Math.PI);
    out.push({ x, y, tx: 0, ty: 0, env });
  }

  // Second pass: tangent from the NEIGHBOUR sample positions (which move
  // smoothly), not the raw polyline segment. Taking it from a single segment
  // made the orientation snap whenever a sample crossed a stored vertex (the
  // segments differ in direction on a curved path) — a visible shimmer on the
  // elongated blobs. Neighbour-based tangents vary continuously.
  for (let i = 0; i < count; i++) {
    const newer = out[Math.max(i - 1, 0)]; // toward the head
    const older = out[Math.min(i + 1, count - 1)];
    const tx = newer.x - older.x; // older -> newer = flow direction
    const ty = newer.y - older.y;
    const len = Math.hypot(tx, ty) || 1;
    out[i].tx = tx / len;
    out[i].ty = ty / len;
  }
  return out;
}

// Pick a head position on the UPWIND edge of the screen+margin, off-screen, so
// a respawned stroke's body (which trails upstream) stays fully off-screen and
// drifts onto the screen instead of materializing within it. `perpParam` in
// [0,1) spreads heads across the perpendicular extent. Used for in-flight
// respawn; initial fill still scatters across the whole area for instant
// coverage.
export function inflowHead(
  W: number,
  H: number,
  angle: number,
  margin: number,
  perpParam: number,
): TrailPoint {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const axisLen = W * Math.abs(ca) + H * Math.abs(sa);
  const perpLen = W * Math.abs(sa) + H * Math.abs(ca);
  const along = -(axisLen / 2 + margin); // upwind, beyond the screen half-extent
  const lane = (perpParam - 0.5) * perpLen * 1.1;
  return {
    x: W / 2 + ca * along - sa * lane,
    y: H / 2 + sa * along + ca * lane,
  };
}
