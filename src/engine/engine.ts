import { cfg } from './config';
import {
  seedTrail,
  advanceTrail,
  walkTrail,
  inflowHead,
  type FlowParams,
  type TrailState,
} from './flow';

// ─── PRNG (mulberry32) ────────────────────────────────────────────────────────
function mkRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Utils ────────────────────────────────────────────────────────────────────
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const norm = (v: number, lo: number, hi: number) => (v - lo) / (hi - lo);
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return [h, s, l];
}

function hslToRgb(
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

function computeTonePalette(): [number, number, number][] {
  const [h, s, l] = hexToHsl(cfg.ink);
  const nSteps = Math.round((cfg.toneVariance - 1) / 2);
  const palette: [number, number, number][] = [];
  for (let i = -nSteps; i <= nSteps; i++) {
    palette.push(
      hslToRgb(h, s, Math.max(0.04, Math.min(0.96, l + i * 0.1))),
    );
  }
  return palette;
}

// ─── Shaders ──────────────────────────────────────────────────────────────────
const VS = `
  attribute vec2  aPos;
  attribute vec2  aUv;
  attribute float aAlpha;
  attribute vec3  aColor;
  varying vec2  vUv;
  varying float vAlpha;
  varying vec3  vColor;
  uniform vec2 uRes;
  void main() {
    vec2 clip = (aPos / uRes) * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    vUv    = aUv;
    vAlpha = aAlpha;
    vColor = aColor;
  }
`;

const FS = `
  precision mediump float;
  varying vec2  vUv;
  varying float vAlpha;
  varying vec3  vColor;
  uniform float uSoftness;
  uniform float uEdgeRough;

  float hash1(float n) {
    return fract(sin(n) * 43758.5453);
  }

  float edgeWarp(vec2 p) {
    float angle = atan(p.y, p.x);
    float n  = hash1(angle * 1.9 + 0.3);
    n += 0.50 * hash1(angle * 4.1 + 1.7);
    n += 0.25 * hash1(angle * 8.3 + 3.2);
    n /= 1.75;
    return (n - 0.5) * uEdgeRough;
  }

  void main() {
    vec2  p = vUv * 2.0 - 1.0;
    float r = length(p);

    float warp = edgeWarp(p) * smoothstep(0.25, 1.0, r);
    float d = r + warp;

    if (d >= 1.0) discard;

    float coreExp = mix(5.0, 0.45, uSoftness);
    float core    = pow(1.0 - d, coreExp) * 0.80;
    float halo    = pow(1.0 - d, 0.32) * 0.20;

    gl_FragColor  = vec4(vColor, clamp(vAlpha * (core + halo), 0.0, 1.0));
  }
`;

const GRAIN_VS = `
  attribute vec2 aPos;
  void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const GRAIN_FS = `
  precision mediump float;
  uniform float uTime;
  uniform float uStrength;
  float hash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  void main() {
    float g = hash(vec3(gl_FragCoord.xy, floor(uTime)));
    float brightness = step(0.5, g);
    float alpha = abs(g - 0.5) * 2.0 * uStrength;
    gl_FragColor = vec4(vec3(brightness), alpha);
  }
`;

// ─── Module state ─────────────────────────────────────────────────────────────
let canvas!: HTMLCanvasElement;
let wrap!: HTMLElement;
let gl!: WebGLRenderingContext;
let prog!: WebGLProgram;
let grainProg!: WebGLProgram;
let vbo!: WebGLBuffer;
let ibo!: WebGLBuffer;
let grainVbo!: WebGLBuffer;

const MAX_BLOBS = 8000;
// Fractal flow: octaves of noise summed for multi-scale (less cyclic) motion,
// and a slow domain drift so the field streams rather than oscillating in place.
const FLOW_OCTAVES = 4;
const FLOW_DRIFT = 0.6; // noise-units of domain translation per unit flowTime
const BLOB_SPACING_FACTOR = 0.65; // trail-point spacing as a fraction of blobR
const SPAWN_FADE_FRAMES = 24; // ~0.4s alpha fade-in after an in-flight respawn
// Per-blob quad corner UVs (constant); corner offsets CX/CY are per-stroke.
const CU = [0, 1, 1, 0];
const CV = [0, 0, 1, 1];
const F_PER_V = 8;
const V_PER_Q = 4;
const STRIDE_BYTES = F_PER_V * 4;

const vertBuf = new Float32Array(MAX_BLOBS * V_PER_Q * F_PER_V);
const indexBuf = new Uint16Array(MAX_BLOBS * 6);
for (let i = 0; i < MAX_BLOBS; i++) {
  const b = i * 4;
  indexBuf[i * 6 + 0] = b;
  indexBuf[i * 6 + 1] = b + 1;
  indexBuf[i * 6 + 2] = b + 2;
  indexBuf[i * 6 + 3] = b;
  indexBuf[i * 6 + 4] = b + 2;
  indexBuf[i * 6 + 5] = b + 3;
}

let loc!: {
  aPos: number;
  aUv: number;
  aAlpha: number;
  aColor: number;
  uRes: WebGLUniformLocation | null;
  uSoft: WebGLUniformLocation | null;
  uEdgeRough: WebGLUniformLocation | null;
};
let grainLoc!: {
  aPos: number;
  uTime: WebGLUniformLocation | null;
  uStrength: WebGLUniformLocation | null;
};

let W = 1,
  H = 1;
let blobR = 0,
  blobLong = 0,
  halfLen = 0,
  softness = 0,
  turbAmt = 0,
  strokeCount = 0;
let nSteps = 0, // blobs per stroke (trail capacity)
  spacing = 0, // arc-length spacing between trail points (px)
  flowMargin = 0; // off-screen spawn/cull margin (px)
let flowTime = 0;

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
// Only the very first build scatters strokes across the screen for instant
// coverage. Later rebuilds (slider/resize) keep existing strokes in place and
// bring any new ones in from the upwind edge, so nothing pops in mid-screen.
let firstBuild = true;

// Optional 2D overlay (grid layer) composited into exports.
let overlayCanvas: HTMLCanvasElement | null = null;
export function setOverlay(c: HTMLCanvasElement | null) {
  overlayCanvas = c;
}

// ─── Geometry ─────────────────────────────────────────────────────────────────
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

  spacing = blobR * BLOB_SPACING_FACTOR;
  nSteps = clamp(Math.round((halfLen * 2) / spacing), 2, 60) + 1;
  // A full trail (nSteps*spacing) plus a blob radius must sit off-screen.
  flowMargin = nSteps * spacing + blobLong;
}

// Refresh the velocity-field params from config + flowTime. Cheap; called each
// frame so the non-rebuild sliders (Flow, Flow Scale, Detail, Speed) take effect.
function updateFlowParams() {
  const ca = Math.cos(cfg.angle);
  const sa = Math.sin(cfg.angle);
  const windSpeed = Math.pow(10, lerp(-0.52, 0.92, norm(cfg.speed, 1, 10)));
  flowParams.windX = ca * windSpeed;
  flowParams.windY = sa * windSpeed;
  flowParams.invScale = 1 / lerp(120, 1400, norm(cfg.flowScale, 1, 10));
  // Curl velocity scales with wind so Flow reads as "swirliness vs the current".
  flowParams.strength = norm(cfg.flow, 0, 10) * windSpeed * 1.5;
  flowParams.gain = lerp(0.0, 0.6, norm(cfg.detail, 1, 10));
  // Domain drift: translate the field along the wind so it streams over time.
  flowParams.driftX = ca * FLOW_DRIFT * flowTime;
  flowParams.driftY = sa * FLOW_DRIFT * flowTime;
}

// Place a stroke at a random point in screen+margin and pre-seed its trail.
// initial=true scatters the head across the whole area so the screen is full
// immediately on (re)build. initial=false enters just past the upwind edge so
// the body stays off-screen and drifts on promptly (instead of materializing
// mid-screen, and instead of starting a full trail-length away which left the
// screen starved while strokes transited back). blobLong (one head-blob long
// axis) is just enough for the head to sit off-screen; the cull trigger stays
// at flowMargin so an exiting stroke's whole body clears before it recycles.
function spawnStroke(s: Stroke, initial: boolean) {
  if (initial) {
    s.headX = -flowMargin + spawnRng() * (W + 2 * flowMargin);
    s.headY = -flowMargin + spawnRng() * (H + 2 * flowMargin);
  } else {
    const head = inflowHead(W, H, cfg.angle, blobLong, spawnRng());
    s.headX = head.x;
    s.headY = head.y;
  }
  seedTrail(s.headX, s.headY, flowTime, flowParams, spacing, nSteps, s.trail);
}

// ─── Stroke ───────────────────────────────────────────────────────────────────
class Stroke {
  sVar: number;
  aVar: number;
  warpPhase: number;
  toneParam: number;
  headX = 0;
  headY = 0;
  age = 999; // frames since spawn; large = fully faded in
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
    this.age++;
    if (
      this.headX < -flowMargin ||
      this.headX > W + flowMargin ||
      this.headY < -flowMargin ||
      this.headY > H + flowMargin
    ) {
      spawnStroke(this, false);
      this.age = 0;
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

    const places = walkTrail(this.headX, this.headY, this.trail.pts, nSteps, spacing);
    const fade = Math.min(1, this.age / SPAWN_FADE_FRAMES);
    const CX = [-rx, rx, rx, -rx];
    const CY = [-ry, -ry, ry, ry];
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

// ─── Stroke pool ──────────────────────────────────────────────────────────────
export function rebuildStrokes() {
  computeParams();
  updateFlowParams();
  const rng = mkRng(cfg.seed * 9301 + 49297);

  if (firstBuild || strokes.length === 0) {
    // First render: scatter across the whole area for instant coverage.
    spawnRng = mkRng(cfg.seed * 2654435761 + 1013904223);
    strokes = [];
    for (let i = 0; i < strokeCount; i++) {
      const s = new Stroke(rng);
      spawnStroke(s, true);
      strokes.push(s);
    }
    firstBuild = false;
    return;
  }

  // Later rebuilds: keep existing strokes where they are (re-seed their trails
  // with the new geometry, head unchanged) so nothing teleports; trim extras
  // and bring any new strokes in from the upwind edge.
  while (strokes.length > strokeCount) strokes.pop();
  for (const s of strokes) {
    seedTrail(s.headX, s.headY, flowTime, flowParams, spacing, nSteps, s.trail);
  }
  while (strokes.length < strokeCount) {
    const s = new Stroke(rng);
    spawnStroke(s, false);
    strokes.push(s);
  }
}

// ─── Frame render ─────────────────────────────────────────────────────────────
export function drawFrame() {
  const [pr, pg, pb] = hexRgb(cfg.paper);
  gl.clearColor(pr / 255, pg / 255, pb / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.enableVertexAttribArray(loc.aPos);
  gl.enableVertexAttribArray(loc.aUv);
  gl.enableVertexAttribArray(loc.aAlpha);
  gl.enableVertexAttribArray(loc.aColor);
  gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, STRIDE_BYTES, 0);
  gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, STRIDE_BYTES, 2 * 4);
  gl.vertexAttribPointer(loc.aAlpha, 1, gl.FLOAT, false, STRIDE_BYTES, 4 * 4);
  gl.vertexAttribPointer(loc.aColor, 3, gl.FLOAT, false, STRIDE_BYTES, 5 * 4);

  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform2f(loc.uRes, W, H);
  gl.uniform1f(loc.uSoft, softness);
  gl.uniform1f(loc.uEdgeRough, lerp(0.0, 0.55, norm(cfg.edgeRough, 0, 10)));

  // Note: flowParams is refreshed in tick() before advance() (and in
  // rebuildStrokes/setAngle for static redraws); drawFrame() doesn't read it.

  const palette = computeTonePalette();
  let totalBlobs = 0;
  for (const s of strokes) {
    totalBlobs += s.writeQuads(totalBlobs, palette);
    if (totalBlobs >= MAX_BLOBS) break;
  }
  if (totalBlobs > 0) {
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      vertBuf.subarray(0, totalBlobs * V_PER_Q * F_PER_V),
    );
    gl.drawElements(gl.TRIANGLES, totalBlobs * 6, gl.UNSIGNED_SHORT, 0);
  }

  if (cfg.grain) {
    gl.useProgram(grainProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, grainVbo);
    gl.disableVertexAttribArray(loc.aUv);
    gl.disableVertexAttribArray(loc.aAlpha);
    gl.disableVertexAttribArray(loc.aColor);
    gl.enableVertexAttribArray(grainLoc.aPos);
    gl.vertexAttribPointer(grainLoc.aPos, 2, gl.FLOAT, false, 8, 0);
    const strength = lerp(0.04, 0.32, norm(cfg.grainAmt, 1, 10));
    const grainDiv = lerp(200, 16, norm(cfg.grainSpeed, 1, 10));
    gl.uniform1f(grainLoc.uTime, performance.now() / grainDiv);
    gl.uniform1f(grainLoc.uStrength, strength);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }
}

// ─── Animation loop ───────────────────────────────────────────────────────────
function tick() {
  updateFlowParams();
  for (const s of strokes) s.advance();
  flowTime += lerp(0.0008, 0.02, norm(cfg.flowDrift, 1, 10));
  drawFrame();
  if (cfg.playing) rafId = requestAnimationFrame(tick);
}

export function play() {
  if (rafId) cancelAnimationFrame(rafId);
  cfg.playing = true;
  tick();
}

export function pause() {
  cfg.playing = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

export function togglePlay(): boolean {
  if (cfg.playing) {
    pause();
  } else {
    play();
  }
  return cfg.playing;
}

// ─── Resize ───────────────────────────────────────────────────────────────────
export function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = Math.round(wrap.clientWidth * dpr);
  H = Math.round(wrap.clientHeight * dpr);
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  gl.viewport(0, 0, W, H);
  rebuildStrokes();
  if (!cfg.playing) drawFrame();
}

// ─── Angle ────────────────────────────────────────────────────────────────────
export function setAngle(rad: number) {
  cfg.angle = rad;
  updateFlowParams();
  if (!cfg.playing) drawFrame();
}

// ─── Export image ─────────────────────────────────────────────────────────────
// JPEG @ q=0.92 — canvas has no alpha, and painterly output compresses well.
export function exportImage() {
  drawFrame();
  let href: string;
  if (overlayCanvas) {
    // Composite the grid overlay on top of the painted flow.
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const octx = out.getContext('2d')!;
    octx.drawImage(canvas, 0, 0);
    octx.drawImage(overlayCanvas, 0, 0, out.width, out.height);
    href = out.toDataURL('image/jpeg', 0.92);
  } else {
    href = canvas.toDataURL('image/jpeg', 0.92);
  }
  const a = document.createElement('a');
  a.download = 'painted_' + Date.now() + '.jpg';
  a.href = href;
  a.click();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function mkShader(type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('createShader failed');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || 'shader compile error');
  return s;
}

export function init(canvasEl: HTMLCanvasElement, wrapEl: HTMLElement) {
  canvas = canvasEl;
  wrap = wrapEl;

  const ctx = canvas.getContext('webgl', {
    alpha: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
  });
  if (!ctx) {
    alert('WebGL not available');
    throw new Error('WebGL not available');
  }
  gl = ctx;

  prog = gl.createProgram()!;
  gl.attachShader(prog, mkShader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, mkShader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog) || 'link error');

  loc = {
    aPos: gl.getAttribLocation(prog, 'aPos'),
    aUv: gl.getAttribLocation(prog, 'aUv'),
    aAlpha: gl.getAttribLocation(prog, 'aAlpha'),
    aColor: gl.getAttribLocation(prog, 'aColor'),
    uRes: gl.getUniformLocation(prog, 'uRes'),
    uSoft: gl.getUniformLocation(prog, 'uSoftness'),
    uEdgeRough: gl.getUniformLocation(prog, 'uEdgeRough'),
  };

  grainProg = gl.createProgram()!;
  gl.attachShader(grainProg, mkShader(gl.VERTEX_SHADER, GRAIN_VS));
  gl.attachShader(grainProg, mkShader(gl.FRAGMENT_SHADER, GRAIN_FS));
  gl.linkProgram(grainProg);
  if (!gl.getProgramParameter(grainProg, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(grainProg) || 'grain link error');

  grainLoc = {
    aPos: gl.getAttribLocation(grainProg, 'aPos'),
    uTime: gl.getUniformLocation(grainProg, 'uTime'),
    uStrength: gl.getUniformLocation(grainProg, 'uStrength'),
  };

  grainVbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, grainVbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
    gl.STATIC_DRAW,
  );

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertBuf, gl.DYNAMIC_DRAW);

  ibo = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexBuf, gl.STATIC_DRAW);

  resize();
  play();
}

export function dispose() {
  pause();
  if (gl) {
    if (vbo) gl.deleteBuffer(vbo);
    if (ibo) gl.deleteBuffer(ibo);
    if (grainVbo) gl.deleteBuffer(grainVbo);
    if (prog) gl.deleteProgram(prog);
    if (grainProg) gl.deleteProgram(grainProg);
  }
}
