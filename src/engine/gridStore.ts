// Shared reactive state for the square-dot grid overlay and its reveal nodes.
// Kept separate from the WebGL `cfg` because nodes need immutable updates so
// React's useSyncExternalStore can detect changes by reference.

export interface GridNode {
  id: number;
  x: number; // center, normalized 0..1 of canvas width
  y: number; // center, normalized 0..1 of canvas height
  radius: number; // normalized fraction of min(width, height)
  feather: number; // 0..1 — fraction of radius that fades out (edge blur)
}

interface GridState {
  visible: boolean; // grid mode: cursor reveals + placed nodes show
  density: number; // 1..20 — higher = more squares
  nodes: GridNode[];
}

export const MAX_NODES = 3;
export const DENSITY_MIN = 1;
export const DENSITY_MAX = 30;

// Defaults applied to the cursor preview and every placed node.
export const DEFAULT_RADIUS = 0.2;
export const DEFAULT_FEATHER = 0.7;

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

let state: GridState = {
  visible: false,
  density: 20,
  nodes: [],
};

let nextId = 1;

const listeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): GridState {
  return state;
}

function set(partial: Partial<GridState>) {
  state = { ...state, ...partial };
  listeners.forEach((l) => l());
}

export function setVisible(v: boolean) {
  set({ visible: v });
}

export function setDensity(d: number) {
  set({ density: clamp(Math.round(d), DENSITY_MIN, DENSITY_MAX) });
}

/** Place a node at a normalized position. Returns its id, or null if full. */
export function addNodeAt(x: number, y: number): number | null {
  if (state.nodes.length >= MAX_NODES) return null;
  const id = nextId++;
  const node: GridNode = {
    id,
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    radius: DEFAULT_RADIUS,
    feather: DEFAULT_FEATHER,
  };
  set({ nodes: [...state.nodes, node] });
  return id;
}

export function removeNode(id: number) {
  set({ nodes: state.nodes.filter((n) => n.id !== id) });
}

export function updateNode(id: number, patch: Partial<GridNode>) {
  set({
    nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  });
}
