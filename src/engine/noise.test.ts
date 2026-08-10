import { describe, it, expect } from 'vitest';
import { noise3 } from './noise';

describe('noise3', () => {
  it('is deterministic for the same inputs', () => {
    expect(noise3(1.23, 4.56, 7.89)).toBe(noise3(1.23, 4.56, 7.89));
  });

  it('stays within [0, 1)', () => {
    for (let i = 0; i < 500; i++) {
      const v = noise3(i * 0.37, -i * 1.13, i * 0.05);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is smooth: nearby samples are close', () => {
    let maxJump = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.011;
      const a = noise3(x, 3.3, 0.7);
      const b = noise3(x + 0.01, 3.3, 0.7);
      maxJump = Math.max(maxJump, Math.abs(a - b));
    }
    // A 0.01 step over unit-spaced lattice must not jump wildly.
    expect(maxJump).toBeLessThan(0.1);
  });

  it('actually varies across space (not constant)', () => {
    const vals = [noise3(0.5, 0.5, 0), noise3(5.5, 2.1, 0), noise3(11.2, 8.8, 0)];
    const allEqual = vals.every((v) => v === vals[0]);
    expect(allEqual).toBe(false);
  });
});

import { curl2, CURL_EPS, fbm3, curlFbm } from './noise';

describe('curl2', () => {
  it('is deterministic', () => {
    expect(curl2(1.5, 2.5, 0.3)).toEqual(curl2(1.5, 2.5, 0.3));
  });

  it('produces non-trivial (non-zero) velocity somewhere', () => {
    let maxMag = 0;
    for (let i = 0; i < 200; i++) {
      const [vx, vy] = curl2(i * 0.13, i * 0.27, 0.1);
      maxMag = Math.max(maxMag, Math.hypot(vx, vy));
    }
    expect(maxMag).toBeGreaterThan(0.01);
  });

  it('is perpendicular to the noise gradient (it is a rotated gradient)', () => {
    const e = CURL_EPS;
    for (let i = 0; i < 100; i++) {
      const x = i * 0.21 + 0.05;
      const y = i * 0.17 + 0.05;
      const t = i * 0.03;
      const gx = (noise3(x + e, y, t) - noise3(x - e, y, t)) / (2 * e);
      const gy = (noise3(x, y + e, t) - noise3(x, y - e, t)) / (2 * e);
      const [vx, vy] = curl2(x, y, t);
      // curl = (gy, -gx) ⇒ dot with gradient (gx, gy) is exactly 0.
      expect(Math.abs(vx * gx + vy * gy)).toBeLessThan(1e-9);
    }
  });

  it('is divergence-free (∂vx/∂x + ∂vy/∂y ≈ 0)', () => {
    const h = CURL_EPS; // matched stencil ⇒ exact cancellation to float noise
    for (let i = 0; i < 100; i++) {
      const x = i * 0.31 + 0.07;
      const y = i * 0.23 + 0.07;
      const t = i * 0.05;
      const dvx_dx = (curl2(x + h, y, t)[0] - curl2(x - h, y, t)[0]) / (2 * h);
      const dvy_dy = (curl2(x, y + h, t)[1] - curl2(x, y - h, t)[1]) / (2 * h);
      expect(Math.abs(dvx_dx + dvy_dy)).toBeLessThan(1e-6);
    }
  });
});

describe('fbm3 / curlFbm', () => {
  it('fbm3 with one octave equals noise3', () => {
    for (let i = 0; i < 50; i++) {
      const x = i * 0.31 + 0.1;
      const y = i * 0.17 + 0.2;
      const z = i * 0.05;
      expect(fbm3(x, y, z, 1, 0.5)).toBe(noise3(x, y, z));
    }
  });

  it('curlFbm with one octave equals curl2', () => {
    for (let i = 0; i < 50; i++) {
      const x = i * 0.23 + 0.1;
      const y = i * 0.19 + 0.2;
      const t = i * 0.04;
      expect(curlFbm(x, y, t, 1, 0.5)).toEqual(curl2(x, y, t));
    }
  });

  it('fbm3 stays within [0, 1) for many octaves', () => {
    for (let i = 0; i < 500; i++) {
      const v = fbm3(i * 0.37, -i * 1.13, i * 0.05, 4, 0.6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('curlFbm is divergence-free for multiple octaves', () => {
    const h = CURL_EPS; // matched stencil ⇒ cancellation to float noise
    for (let i = 0; i < 100; i++) {
      const x = i * 0.31 + 0.07;
      const y = i * 0.23 + 0.07;
      const t = i * 0.05;
      const dvx_dx =
        (curlFbm(x + h, y, t, 4, 0.6)[0] - curlFbm(x - h, y, t, 4, 0.6)[0]) /
        (2 * h);
      const dvy_dy =
        (curlFbm(x, y + h, t, 4, 0.6)[1] - curlFbm(x, y - h, t, 4, 0.6)[1]) /
        (2 * h);
      expect(Math.abs(dvx_dx + dvy_dy)).toBeLessThan(1e-5);
    }
  });

  it('curlFbm magnitude stays bounded across octaves/gain (detail ≠ strength)', () => {
    // Normalization keeps the fractal curl from blowing up vs the single octave.
    let maxMag = 0;
    for (let i = 0; i < 20000; i++) {
      const x = (i * 0.013) % 50;
      const y = (i * 0.0071) % 50;
      const t = (i * 0.0009) % 30;
      const [vx, vy] = curlFbm(x, y, t, 4, 0.6);
      maxMag = Math.max(maxMag, Math.abs(vx), Math.abs(vy));
    }
    // Single-octave curl peaks ~1.825; normalized fBm must stay in the same ballpark.
    expect(maxMag).toBeLessThan(3.0);
  });
});
