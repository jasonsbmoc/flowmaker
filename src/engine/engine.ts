import { cfg } from './config';

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
let flowAxisLen = 0,
  perpAxisLen = 0,
  flowPeriod = 0,
  flowMargin = 0,
  centerAlong = 0,
  centerPerp = 0;

let strokes: Stroke[] = [];
let rafId: number | null = null;

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
  computeFlowGeometry();
}

function computeFlowGeometry() {
  const ca = Math.abs(Math.cos(cfg.angle));
  const sa = Math.abs(Math.sin(cfg.angle));
  flowAxisLen = W * ca + H * sa;
  perpAxisLen = W * sa + H * ca;
  centerAlong = (W / 2) * Math.cos(cfg.angle) + (H / 2) * Math.sin(cfg.angle);
  centerPerp = (-W / 2) * Math.sin(cfg.angle) + (H / 2) * Math.cos(cfg.angle);
  flowMargin = (halfLen + blobR) * 1.6;
  flowPeriod = flowAxisLen + 2 * flowMargin;
}

interface BlobOffset {
  along: number;
  perp: number;
  localAngleDelta: number;
  alphaFactor: number;
}

function computeBlobOffsets(warpPhase: number): BlobOffset[] {
  const stepDist = blobR * 0.65;
  const nSteps = clamp(Math.round((halfLen * 2) / stepDist), 2, 60);
  const offsets: BlobOffset[] = [];

  for (let i = 0; i <= nSteps; i++) {
    const t = i / nSteps;
    const along = (t - 0.5) * halfLen * 2;
    const envelope = Math.sin(t * Math.PI);
    const perp =
      Math.sin(t * Math.PI * 3 + warpPhase) * blobR * turbAmt * 6.0 * envelope;

    let localAngleDelta = 0;
    if (turbAmt > 0.01) {
      const dt = 1 / nSteps;
      const env2 = Math.sin((t + dt) * Math.PI);
      const p2 =
        Math.sin((t + dt) * Math.PI * 3 + warpPhase) *
        blobR *
        turbAmt *
        6.0 *
        env2;
      localAngleDelta = Math.atan2(-(p2 - perp), halfLen * 2 * dt) * 0.55;
    }

    offsets.push({
      along,
      perp,
      localAngleDelta,
      alphaFactor: Math.pow(envelope, 0.4),
    });
  }
  return offsets;
}

// ─── Stroke ───────────────────────────────────────────────────────────────────
class Stroke {
  sVar: number;
  aVar: number;
  warpPhase: number;
  blobs: BlobOffset[];
  laneParam: number;
  toneParam: number;
  progress: number;

  constructor(rng: () => number, initial: boolean) {
    this.sVar = lerp(0.7, 1.3, rng());
    this.aVar = lerp(0.45, 1.0, rng());
    this.warpPhase = rng() * Math.PI * 2;
    this.blobs = computeBlobOffsets(this.warpPhase);
    this.laneParam = rng();
    this.toneParam = rng();
    this.progress = initial ? rng() * flowPeriod : 0;
  }

  get cx(): number {
    const along = centerAlong - flowAxisLen / 2 - flowMargin + this.progress;
    const lane = centerPerp + (this.laneParam - 0.5) * perpAxisLen * 1.05;
    return along * Math.cos(cfg.angle) - lane * Math.sin(cfg.angle);
  }
  get cy(): number {
    const along = centerAlong - flowAxisLen / 2 - flowMargin + this.progress;
    const lane = centerPerp + (this.laneParam - 0.5) * perpAxisLen * 1.05;
    return along * Math.sin(cfg.angle) + lane * Math.cos(cfg.angle);
  }

  advance(px: number) {
    this.progress = (this.progress + px) % flowPeriod;
  }

  writeQuads(blobIndex: number, palette: [number, number, number][]): number {
    const ca = Math.cos(cfg.angle);
    const sa = Math.sin(cfg.angle);
    const rx = blobLong * this.sVar;
    const ry = blobR * this.sVar;
    const ti = norm(cfg.intensity, 1, 10);
    const alph = lerp(0.06, 0.95, ti * ti) * this.aVar;
    const scx = this.cx;
    const scy = this.cy;

    const pidx = Math.min(
      palette.length - 1,
      Math.floor(this.toneParam * palette.length),
    );
    const [cr, cg, cb] = palette[pidx];
    const rf = cr / 255,
      gf = cg / 255,
      bf = cb / 255;

    let qi = 0;
    for (const b of this.blobs) {
      if (b.alphaFactor < 0.015) continue;
      if (blobIndex + qi >= MAX_BLOBS) break;

      const wx = scx + ca * b.along - sa * b.perp;
      const wy = scy + sa * b.along + ca * b.perp;
      const wa = cfg.angle + b.localAngleDelta;
      const a = alph * b.alphaFactor;
      const cw = Math.cos(wa),
        sw = Math.sin(wa);

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

// ─── Stroke pool ──────────────────────────────────────────────────────────────
export function rebuildStrokes() {
  computeParams();
  const rng = mkRng(cfg.seed * 9301 + 49297);
  strokes = [];
  for (let i = 0; i < strokeCount; i++) {
    strokes.push(new Stroke(rng, true));
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
  const pxPerFrame = Math.pow(10, lerp(-0.52, 0.92, norm(cfg.speed, 1, 10)));
  for (const s of strokes) s.advance(pxPerFrame);
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
  computeFlowGeometry();
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
