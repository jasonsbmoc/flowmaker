// 2D canvas overlay that renders a square-dot grid in the paper color, then
// masks it so it's only visible through soft-edged reveals — either placed
// nodes or the transient reveal that follows the cursor in grid mode. Mirrors
// the grid math from the Paper-Grid-Generator, limited to the square style.

import { cfg } from './config';
import { getState, subscribe } from './gridStore';

interface Reveal {
  x: number; // normalized
  y: number;
  radius: number; // normalized (fraction of min side)
  feather: number; // 0..1
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let maskCanvas: HTMLCanvasElement | null = null;
let mctx: CanvasRenderingContext2D | null = null;

// Transient reveal that tracks the cursor while placing (null when not hovering).
let hoverReveal: Reveal | null = null;

let W = 1; // device pixels
let H = 1;
let dpr = 1;

// Same grid derivation as the grids tool, so density behaves identically.
function computeGrid(canvasW: number, canvasH: number, density: number) {
  const baseCount = Math.max(2, 3 + (density - 1));
  const shortSide = Math.min(canvasW, canvasH);
  const approxCell = shortSide / baseCount;
  const cols = Math.max(1, Math.round(canvasW / approxCell));
  const rows = Math.max(1, Math.round(canvasH / approxCell));
  return { cellW: canvasW / cols, cellH: canvasH / rows, cols, rows };
}

function paperRgb(): [number, number, number] {
  const n = parseInt(cfg.paper.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function drawGridLayer() {
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, W, H);

  const { visible, density, nodes } = getState();
  if (!visible) return;

  const reveals: Reveal[] = [...nodes];
  if (hoverReveal) reveals.push(hoverReveal);
  if (reveals.length === 0) return; // nothing to reveal

  // ── Square dots (full-opacity paper color) ───────────────────
  const { cellW, cellH, cols, rows } = computeGrid(W, H, density);
  const shortCell = Math.min(cellW, cellH);
  const s = Math.max(2 * dpr, shortCell * 0.11);
  const [r, g, b] = paperRgb();
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  for (let i = 1; i < cols; i++) {
    for (let j = 1; j < rows; j++) {
      ctx.fillRect(i * cellW - s / 2, j * cellH - s / 2, s, s);
    }
  }

  // ── Reveal mask (union of soft radial gradients) ─────────────
  if (!maskCanvas || !mctx) return;
  mctx.clearRect(0, 0, W, H);
  mctx.globalCompositeOperation = 'lighter'; // union overlapping reveals
  const minSide = Math.min(W, H);
  for (const n of reveals) {
    const cx = n.x * W;
    const cy = n.y * H;
    const rad = Math.max(1, n.radius * minSide);
    const inner = Math.max(0, rad * (1 - n.feather));
    const grad = mctx.createRadialGradient(
      cx,
      cy,
      Math.min(inner, rad - 0.01),
      cx,
      cy,
      rad,
    );
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = grad;
    mctx.beginPath();
    mctx.arc(cx, cy, rad, 0, Math.PI * 2);
    mctx.fill();
  }
  mctx.globalCompositeOperation = 'source-over';

  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
}

/** Set (or clear) the transient cursor reveal and redraw. */
export function setHoverReveal(reveal: Reveal | null) {
  hoverReveal = reveal;
  drawGridLayer();
}

export function initGridLayer(el: HTMLCanvasElement): () => void {
  canvas = el;
  ctx = el.getContext('2d');
  maskCanvas = document.createElement('canvas');
  mctx = maskCanvas.getContext('2d');
  return subscribe(drawGridLayer);
}

export function resizeGridLayer(cssW: number, cssH: number) {
  if (!canvas) return;
  dpr = window.devicePixelRatio || 1;
  W = Math.max(1, Math.round(cssW * dpr));
  H = Math.max(1, Math.round(cssH * dpr));
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  if (maskCanvas) {
    maskCanvas.width = W;
    maskCanvas.height = H;
  }
  drawGridLayer();
}

export function getGridCanvas(): HTMLCanvasElement | null {
  return canvas;
}

export function disposeGridLayer() {
  canvas = null;
  ctx = null;
  maskCanvas = null;
  mctx = null;
  hoverReveal = null;
}
