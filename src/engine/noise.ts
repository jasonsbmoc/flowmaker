// ─── Smooth hash-based 3D value noise + divergence-free curl ──────────────────
// Pure, framework-agnostic. noise3 returns [0, 1); curl2 returns a 2D velocity
// vector that is the perpendicular gradient of noise3 (so it is divergence-free).

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Integer-lattice hash → [0, 1). Self-contained, no external seed state.
function lhash(ix: number, iy: number, iz: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (iy | 0), 0x165667b1);
  h = Math.imul(h ^ (iz | 0), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export function noise3(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const ux = fade(fx);
  const uy = fade(fy);
  const uz = fade(fz);

  const c000 = lhash(x0, y0, z0);
  const c100 = lhash(x0 + 1, y0, z0);
  const c010 = lhash(x0, y0 + 1, z0);
  const c110 = lhash(x0 + 1, y0 + 1, z0);
  const c001 = lhash(x0, y0, z0 + 1);
  const c101 = lhash(x0 + 1, y0, z0 + 1);
  const c011 = lhash(x0, y0 + 1, z0 + 1);
  const c111 = lhash(x0 + 1, y0 + 1, z0 + 1);

  const x00 = lerp(c000, c100, ux);
  const x10 = lerp(c010, c110, ux);
  const x01 = lerp(c001, c101, ux);
  const x11 = lerp(c011, c111, ux);

  const y0i = lerp(x00, x10, uy);
  const y1i = lerp(x01, x11, uy);

  return lerp(y0i, y1i, uz);
}

export const CURL_EPS = 1e-3;

export function curl2(x: number, y: number, t: number): [number, number] {
  const e = CURL_EPS;
  const dPsiDy = (noise3(x, y + e, t) - noise3(x, y - e, t)) / (2 * e);
  const dPsiDx = (noise3(x + e, y, t) - noise3(x - e, y, t)) / (2 * e);
  return [dPsiDy, -dPsiDx];
}

// ─── Fractal (fBm) variants for richer, less-repetitive flow ──────────────────
// Sum `octaves` of noise3 at doubling frequency and `gain`-scaled amplitude.
// A single octave (any gain) reduces exactly to noise3 / curl2. fbm3 is
// normalized to [0, 1); curlFbm divides out the amplitude-weighted mean
// frequency so its magnitude is roughly independent of octaves/gain — detail
// changes the character of the flow, not its strength.
// curlFbm stays divergence-free: it is the perpendicular gradient of a
// scalar potential (a linear sum of divergence-free per-octave curls).
export function fbm3(
  x: number,
  y: number,
  z: number,
  octaves: number,
  gain: number,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let sumAmp = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq);
    sumAmp += amp;
    freq *= 2;
    amp *= gain;
  }
  return sum / sumAmp;
}

export function curlFbm(
  x: number,
  y: number,
  t: number,
  octaves: number,
  gain: number,
): [number, number] {
  let amp = 1;
  let freq = 1;
  let sumAmp = 0;
  let gradScale = 0;
  for (let i = 0; i < octaves; i++) {
    sumAmp += amp;
    gradScale += amp * freq;
    freq *= 2;
    amp *= gain;
  }
  gradScale /= sumAmp;

  const e = CURL_EPS;
  const dPsiDy =
    (fbm3(x, y + e, t, octaves, gain) - fbm3(x, y - e, t, octaves, gain)) /
    (2 * e);
  const dPsiDx =
    (fbm3(x + e, y, t, octaves, gain) - fbm3(x - e, y, t, octaves, gain)) /
    (2 * e);
  return [dPsiDy / gradScale, -dPsiDx / gradScale];
}
