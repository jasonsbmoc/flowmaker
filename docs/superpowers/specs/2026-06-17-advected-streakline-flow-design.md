# Advected Streakline Flow — Design

**Date:** 2026-06-17
**Status:** Implemented (this doc describes the as-built design)

## Problem

The flow field added previously displaced each stroke as a **bounded offset**
from a fixed conveyor path. A bounded offset's velocity averages to zero — it
goes out and comes back — so the motion read as swinging/oscillating about a
spot rather than flowing. Measurement confirmed the offset oscillation can
dominate the slow conveyor, and that shaping the noise (fBm, domain drift)
adds randomness but does not remove the swing, because the swing is intrinsic
to the offset model.

## Goal

Replace the offset model with **advection**: strokes are carried *along* the
velocity field and travel downstream like ink in water. Each stroke's body is a
**streakline** — it traces the path its head has travelled — so bodies bend
along streamlines. This makes the motion read as a flowing current with
natural, non-repetitive variation, instead of a pendulum swing.

This is a deliberate rearchitecture. The original rigid-conveyor motion model
is replaced; Flow=0 yields straight trails along the wind (close to the old
look, not byte-identical), and exact reproduction of the prior animation is
explicitly **not** a requirement.

## Motion model

A single velocity field drives all motion:

```
V(p, t) = windDir · windSpeed  +  curlFbm(p · invScale + drift, t, octaves, gain) · flowStrength
```

- `windDir` is the unit vector of `cfg.angle`; `windSpeed` derives from
  `cfg.speed` (`10^lerp(-0.52, 0.92, …)`, px/frame).
- The curl term is the magnitude-normalized fBm curl (`curlFbm`/`fbm3` in
  `noise.ts`), which is divergence-free and multi-scale.
- `invScale` from `cfg.flowScale`; `flowStrength = norm(cfg.flow) · windSpeed ·
  1.5` (curl reads as "swirliness vs the current", and scales with wind);
  fBm `gain = lerp(0, 0.6, norm(cfg.detail))` over a fixed `octaves = 4`;
  `drift = windDir · 0.6 · flowTime` (slow domain translation along the wind).

Each stroke has a **head** position integrated every frame by explicit Euler.
Because a fast head could otherwise skip past trail-point spacing, `advanceTrail`
**sub-steps** the frame (`sub = ceil(|V|/spacing · 4)`) so the head moves at most
~¼ spacing per sub-step and the laid-down points stay evenly arc-spaced.

`flowTime` advances per frame (rate from `cfg.flowDrift`) so the field morphs
over time. At `cfg.flow = 0` the curl term vanishes and `flowVelocity` returns
exactly `windDir · windSpeed`, so heads travel in straight lines ⇒ straight
trails.

## Stroke = a trail (streakline)

Each stroke keeps an array of recent head positions (`TrailState.pts`,
most-recent first), spaced ~`spacing` apart in **arc length** and trimmed to a
cap. A point is pushed only after the head has travelled `spacing` (tracked by
`TrailState.carry`), so storage is independent of frame rate and speed.
`spacing = blobR · BLOB_SPACING_FACTOR` (0.65); the cap `nSteps =
clamp(round(2·halfLen / spacing), 2, 60) + 1` sets the body length from
**Length** (`cfg.length`).

The body is rendered each frame by **resampling from the live head**
(`walkTrail`), not by drawing the stored points directly:

- Build the polyline `[head, pts[0], pts[1], …]` and walk it, emitting a blob at
  every arc-length multiple of `spacing`. **Blob 0 sits on the live head**, so
  the body moves smoothly every frame — drawing the discrete stored points
  directly made the body freeze between point-pushes and hop one `spacing` when
  a point was added (the original "jumpy" bug).
- Each blob's **tangent** is taken from its *neighbouring resampled positions*
  (which move smoothly), not from the raw polyline segment it falls in — taking
  it per-segment made the orientation snap when a sample crossed a stored vertex,
  flicking the elongated blobs (a visible shimmer). Orientation never comes from
  a curl `atan2`, so the teleport class of bug cannot recur.
- Blob long axis from **Smear** (`cfg.smear`), radius/softness from **Soft**
  (`cfg.soft`); an alpha **envelope** `sin(t·π)` along the body fades head and
  tail.
- **Turbulence** (`cfg.turbulence`) adds a smooth per-stroke perpendicular wiggle
  to each blob relative to the local tangent — a sinusoid with a per-stroke
  random phase, envelope-scaled. Static per stroke (no fast time variation), so
  no flicker.

## Spawn / respawn

Fixed stroke count from **Frequency** (`cfg.frequency`).

- **First build:** each stroke is scattered at a random position within
  screen+margin and its trail is pre-seeded by `seedTrail` (stepping `spacing`
  **upstream** along the local flow from the head), so it is immediately
  full-length — no growing-in. This gives instant on-screen coverage at startup.
- **Later rebuilds** (Length/Smear/Soft/Frequency/Turbulence/Seed, resize):
  existing strokes are **kept in place** — their trails are re-seeded at their
  current heads with the new geometry — so the field does not re-scatter
  mid-screen on a slider drag. Extra strokes are trimmed; new ones enter from the
  upwind edge.
- **In-flight respawn:** when a stroke's head leaves screen+`flowMargin`, it
  respawns from the **upwind edge** (`inflowHead`): the head is placed just past
  the upwind edge (by `blobLong`), with its body trailing further upwind and
  fully off-screen, so it drifts on like the old conveyor rather than
  materializing mid-screen. A short alpha **fade-in** (`SPAWN_FADE_FRAMES = 24`,
  ~0.4s) covers the appearance.

Two margins, deliberately different:
- **Cull margin** = `flowMargin = nSteps·spacing + blobLong` (a full trail): the
  head must travel this far past the screen before recycling, so the whole body
  has cleared.
- **Spawn margin** = `blobLong` (just off-screen): strokes re-enter promptly so
  the screen stays populated. Placing respawns a full trail-length upwind instead
  starved the screen (it averaged ~1 visible stroke); entering at the edge keeps
  density up.

## Code structure

- **`src/engine/flow.ts`** — pure, framework-agnostic, unit-tested:
  - `flowVelocity(x, y, t, p): [number, number]` — wind + curl; returns the wind
    exactly when `p.strength === 0`.
  - `seedTrail(hx, hy, t, p, spacing, cap, st)` — fill a trail by stepping
    `spacing` upstream along the local flow.
  - `advanceTrail(st, hx, hy, t, p, spacing, cap): TrailPoint` — sub-stepped
    one-frame Euler advance; pushes arc-spaced points, trims to cap, returns the
    new head.
  - `walkTrail(headX, headY, pts, count, spacing): Placement[]` — resample the
    body from the live head; positions in pass 1, neighbour-based tangents in
    pass 2.
  - `inflowHead(W, H, angle, margin, perpParam): TrailPoint` — a head position
    on the upwind edge, off-screen, spread across the perpendicular extent.
  - Types: `FlowParams`, `TrailPoint`, `TrailState { pts, carry }`, `Placement
    { x, y, tx, ty, env }`.
- **`engine.ts`** — each `Stroke` holds `headX/headY`, a `trail: TrailState`, and
  an `age` (for fade-in). `advance()` integrates `flowVelocity` via
  `advanceTrail` and respawns when off-screen; `writeQuads` reads placements from
  `walkTrail`. Reuses blob-quad rendering, tone palette, and grain unchanged.
- **Reused as-is:** `curlFbm`/`fbm3` and the **Detail** config key + slider.
- **Removed:** the bounded-offset displacement path; the `flowAngle` helper and
  its tests (orientation now comes from the trail tangent); the recycle-margin /
  `CURL_MAX_COMP` logic and the along-axis `progress`/`flowPeriod` conveyor
  geometry (replaced by advection + respawn).

## Controls (final mapping)

| Control | Meaning |
|---|---|
| Angle | wind direction |
| Speed | wind speed (advection rate) |
| Flow | curl strength (0 = straight trails) |
| Flow Scale | curl spatial scale |
| Flow Drift | field morph rate over time |
| Detail | fBm gain (fine-scale roughness of the flow) |
| Length | trail arc length |
| Smear | blob long axis |
| Soft | blob size / softness |
| Turbulence | per-stroke perpendicular path wiggle |
| Intensity, Tone Variance, Edge Texture, Grain | unchanged |

Flow / Flow Scale / Flow Drift / Detail / Intensity / Speed are non-rebuild
(per-frame). Length / Smear / Soft / Frequency / Turbulence / Seed rebuild the
stroke pool (in place, per above).

## Performance

The field is evaluated once per stroke head per sub-step per frame (plus a short
burst on the infrequent respawn seeding); `walkTrail` is a per-stroke polyline
resample with a single forward cursor (O(points)). Measured per-frame compute
(advance + walkTrail, all strokes) is ~0.06 ms at default and under 2 ms at the
heaviest settings — well within frame budget. This is cheaper than the old
per-blob field sampling (~5400 evals/frame).

## Testing

`src/engine/{flow,noise}.test.ts` (unit):
- `flowVelocity` is finite/bounded and returns the wind exactly at
  `strength = 0`.
- `seedTrail` fills `cap` arc-spaced points (head first); straight upstream line
  when `strength = 0`.
- `advanceTrail` moves the head by ~|V|/frame and keeps points arc-spaced under
  fast flow without exceeding cap.
- `walkTrail` samples at arc-length multiples of `spacing` from the live head;
  **blob 0 tracks the head** (a small head move moves it the same — the
  no-spacing-hop regression) and **orientation changes only slightly per frame**
  under advection (the no-shimmer regression).
- `inflowHead` places the head upwind and fully off-screen across the
  perpendicular extent.
- `noise.ts`: value-noise determinism/range/smoothness; `curl2`/`curlFbm`
  perpendicular-to-gradient, divergence-free, and magnitude bounded across
  octaves/gain.

Engine integration (GL, spawn/respawn timing, visual look) stays manual:
`npm run dev` — strokes flow downstream and bend through swirls, Flow=0 gives
straight trails, respawns enter from the upwind edge (no mid-screen pops), and
the screen stays populated.

## Notes from implementation (divergences from the initial design)

The initial design called for **random-position respawn + fade-in** and for
rendering blobs at the **stored trail points**. Both changed during
implementation once their visual artifacts surfaced:

- **Live-head resampling** replaced direct stored-point rendering (fixed the
  body freezing-then-hopping by one `spacing`).
- **Neighbour-based tangents** replaced per-segment tangents (fixed orientation
  shimmer on the long blobs).
- **Upwind-edge respawn** replaced random-position respawn (fixed strokes
  materializing mid-screen).
- **Spawn just past the edge** (not a full trail-length upwind) and
  **rebuild-in-place** (not re-scatter) fixed the screen starving / going blank.

## Out of scope

- GPU-side advection or compute. Integration stays CPU-side.
- Mouse/pointer interaction with the field.
- Variable stroke count over time (count stays fixed per Frequency).
- Preserving a "classic" rigid-conveyor mode (advection replaces it).
