# Advected Streakline Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bounded-offset flow with advection — strokes are carried along the velocity field and their bodies trace the path their head travelled (streaklines), so motion reads as a flowing current instead of a swing.

**Architecture:** A new pure `src/engine/flow.ts` provides the velocity field (`flowVelocity` = wind + magnitude-normalized fBm curl), backward trail seeding, forward trail advance, and arc-length blob placement. `engine.ts` replaces each stroke's scalar `progress` with a head position + an arc-spaced trail buffer; strokes advect, respawn when off-screen, and render blobs along the trail oriented by its tangent.

**Tech Stack:** TypeScript, WebGL 1 (vanilla), React 19, Vite 8, Vitest.

> **Status: implemented, with as-built amendments (see below).** The tasks below
> are the original plan. Several details changed during implementation once
> their visual artifacts surfaced; the amendments section records what actually
> shipped. Where a task and an amendment disagree, **the amendment is correct.**
> The matching design doc (`docs/superpowers/specs/2026-06-17-…-design.md`) has
> been updated to the as-built design.

## As-built amendments

1. **Body is resampled from the live head, not drawn at the stored points.**
   The plan's `trailPlacements(pts, count)` (Task 4) shipped as
   `walkTrail(headX, headY, pts, count, spacing)`: it builds the polyline
   `[head, …pts]` and samples at arc-length multiples of `spacing`, with blob 0
   on the live head. Drawing the discrete stored points directly made the body
   freeze between point-pushes and hop one `spacing` per push (the "jumpy" bug).
   `engine.ts` calls `walkTrail(this.headX, this.headY, this.trail.pts, nSteps,
   spacing)`.

2. **Tangents come from neighbouring resampled positions, not the polyline
   segment.** `walkTrail` runs a second pass setting each blob's tangent from its
   neighbour samples; the per-segment tangent in the original sketch snapped at
   vertex crossings and made the long blobs shimmer.

3. **In-flight respawn enters from the upwind edge, not a random position.**
   The plan's "random position + fade-in" respawn shipped as `inflowHead(W, H,
   angle, margin, perpParam)` — the head is placed just past the upwind edge
   (margin `blobLong`) with its body trailing off-screen, so it drifts on instead
   of materializing mid-screen. The ~0.4s fade-in (`SPAWN_FADE_FRAMES = 24`)
   remains, but for in-flight respawns only.

4. **`rebuildStrokes` keeps strokes in place after the first build.** Only the
   first build scatters (random) for instant coverage; later rebuilds re-seed
   existing strokes' trails at their current heads (no mid-screen re-scatter on a
   slider drag), trim extras, and add new strokes from the upwind edge.

5. **Spawn distance vs cull distance are different.** Cull when the head passes
   screen+`flowMargin` (a full trail, so the body clears); spawn just `blobLong`
   past the upwind edge so strokes re-enter promptly (placing them a full
   trail-length upwind starved the screen).

6. **`advanceTrail` sub-steps the frame** (`sub = ceil(|V|/spacing · 4)`) so
   points stay arc-spaced under fast flow; `walkTrail` uses a single forward
   cursor across samples (O(points)). Per-blob quad constant arrays and the
   `cos/sin(angle)` in `updateFlowParams` are hoisted/cached; tunables are named
   (`BLOB_SPACING_FACTOR`, `SPAWN_FADE_FRAMES`, `FLOW_OCTAVES`, `FLOW_DRIFT`).

## Global Constraints

- `flow = 0` ⇒ the curl term vanishes and `flowVelocity` returns exactly `[windX, windY]` ⇒ straight trails. Verify this invariant.
- `flow.ts` and `noise.ts` stay pure and framework-agnostic (no React, no WebGL, no DOM).
- `engine.ts` stays framework-agnostic (no React imports).
- `flow.ts` reuses `curlFbm`/`fbm3` from `noise.ts`; do not reimplement noise.
- `npm run build` (`tsc -b && vite build`) and `npm run lint` must pass at the end of every task.
- Trail points are spaced by arc length (≈ `blobR · 0.65`), NOT by frame — so body length is independent of frame rate and Speed.
- Orientation comes from the trail tangent, never from a curl `atan2` (the teleport class of bug must not return).

---

### Task 1: `flowVelocity` — the velocity field

**Files:**
- Create: `src/engine/flow.ts`
- Test: `src/engine/flow.test.ts`

**Interfaces:**
- Consumes: `curlFbm` from `./noise`.
- Produces:
  - `interface FlowParams { windX: number; windY: number; invScale: number; strength: number; driftX: number; driftY: number; octaves: number; gain: number; }`
  - `interface TrailPoint { x: number; y: number; }`
  - `interface TrailState { pts: TrailPoint[]; carry: number; }`
  - `interface Placement { x: number; y: number; tx: number; ty: number; env: number; }`
  - `flowVelocity(x: number, y: number, t: number, p: FlowParams): [number, number]`

- [ ] **Step 1: Write the failing test**

Create `src/engine/flow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { flowVelocity, type FlowParams } from './flow';

function params(over: Partial<FlowParams> = {}): FlowParams {
  return {
    windX: 0.5,
    windY: 0.3,
    invScale: 1 / 600,
    strength: 2,
    driftX: 0,
    driftY: 0,
    octaves: 4,
    gain: 0.6,
    ...over,
  };
}

describe('flowVelocity', () => {
  it('equals the wind exactly when strength is 0', () => {
    const p = params({ strength: 0 });
    for (let i = 0; i < 50; i++) {
      const v = flowVelocity(i * 13.1, i * 7.7, i * 0.05, p);
      expect(v[0]).toBe(p.windX);
      expect(v[1]).toBe(p.windY);
    }
  });

  it('is finite and bounded for a wide range of inputs', () => {
    const p = params();
    for (let i = 0; i < 5000; i++) {
      const [vx, vy] = flowVelocity(i * 3.3, -i * 2.1, i * 0.02, p);
      expect(Number.isFinite(vx)).toBe(true);
      expect(Number.isFinite(vy)).toBe(true);
      // wind (|<=0.6|) + strength(2) * curl(|<=~1.85|) ⇒ well under 5
      expect(Math.abs(vx)).toBeLessThan(5);
      expect(Math.abs(vy)).toBeLessThan(5);
    }
  });

  it('adds curl on top of wind (differs from wind when strength > 0)', () => {
    const p = params({ strength: 2 });
    let anyDiff = false;
    for (let i = 0; i < 50; i++) {
      const v = flowVelocity(i * 9.0, i * 4.0, 0.1, p);
      if (Math.abs(v[0] - p.windX) > 1e-6 || Math.abs(v[1] - p.windY) > 1e-6)
        anyDiff = true;
    }
    expect(anyDiff).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./flow`.

- [ ] **Step 3: Implement `flow.ts`**

Create `src/engine/flow.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all `flowVelocity` tests green.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/engine/flow.ts src/engine/flow.test.ts
git commit -m "feat: add flowVelocity field (wind + fBm curl)"
```

---

### Task 2: `seedTrail` — backward arc-spaced trail seeding

**Files:**
- Modify: `src/engine/flow.ts`
- Modify: `src/engine/flow.test.ts`

**Interfaces:**
- Consumes: `flowVelocity`, `FlowParams`, `TrailState` from Task 1.
- Produces:
  - `seedTrail(hx: number, hy: number, t: number, p: FlowParams, spacing: number, cap: number, st: TrailState): void` — fills `st.pts` with `cap` points (head first) spaced `spacing` apart in arc length, stepping upstream (against the flow); sets `st.carry = 0`.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/flow.test.ts`:

```ts
import { seedTrail, type TrailState } from './flow';

describe('seedTrail', () => {
  it('fills cap points with the head first', () => {
    const st: TrailState = { pts: [], carry: 5 };
    seedTrail(100, 200, 0, params(), 10, 8, st);
    expect(st.pts.length).toBe(8);
    expect(st.pts[0]).toEqual({ x: 100, y: 200 });
    expect(st.carry).toBe(0);
  });

  it('spaces points ~spacing apart in arc length', () => {
    const st: TrailState = { pts: [], carry: 0 };
    const spacing = 12;
    seedTrail(0, 0, 0.2, params(), spacing, 20, st);
    for (let i = 1; i < st.pts.length; i++) {
      const d = Math.hypot(
        st.pts[i].x - st.pts[i - 1].x,
        st.pts[i].y - st.pts[i - 1].y,
      );
      expect(Math.abs(d - spacing)).toBeLessThan(spacing * 0.05);
    }
  });

  it('seeds a straight upstream line opposite the wind when strength is 0', () => {
    const st: TrailState = { pts: [], carry: 0 };
    const p = params({ strength: 0, windX: 1, windY: 0 });
    seedTrail(0, 0, 0, p, 10, 5, st);
    // upstream of a +x wind is -x; points should march in -x with y≈0
    expect(st.pts[1].x).toBeLessThan(st.pts[0].x);
    for (const pt of st.pts) expect(Math.abs(pt.y)).toBeLessThan(1e-9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `seedTrail` is not exported.

- [ ] **Step 3: Implement `seedTrail`**

Append to `src/engine/flow.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/engine/flow.ts src/engine/flow.test.ts
git commit -m "feat: add seedTrail backward arc-spaced seeding"
```

---

### Task 3: `advanceTrail` — forward one-frame advection

**Files:**
- Modify: `src/engine/flow.ts`
- Modify: `src/engine/flow.test.ts`

**Interfaces:**
- Consumes: `flowVelocity`, `FlowParams`, `TrailState`, `TrailPoint` from Tasks 1–2.
- Produces:
  - `advanceTrail(st: TrailState, hx: number, hy: number, t: number, p: FlowParams, spacing: number, cap: number): TrailPoint` — integrates the head one frame (dt = 1) with sub-stepping, pushing arc-spaced points to the front of `st.pts`, trimming the tail to `cap`. Returns the new head position.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/flow.test.ts`:

```ts
import { advanceTrail } from './flow';

describe('advanceTrail', () => {
  it('moves the head by ~|velocity| per frame', () => {
    const st: TrailState = { pts: [{ x: 0, y: 0 }], carry: 0 };
    const p = params({ strength: 0, windX: 2, windY: 0 });
    const head = advanceTrail(st, 0, 0, 0, p, 10, 20);
    expect(head.x).toBeCloseTo(2, 6);
    expect(head.y).toBeCloseTo(0, 6);
  });

  it('pushes arc-spaced points and never exceeds cap', () => {
    const st: TrailState = { pts: [{ x: 0, y: 0 }], carry: 0 };
    const p = params({ strength: 0, windX: 7, windY: 0 }); // fast: >spacing/frame
    let hx = 0;
    let hy = 0;
    const spacing = 5;
    for (let f = 0; f < 200; f++) {
      const h = advanceTrail(st, hx, hy, f * 0.01, p, spacing, 16);
      hx = h.x;
      hy = h.y;
    }
    expect(st.pts.length).toBeLessThanOrEqual(16);
    for (let i = 1; i < st.pts.length; i++) {
      const d = Math.hypot(
        st.pts[i].x - st.pts[i - 1].x,
        st.pts[i].y - st.pts[i - 1].y,
      );
      expect(Math.abs(d - spacing)).toBeLessThan(spacing * 0.34);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `advanceTrail` is not exported.

- [ ] **Step 3: Implement `advanceTrail`**

Append to `src/engine/flow.ts`:

```ts
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
  const [vx0, vy0] = flowVelocity(x, y, t, p);
  const speed = Math.hypot(vx0, vy0);
  const sub = Math.max(1, Math.ceil(speed / spacing));
  const h = 1 / sub;
  for (let s = 0; s < sub; s++) {
    const [vx, vy] = flowVelocity(x, y, t, p);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/engine/flow.ts src/engine/flow.test.ts
git commit -m "feat: add advanceTrail forward advection"
```

---

### Task 4: `trailPlacements` — arc-spaced blob placement

**Files:**
- Modify: `src/engine/flow.ts`
- Modify: `src/engine/flow.test.ts`

**Interfaces:**
- Consumes: `TrailPoint`, `Placement` from Task 1.
- Produces:
  - `trailPlacements(pts: TrailPoint[], count: number): Placement[]` — returns up to `min(count, pts.length)` placements; `x,y` from the trail, `tx,ty` the unit tangent (older→newer = flow direction), `env = sin((i/(n-1))·π)` fading head (i=0) and tail (i=n-1). Returns `[]` if fewer than 2 usable points.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/flow.test.ts`:

```ts
import { trailPlacements, type TrailPoint } from './flow';

describe('trailPlacements', () => {
  const straight: TrailPoint[] = Array.from({ length: 12 }, (_, i) => ({
    x: -i * 10, // head at x=0, trail goes -x (older upstream)
    y: 5,
  }));

  it('returns min(count, pts) placements', () => {
    expect(trailPlacements(straight, 8).length).toBe(8);
    expect(trailPlacements(straight, 100).length).toBe(12);
    expect(trailPlacements([{ x: 0, y: 0 }], 8)).toEqual([]);
  });

  it('tangent points along the flow (older -> newer) and is unit length', () => {
    const ps = trailPlacements(straight, 10);
    for (const pl of ps) {
      expect(Math.hypot(pl.tx, pl.ty)).toBeCloseTo(1, 6);
      expect(pl.tx).toBeGreaterThan(0.99); // flow is +x (toward the head)
    }
  });

  it('envelope fades both ends and peaks in the middle', () => {
    const ps = trailPlacements(straight, 12);
    expect(ps[0].env).toBeCloseTo(0, 6);
    expect(ps[ps.length - 1].env).toBeCloseTo(0, 6);
    expect(ps[6].env).toBeGreaterThan(0.8);
  });

  it('consecutive placements stay within ~one spacing (body continuity)', () => {
    const ps = trailPlacements(straight, 12);
    for (let i = 1; i < ps.length; i++) {
      const d = Math.hypot(ps[i].x - ps[i - 1].x, ps[i].y - ps[i - 1].y);
      expect(d).toBeLessThan(11); // points are 10 apart
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `trailPlacements` is not exported.

- [ ] **Step 3: Implement `trailPlacements`**

Append to `src/engine/flow.ts`:

```ts
export function trailPlacements(
  pts: TrailPoint[],
  count: number,
): Placement[] {
  const n = Math.min(count, pts.length);
  const out: Placement[] = [];
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const older = pts[Math.min(i + 1, n - 1)];
    const newer = pts[Math.max(i - 1, 0)];
    let tx = newer.x - older.x; // older -> newer = flow direction
    let ty = newer.y - older.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const env = Math.sin((i / (n - 1)) * Math.PI);
    out.push({ x: a.x, y: a.y, tx, ty, env });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/engine/flow.ts src/engine/flow.test.ts
git commit -m "feat: add trailPlacements arc-spaced blob placement"
```

---

### Task 5: Engine core advection (replace the conveyor)

**Files:**
- Modify: `src/engine/engine.ts`
- Modify: `src/engine/engine.test.ts`

**Interfaces:**
- Consumes: `flowVelocity`, `seedTrail`, `advanceTrail`, `trailPlacements`, `FlowParams`, `TrailState`, `Placement` from `./flow`.
- Produces: advected motion. No new exported symbols. Removes the exported `flowAngle` helper.

This task swaps the whole motion model in one atomic change so the engine keeps compiling. Apply the steps in order.

- [ ] **Step 1: Replace the noise/flow imports**

In `src/engine/engine.ts`, find:

```ts
import { curlFbm } from './noise';
```

Replace with:

```ts
import {
  flowVelocity,
  seedTrail,
  advanceTrail,
  trailPlacements,
  type FlowParams,
  type TrailState,
} from './flow';
```

- [ ] **Step 2: Remove obsolete constants and module state**

Find and DELETE these lines (the curl-margin constant and the offset/conveyor state):

```ts
// max per-component magnitude of curlFbm (peaks at ~1.84 for any octaves/gain
// since the fBm curl is magnitude-normalized); used to reserve recycle margin.
const CURL_MAX_COMP = 1.9;
```

Find this block:

```ts
let blobR = 0,
  blobLong = 0,
  halfLen = 0,
  softness = 0,
  turbAmt = 0,
  strokeCount = 0;
let flowAxisLen = 0,
  perpAxisLen = 0,
  flowPeriod = 0,
  flowMargin = 0,
  centerAlong = 0,
  centerPerp = 0;
let flowStrength = 0,
  flowInvScale = 0,
  flowBend = 0,
  flowGain = 0,
  flowDriftX = 0,
  flowDriftY = 0,
  flowTime = 0;

let strokes: Stroke[] = [];
let rafId: number | null = null;
```

Replace it with (drop the conveyor geometry and `flowBend`; add `nSteps`, `spacing`, `flowMargin`, a reusable `flowParams`, and a spawn RNG):

```ts
let blobR = 0,
  blobLong = 0,
  halfLen = 0,
  softness = 0,
  turbAmt = 0,
  strokeCount = 0;
let nSteps = 0, // blobs per stroke (trail capacity)
  spacing = 0, // arc-length spacing between trail points (px)
  flowMargin = 0; // off-screen spawn/cull margin (px)
let flowInvScale = 0,
  flowStrength = 0,
  flowGain = 0,
  flowDriftX = 0,
  flowDriftY = 0,
  flowTime = 0;

const flowParams: FlowParams = {
  windX: 0,
  windY: 0,
  invScale: 0,
  strength: 0,
  driftX: 0,
  driftY: 0,
  octaves: FLOW_OCTAVES,
  gain: 0,
};

let strokes: Stroke[] = [];
let spawnRng: () => number = () => 0.5;
let rafId: number | null = null;
```

- [ ] **Step 3: Replace `computeParams` and delete `computeFlowGeometry`**

Find:

```ts
function computeParams() {
  const sc = Math.min(W, H) / 900;
  const ts = norm(cfg.soft, 1, 10);
  blobR = lerp(5, 200, ts * ts) * sc;
  softness = lerp(0.0, 1.0, ts);
  const tsm = norm(cfg.smear, 1, 10);
  blobLong = blobR * lerp(1.0, 9.5, tsm);
  const tl = norm(cfg.length, 1, 10);
  halfLen = blobR * lerp(1.5, 30.0, tl);
  turbAmt = norm(cfg.turbulence, 0, 10);
  const tf = norm(cfg.frequency, 1, 10);
  strokeCount = Math.round(lerp(3, 90, tf * tf));
  computeFlowGeometry();
}

function computeFlowGeometry() {
  const ca = Math.abs(Math.cos(cfg.angle));
  const sa = Math.abs(Math.sin(cfg.angle));
  flowAxisLen = W * ca + H * sa;
  perpAxisLen = W * sa + H * ca;
  centerAlong = (W / 2) * Math.cos(cfg.angle) + (H / 2) * Math.sin(cfg.angle);
  centerPerp = (-W / 2) * Math.sin(cfg.angle) + (H / 2) * Math.cos(cfg.angle);
  const maxFlowDisp = blobR * 4.0 * CURL_MAX_COMP;
  flowMargin = (halfLen + blobR) * 1.6 + maxFlowDisp;
  flowPeriod = flowAxisLen + 2 * flowMargin;
}
```

Replace BOTH functions with:

```ts
function computeParams() {
  const sc = Math.min(W, H) / 900;
  const ts = norm(cfg.soft, 1, 10);
  blobR = lerp(5, 200, ts * ts) * sc;
  softness = lerp(0.0, 1.0, ts);
  const tsm = norm(cfg.smear, 1, 10);
  blobLong = blobR * lerp(1.0, 9.5, tsm);
  const tl = norm(cfg.length, 1, 10);
  halfLen = blobR * lerp(1.5, 30.0, tl);
  turbAmt = norm(cfg.turbulence, 0, 10);
  const tf = norm(cfg.frequency, 1, 10);
  strokeCount = Math.round(lerp(3, 90, tf * tf));

  spacing = blobR * 0.65;
  nSteps = clamp(Math.round((halfLen * 2) / spacing), 2, 60) + 1;
  // A full trail (nSteps*spacing) plus a blob radius must sit off-screen.
  flowMargin = nSteps * spacing + blobLong;
}
```

- [ ] **Step 4: Add a velocity-params updater and the spawn helper**

Add these two functions immediately after `computeParams` (they translate config + `flowTime` into the `flowParams` the field reads, and place a stroke at a random spawn point with a pre-seeded trail):

```ts
// Refresh the velocity-field params from config + flowTime. Cheap; called each
// frame so the non-rebuild sliders (Flow, Flow Scale, Detail, Speed) take effect.
function updateFlowParams() {
  const windSpeed = Math.pow(10, lerp(-0.52, 0.92, norm(cfg.speed, 1, 10)));
  flowParams.windX = Math.cos(cfg.angle) * windSpeed;
  flowParams.windY = Math.sin(cfg.angle) * windSpeed;
  flowInvScale = 1 / lerp(120, 1400, norm(cfg.flowScale, 1, 10));
  flowParams.invScale = flowInvScale;
  // Curl velocity scales with wind so Flow reads as "swirliness vs the current".
  flowStrength = norm(cfg.flow, 0, 10) * windSpeed * 1.5;
  flowParams.strength = flowStrength;
  flowGain = lerp(0.0, 0.6, norm(cfg.detail, 1, 10));
  flowParams.gain = flowGain;
  flowDriftX = Math.cos(cfg.angle) * FLOW_DRIFT * flowTime;
  flowDriftY = Math.sin(cfg.angle) * FLOW_DRIFT * flowTime;
  flowParams.driftX = flowDriftX;
  flowParams.driftY = flowDriftY;
}

// Place a stroke at a random point in screen+margin and pre-seed its trail.
function spawnStroke(s: Stroke) {
  s.headX = -flowMargin + spawnRng() * (W + 2 * flowMargin);
  s.headY = -flowMargin + spawnRng() * (H + 2 * flowMargin);
  seedTrail(s.headX, s.headY, flowTime, flowParams, spacing, nSteps, s.trail);
}
```

- [ ] **Step 5: Replace the `Stroke` class**

Replace the entire `Stroke` class (from `class Stroke {` through its closing `}`) and the `BlobOffset` interface + `computeBlobOffsets` function that precede it — DELETE `interface BlobOffset {...}` and `function computeBlobOffsets(...) {...}` entirely, and replace `class Stroke {...}` with:

```ts
class Stroke {
  sVar: number;
  aVar: number;
  warpPhase: number;
  toneParam: number;
  headX = 0;
  headY = 0;
  trail: TrailState = { pts: [], carry: 0 };

  constructor(rng: () => number) {
    this.sVar = lerp(0.7, 1.3, rng());
    this.aVar = lerp(0.45, 1.0, rng());
    this.warpPhase = rng() * Math.PI * 2;
    this.toneParam = rng();
  }

  advance() {
    const h = advanceTrail(
      this.trail,
      this.headX,
      this.headY,
      flowTime,
      flowParams,
      spacing,
      nSteps,
    );
    this.headX = h.x;
    this.headY = h.y;
    if (
      this.headX < -flowMargin ||
      this.headX > W + flowMargin ||
      this.headY < -flowMargin ||
      this.headY > H + flowMargin
    ) {
      spawnStroke(this);
    }
  }

  writeQuads(blobIndex: number, palette: [number, number, number][]): number {
    const rx = blobLong * this.sVar;
    const ry = blobR * this.sVar;
    const ti = norm(cfg.intensity, 1, 10);
    const alph = lerp(0.06, 0.95, ti * ti) * this.aVar;

    const pidx = Math.min(
      palette.length - 1,
      Math.floor(this.toneParam * palette.length),
    );
    const [cr, cg, cb] = palette[pidx];
    const rf = cr / 255,
      gf = cg / 255,
      bf = cb / 255;

    const places = trailPlacements(this.trail.pts, nSteps);
    let qi = 0;
    for (const pl of places) {
      if (pl.env < 0.015) continue;
      if (blobIndex + qi >= MAX_BLOBS) break;

      const wx = pl.x;
      const wy = pl.y;
      const cw = pl.tx; // tangent is already unit length
      const sw = pl.ty;
      const a = alph * Math.pow(pl.env, 0.4);

      const CX = [-rx, rx, rx, -rx];
      const CY = [-ry, -ry, ry, ry];
      const CU = [0, 1, 1, 0];
      const CV = [0, 0, 1, 1];

      const base = (blobIndex + qi) * V_PER_Q * F_PER_V;
      for (let c = 0; c < 4; c++) {
        const i = base + c * F_PER_V;
        vertBuf[i + 0] = wx + CX[c] * cw - CY[c] * sw;
        vertBuf[i + 1] = wy + CX[c] * sw + CY[c] * cw;
        vertBuf[i + 2] = CU[c];
        vertBuf[i + 3] = CV[c];
        vertBuf[i + 4] = a;
        vertBuf[i + 5] = rf;
        vertBuf[i + 6] = gf;
        vertBuf[i + 7] = bf;
      }
      qi++;
    }
    return qi;
  }
}
```

(`cw`/`sw` use the unit tangent directly instead of `cos`/`sin` of an angle — the blob's long axis aligns with the flow, same quad math as before.)

- [ ] **Step 6: Replace `rebuildStrokes`**

Find:

```ts
export function rebuildStrokes() {
  computeParams();
  const rng = mkRng(cfg.seed * 9301 + 49297);
  strokes = [];
  for (let i = 0; i < strokeCount; i++) {
    strokes.push(new Stroke(rng, true));
  }
}
```

Replace with:

```ts
export function rebuildStrokes() {
  computeParams();
  updateFlowParams();
  const rng = mkRng(cfg.seed * 9301 + 49297);
  spawnRng = mkRng(cfg.seed * 2654435761 + 1013904223);
  strokes = [];
  for (let i = 0; i < strokeCount; i++) {
    const s = new Stroke(rng);
    spawnStroke(s);
    strokes.push(s);
  }
}
```

- [ ] **Step 7: Update `drawFrame` (replace the offset param block)**

Find this block in `drawFrame`:

```ts
  const tflow = norm(cfg.flow, 0, 10);
  flowStrength = tflow * blobR * 4.0;
  flowInvScale = 1 / lerp(120, 1400, norm(cfg.flowScale, 1, 10));
  // Coefficient on the curl vector when blending into the base direction (see
  // flowAngle). Kept below ~1/|curl|max so orientation never reaches the atan2
  // singularity. Max deflection ≈ atan(flowBend·|curl|) ≈ 28° at flow=10.
  flowBend = tflow * 0.3;
  // Detail = how much high-frequency fractal energy rides on the base swirl.
  flowGain = lerp(0.0, 0.6, norm(cfg.detail, 1, 10));
  // Domain drift: translate the noise field along the flow direction over time
  // so a point sees the field streaming past instead of swinging in place.
  flowDriftX = Math.cos(cfg.angle) * FLOW_DRIFT * flowTime;
  flowDriftY = Math.sin(cfg.angle) * FLOW_DRIFT * flowTime;

  const palette = computeTonePalette();
```

Replace with:

```ts
  updateFlowParams();

  const palette = computeTonePalette();
```

- [ ] **Step 8: Update `tick`**

Find:

```ts
function tick() {
  const pxPerFrame = Math.pow(10, lerp(-0.52, 0.92, norm(cfg.speed, 1, 10)));
  for (const s of strokes) s.advance(pxPerFrame);
  if (cfg.flow > 0) flowTime += lerp(0.0008, 0.02, norm(cfg.flowDrift, 1, 10));
  drawFrame();
  if (cfg.playing) rafId = requestAnimationFrame(tick);
}
```

Replace with:

```ts
function tick() {
  updateFlowParams();
  for (const s of strokes) s.advance();
  flowTime += lerp(0.0008, 0.02, norm(cfg.flowDrift, 1, 10));
  drawFrame();
  if (cfg.playing) rafId = requestAnimationFrame(tick);
}
```

- [ ] **Step 9: Fix `setAngle` (it called the deleted `computeFlowGeometry`)**

Find:

```ts
export function setAngle(rad: number) {
  cfg.angle = rad;
  computeFlowGeometry();
  if (!cfg.playing) drawFrame();
}
```

Replace with (angle now feeds the wind direction via `updateFlowParams`; existing trails keep their points and advect under the new wind — no rebuild needed):

```ts
export function setAngle(rad: number) {
  cfg.angle = rad;
  updateFlowParams();
  if (!cfg.playing) drawFrame();
}
```

- [ ] **Step 10: Remove the `flowAngle` helper**

Find and DELETE the entire `flowAngle` export and its doc comment:

```ts
// Orientation for a blob in the flow field: align with the LOCAL flow vector
// (base direction + curl perturbation), not with the curl direction alone.
// Using the curl's absolute direction (atan2(fvy, fvx)) spins wildly wherever
// the curl magnitude crosses zero, whipping elongated blobs hundreds of px in
// one frame (the "teleport" bug). Adding the curl to the base unit vector keeps
// the result away from the atan2 singularity, so it varies smoothly and returns
// to baseAngle as the curl fades. k must stay below ~1/|curl|max to be stable.
export function flowAngle(
  baseAngle: number,
  fvx: number,
  fvy: number,
  k: number,
): number {
  return Math.atan2(
    Math.sin(baseAngle) + k * fvy,
    Math.cos(baseAngle) + k * fvx,
  );
}
```

- [ ] **Step 11: Replace `engine.test.ts` (flowAngle is gone)**

`engine.test.ts` only tested `flowAngle`, which no longer exists. Replace the ENTIRE contents of `src/engine/engine.test.ts` with a placeholder so the file compiles and the suite stays meaningful:

```ts
import { describe, it, expect } from 'vitest';
import { cfg } from './config';

// The engine's motion is verified by flow.test.ts (pure field/trail math) and
// by manual visual checks (GL output). This guards the config surface the UI
// drives so a renamed/removed key is caught by the suite.
describe('engine config surface', () => {
  it('exposes the flow controls the UI binds to', () => {
    for (const k of ['flow', 'flowScale', 'flowDrift', 'detail', 'speed'] as const) {
      expect(typeof cfg[k]).toBe('number');
    }
  });
});
```

- [ ] **Step 12: Verify the field-zero invariant, build, lint, tests**

Run: `npm test`
Expected: PASS — `flow.test.ts` (incl. the `strength = 0 ⇒ wind exactly` test) and the engine config test all green.

Run: `npm run build && npm run lint`
Expected: both succeed (no references to deleted `flowAngle`, `curlFbm`, `computeBlobOffsets`, `flowPeriod`, etc.).

- [ ] **Step 13: Manual visual check**

Run: `npm run dev`, open the app.
Expected: strokes flow downstream and bend through swirls (no swinging-in-place); raising **Flow** increases curl; **Flow=0** gives straight trails along the angle; strokes that leave the screen reappear (respawn may pop briefly — fade-in comes in Task 6).

- [ ] **Step 14: Commit**

```bash
git add src/engine/engine.ts src/engine/engine.test.ts
git commit -m "feat: advect strokes as streaklines, replacing the conveyor"
```

---

### Task 6: Turbulence path wiggle + respawn fade-in

**Files:**
- Modify: `src/engine/engine.ts`

**Interfaces:**
- Consumes: the `Stroke` class, `spacing`, `turbAmt`, `blobR` from Task 5.
- Produces: per-stroke perpendicular path wiggle on rendered blobs and a short alpha fade-in after spawn. No new exported symbols.

- [ ] **Step 1: Add a fade-in age to spawning**

In `spawnStroke`, set the stroke's age to 0 on (re)spawn. Find:

```ts
function spawnStroke(s: Stroke) {
  s.headX = -flowMargin + spawnRng() * (W + 2 * flowMargin);
  s.headY = -flowMargin + spawnRng() * (H + 2 * flowMargin);
  seedTrail(s.headX, s.headY, flowTime, flowParams, spacing, nSteps, s.trail);
}
```

Replace with:

```ts
function spawnStroke(s: Stroke) {
  s.headX = -flowMargin + spawnRng() * (W + 2 * flowMargin);
  s.headY = -flowMargin + spawnRng() * (H + 2 * flowMargin);
  seedTrail(s.headX, s.headY, flowTime, flowParams, spacing, nSteps, s.trail);
  s.age = 0;
}
```

- [ ] **Step 2: Add the `age` field and advance it**

In the `Stroke` class, find:

```ts
  headX = 0;
  headY = 0;
  trail: TrailState = { pts: [], carry: 0 };
```

Replace with:

```ts
  headX = 0;
  headY = 0;
  age = 999; // frames since spawn; large = fully faded in
  trail: TrailState = { pts: [], carry: 0 };
```

In `advance()`, find:

```ts
    this.headX = h.x;
    this.headY = h.y;
    if (
```

Replace with:

```ts
    this.headX = h.x;
    this.headY = h.y;
    this.age++;
    if (
```

- [ ] **Step 3: Apply the fade-in and perpendicular Turbulence wiggle in `writeQuads`**

In `writeQuads`, find:

```ts
    const places = trailPlacements(this.trail.pts, nSteps);
    let qi = 0;
    for (const pl of places) {
      if (pl.env < 0.015) continue;
      if (blobIndex + qi >= MAX_BLOBS) break;

      const wx = pl.x;
      const wy = pl.y;
      const cw = pl.tx; // tangent is already unit length
      const sw = pl.ty;
      const a = alph * Math.pow(pl.env, 0.4);
```

Replace with (fade-in over 24 frames ≈ 0.4s at 60fps; wiggle is a smooth per-stroke sinusoid offset perpendicular to the tangent, reusing the original Turbulence shape):

```ts
    const places = trailPlacements(this.trail.pts, nSteps);
    const fade = Math.min(1, this.age / 24);
    const n = places.length;
    let qi = 0;
    for (let pi = 0; pi < n; pi++) {
      const pl = places[pi];
      if (pl.env < 0.015) continue;
      if (blobIndex + qi >= MAX_BLOBS) break;

      // Perpendicular path wiggle (Turbulence): smooth sinusoid along the body
      // offset perpendicular (-ty, tx) to the local tangent.
      const tparam = pi / (n - 1);
      const wig =
        Math.sin(tparam * Math.PI * 3 + this.warpPhase) *
        blobR *
        turbAmt *
        2.0 *
        pl.env;
      const wx = pl.x + -pl.ty * wig;
      const wy = pl.y + pl.tx * wig;
      const cw = pl.tx; // tangent is already unit length
      const sw = pl.ty;
      const a = alph * Math.pow(pl.env, 0.4) * fade;
```

- [ ] **Step 4: Verify build, lint, tests**

Run: `npm run build && npm run lint && npm test`
Expected: all succeed (flow.test.ts + engine config test green).

- [ ] **Step 5: Manual visual check**

Run: `npm run dev`.
Expected: respawning strokes fade in smoothly (no pops); raising **Turbulence** adds a wavy wiggle to the stroke paths; **Turbulence = 0** gives clean trails.

- [ ] **Step 6: Commit**

```bash
git add src/engine/engine.ts
git commit -m "feat: add respawn fade-in and Turbulence path wiggle"
```

---

## Self-Review

**Spec coverage:**
- Velocity field `V = wind + curlFbm·strength` → Task 1 (`flowVelocity`). ✓
- Streakline body / trail buffer → Tasks 2–4 (`seedTrail`, `advanceTrail`, `trailPlacements`) + Task 5 (Stroke holds `trail`). ✓
- Head Euler integration + flowTime morph → Task 5 (`advance`, `tick`). ✓
- Flow=0 ⇒ straight trails → enforced in `flowVelocity` (Task 1) and tested; verified in Task 5 Step 12. ✓
- Spawn/respawn with backward-seeded full-length trail → Task 5 (`spawnStroke`, `advance` cull). ✓
- Respawn fade-in (~0.4s) → Task 6. ✓
- Orientation from trail tangent (no atan2 teleport) → Task 5 `writeQuads`. ✓
- Turbulence = perpendicular path wiggle → Task 6. ✓
- Controls mapping (angle/Speed→wind, Flow→strength, Scale→invScale, Drift→flowTime, Detail→gain, Length→nSteps, Smear→blobLong, Soft→blobR) → Task 5 `computeParams`/`updateFlowParams`. ✓
- Reuse curlFbm/fbm3 + Detail control → Task 1 imports curlFbm; Detail already wired (config/slider exist). ✓
- Removals (flowAngle + tests, offset path, conveyor geometry incl. `setAngle` fix, CURL_MAX_COMP) → Task 5 Steps 2,3,5,7,9,10,11. ✓
- New pure `flow.ts`, framework-agnostic → Tasks 1–4. ✓
- Testing: velocity bounded/finite, seed arc length, walk spacing, body continuity → Tasks 1–4. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**Type consistency:** `FlowParams`/`TrailState`/`TrailPoint`/`Placement` defined in Task 1 and used identically in Tasks 2–5. `flowVelocity`/`seedTrail`/`advanceTrail`/`trailPlacements` signatures match between definition and engine call sites. `spacing`/`nSteps`/`flowMargin`/`flowParams` declared in Task 5 Step 2 and used in Steps 3–8 and Task 6. `Stroke.age` added in Task 6 Step 2 and used in Steps 1,3. ✓

**Note on Detail/config:** `cfg.detail`, the Detail slider, and `fbm3`/`curlFbm` already exist (committed at `60667df`); this plan consumes them via `flow.ts` and `updateFlowParams`. No config/UI task is needed.

**Note on `FLOW_OCTAVES`/`FLOW_DRIFT`:** both constants already exist in `engine.ts` (committed at `60667df`) and are reused by Task 5; no redefinition needed.
