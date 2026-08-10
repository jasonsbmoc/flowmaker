import { describe, it, expect } from 'vitest';
import { flowVelocity, seedTrail, advanceTrail, walkTrail, inflowHead, type FlowParams, type TrailState, type TrailPoint } from './flow';

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

describe('walkTrail', () => {
  // A straight stored trail upstream of the head. Head is the live position,
  // pts go -x (older upstream). Stored points are 10 apart.
  const pts: TrailPoint[] = Array.from({ length: 12 }, (_, i) => ({
    x: -(i + 1) * 10, // pts[0] is one spacing behind the head at x=0
    y: 0,
  }));

  it('returns up to count placements with blob 0 on the live head', () => {
    const ps = walkTrail(0, 0, pts, 8, 10);
    expect(ps.length).toBe(8);
    expect(ps[0].x).toBeCloseTo(0, 6);
    expect(ps[0].y).toBeCloseTo(0, 6);
    expect(walkTrail(0, 0, [], 8, 10)).toEqual([]);
  });

  it('samples at arc-length multiples of spacing back from the head', () => {
    const ps = walkTrail(0, 0, pts, 6, 10);
    for (let i = 0; i < ps.length; i++) {
      expect(ps[i].x).toBeCloseTo(-i * 10, 4); // i*spacing upstream
      expect(ps[i].y).toBeCloseTo(0, 4);
    }
  });

  it('tangent points along the flow (toward the head) and is unit length', () => {
    const ps = walkTrail(0, 0, pts, 10, 10);
    for (const pl of ps) {
      expect(Math.hypot(pl.tx, pl.ty)).toBeCloseTo(1, 6);
      expect(pl.tx).toBeGreaterThan(0.99); // flow is +x
    }
  });

  it('envelope fades both ends and peaks in the middle', () => {
    const ps = walkTrail(0, 0, pts, 12, 10);
    expect(ps[0].env).toBeCloseTo(0, 6);
    expect(ps[ps.length - 1].env).toBeCloseTo(0, 6);
    expect(ps[6].env).toBeGreaterThan(0.8);
  });

  it('blob 0 tracks the head continuously: a small head move moves it the same (no spacing hop)', () => {
    // This is the regression: rendering must follow the live head, not the
    // discrete stored points (which only update on spacing crossings).
    const a = walkTrail(0, 0, pts, 8, 10);
    const b = walkTrail(0.7, 0, pts, 8, 10); // head nudged 0.7px downstream
    const d = Math.hypot(b[0].x - a[0].x, b[0].y - a[0].y);
    expect(d).toBeCloseTo(0.7, 4);
  });

  it('produces smooth per-frame motion under real advection (no frozen frames, no spacing hops)', () => {
    // Slow flow: the head crosses a spacing boundary only rarely. The OLD
    // index-based placement froze between crossings and hopped one spacing on
    // each. walkTrail must move blob 0 by ~|velocity| every frame instead.
    const spacing = 30;
    const cap = 20;
    const p: FlowParams = {
      windX: 2, windY: 0, invScale: 1 / 400, strength: 1,
      driftX: 0, driftY: 0, octaves: 4, gain: 0.5,
    };
    const st: TrailState = { pts: [], carry: 0 };
    let hx = 0, hy = 0;
    seedTrail(hx, hy, 0, p, spacing, cap, st);
    let t = 0;
    let prev: { x: number; y: number } | null = null;
    let frozen = 0, maxMove = 0;
    for (let f = 0; f < 300; f++) {
      const h = advanceTrail(st, hx, hy, t, p, spacing, cap);
      hx = h.x; hy = h.y; t += 0.01;
      const places = walkTrail(hx, hy, st.pts, cap, spacing);
      const head = places[0];
      if (prev) {
        const mv = Math.hypot(head.x - prev.x, head.y - prev.y);
        if (mv < 0.01) frozen++;
        maxMove = Math.max(maxMove, mv);
      }
      prev = { x: head.x, y: head.y };
    }
    expect(frozen).toBe(0); // never frozen
    expect(maxMove).toBeLessThan(spacing * 0.5); // no spacing-sized hops
  });
});

describe('inflowHead', () => {
  it('places the head upwind and fully off-screen (no mid-screen respawn)', () => {
    const W = 3200, H = 2000, angle = Math.PI / 4, margin = 500;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const axisLen = W * Math.abs(ca) + H * Math.abs(sa);
    for (let i = 0; i <= 10; i++) {
      const h = inflowHead(W, H, angle, margin, i / 10);
      // along-wind coordinate from center must be at least a half-extent + margin upwind
      const along = (h.x - W / 2) * ca + (h.y - H / 2) * sa;
      expect(along).toBeLessThanOrEqual(-(axisLen / 2 + margin) + 1e-6);
    }
  });

  it('spreads across the perpendicular extent as perpParam varies', () => {
    const a = inflowHead(3200, 2000, 0, 100, 0);
    const b = inflowHead(3200, 2000, 0, 100, 1);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1000);
  });
});

describe('walkTrail orientation continuity (regression)', () => {
  it('blob orientation changes only slightly per frame under advection', () => {
    // Neighbour-based tangents must not snap when a sample crosses a stored
    // vertex (which caused a visible per-frame orientation flick / shimmer).
    const spacing = 90, cap = 30;
    const p: FlowParams = {
      windX: 0.6, windY: 0.6, invScale: 1 / 600, strength: 1.5,
      driftX: 0, driftY: 0, octaves: 4, gain: 0.6,
    };
    const st: TrailState = { pts: [], carry: 0 };
    let hx = 0, hy = 0, t = 0;
    seedTrail(hx, hy, 0, p, spacing, cap, st);
    let prev: number[] | null = null;
    let maxDeg = 0;
    for (let f = 0; f < 800; f++) {
      const h = advanceTrail(st, hx, hy, t, p, spacing, cap);
      hx = h.x; hy = h.y; t += 0.01;
      const places = walkTrail(hx, hy, st.pts, cap, spacing);
      const ang = places.map((pl) => Math.atan2(pl.ty, pl.tx));
      if (prev) {
        for (let i = 0; i < places.length; i++) {
          if (places[i].env < 0.2) continue;
          let d = Math.abs(ang[i] - prev[i]);
          if (d > Math.PI) d = 2 * Math.PI - d;
          maxDeg = Math.max(maxDeg, (d * 180) / Math.PI);
        }
      }
      prev = ang;
    }
    expect(maxDeg).toBeLessThan(3); // was ~17deg with per-segment tangents
  });
});
