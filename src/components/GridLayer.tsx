import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import {
  disposeGridLayer,
  initGridLayer,
  resizeGridLayer,
  setHoverReveal,
} from '../engine/gridLayer';
import { setOverlay } from '../engine/engine';
import {
  addNodeAt,
  DEFAULT_FEATHER,
  DEFAULT_RADIUS,
  getState,
  MAX_NODES,
  removeNode,
  subscribe,
  updateNode,
} from '../engine/gridStore';

interface GridLayerProps {
  wrapRef: RefObject<HTMLDivElement | null>;
}

type Part = 'move' | 'radius' | 'feather' | 'remove';
interface Hit {
  id: number;
  part: Part;
}

const RING_TOL = 8; // px band for grabbing a ring
const CENTER_GRAB = 12;
const REMOVE_GRAB = 11;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function GridLayer({ wrapRef }: GridLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useSyncExternalStore(subscribe, getState);
  const { visible, nodes } = state;

  const [size, setSize] = useState({ w: 0, h: 0 }); // CSS px
  const [focused, setFocused] = useState<number | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; part: Exclude<Part, 'remove'> } | null>(
    null,
  );

  // ── Mount: init 2D layer, register for export, track wrap size ──
  useEffect(() => {
    const el = canvasRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;

    const unsubscribe = initGridLayer(el);
    setOverlay(el);

    const applySize = () => {
      setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
      resizeGridLayer(wrap.clientWidth, wrap.clientHeight);
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(wrap);

    return () => {
      ro.disconnect();
      unsubscribe();
      setOverlay(null);
      disposeGridLayer();
    };
  }, [wrapRef]);

  // ── Pointer interaction (all logic lives on the wrap element) ──
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const local = (e: PointerEvent) => {
      const rect = wrap.getBoundingClientRect();
      return {
        px: e.clientX - rect.left,
        py: e.clientY - rect.top,
        rect,
      };
    };

    // What, if anything, is under the cursor?
    const hitTest = (px: number, py: number, rect: DOMRect): Hit | null => {
      const minSide = Math.min(rect.width, rect.height);
      const list = getState().nodes;
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        const cx = n.x * rect.width;
        const cy = n.y * rect.height;
        const radPx = n.radius * minSide;
        const innerPx = radPx * (1 - n.feather);
        const dist = Math.hypot(px - cx, py - cy);

        // Remove button sits at the top-right of the ring.
        const rmx = cx + radPx * 0.7071;
        const rmy = cy - radPx * 0.7071;
        if (Math.hypot(px - rmx, py - rmy) <= REMOVE_GRAB) {
          return { id: n.id, part: 'remove' };
        }
        if (dist <= radPx + RING_TOL) {
          if (Math.abs(dist - radPx) <= RING_TOL) return { id: n.id, part: 'radius' };
          if (Math.abs(dist - innerPx) <= RING_TOL) return { id: n.id, part: 'feather' };
          if (dist <= CENTER_GRAB || dist <= radPx) return { id: n.id, part: 'move' };
        }
      }
      return null;
    };

    const cursorFor = (part: Part | null): string => {
      switch (part) {
        case 'move':
          return 'move';
        case 'radius':
        case 'feather':
          return 'ew-resize';
        case 'remove':
          return 'pointer';
        default:
          return 'crosshair';
      }
    };

    const clearHover = () => {
      setHoverReveal(null);
      setGhost(null);
      if (!drag.current) setFocused(null);
      wrap.style.cursor = '';
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!getState().visible) return;
      const { px, py, rect } = local(e);
      const hit = hitTest(px, py, rect);
      if (hit) {
        if (hit.part === 'remove') {
          removeNode(hit.id);
          setFocused(null);
          setHoverReveal(null);
          setGhost(null);
          return;
        }
        setFocused(hit.id);
        drag.current = { id: hit.id, part: hit.part };
        setHoverReveal(null);
        setGhost(null);
        return;
      }
      // Empty canvas → place a node.
      if (getState().nodes.length < MAX_NODES) {
        const id = addNodeAt(clamp01(px / rect.width), clamp01(py / rect.height));
        if (id != null) {
          setFocused(id);
          setHoverReveal(null);
          setGhost(null);
        }
      }
    };

    const onHoverMove = (e: PointerEvent) => {
      if (!getState().visible || drag.current) return;
      const { px, py, rect } = local(e);
      const hit = hitTest(px, py, rect);
      if (hit) {
        setFocused(hit.id);
        setGhost(null);
        setHoverReveal(null);
        wrap.style.cursor = cursorFor(hit.part);
        return;
      }
      // Empty canvas → preview a placement (unless at the node cap).
      setFocused(null);
      if (getState().nodes.length < MAX_NODES) {
        setGhost({ x: px, y: py });
        setHoverReveal({
          x: clamp01(px / rect.width),
          y: clamp01(py / rect.height),
          radius: DEFAULT_RADIUS,
          feather: DEFAULT_FEATHER,
        });
        wrap.style.cursor = 'crosshair';
      } else {
        setGhost(null);
        setHoverReveal(null);
        wrap.style.cursor = '';
      }
    };

    const onDragMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const { px, py, rect } = local(e);
      const node = getState().nodes.find((n) => n.id === d.id);
      if (!node) return;
      if (d.part === 'move') {
        updateNode(d.id, {
          x: clamp01(px / rect.width),
          y: clamp01(py / rect.height),
        });
        return;
      }
      const minSide = Math.min(rect.width, rect.height);
      const cx = node.x * rect.width;
      const cy = node.y * rect.height;
      const dist = Math.hypot(px - cx, py - cy);
      if (d.part === 'radius') {
        updateNode(d.id, { radius: Math.max(0.02, dist / minSide) });
      } else {
        const radPx = Math.max(1, node.radius * minSide);
        updateNode(d.id, {
          feather: Math.max(0, Math.min(0.95, 1 - dist / radPx)),
        });
      }
    };

    const onPointerUp = () => {
      drag.current = null;
    };

    wrap.addEventListener('pointerdown', onPointerDown);
    wrap.addEventListener('pointermove', onHoverMove);
    wrap.addEventListener('pointerleave', clearHover);
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      wrap.removeEventListener('pointerdown', onPointerDown);
      wrap.removeEventListener('pointermove', onHoverMove);
      wrap.removeEventListener('pointerleave', clearHover);
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onPointerUp);
      wrap.style.cursor = '';
    };
  }, [wrapRef]);

  const minSide = Math.min(size.w, size.h);

  return (
    <>
      <canvas className="grid-canvas" ref={canvasRef} />
      {visible && (
        <svg
          className="grid-handles"
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
        >
          {nodes.map((n) => {
            const cx = n.x * size.w;
            const cy = n.y * size.h;
            const radPx = n.radius * minSide;
            const innerPx = radPx * (1 - n.feather);
            const isFocused = focused === n.id;
            return (
              <g key={n.id} className="grid-node">
                {isFocused && (
                  <>
                    <circle className="grid-ring grid-ring-radius" cx={cx} cy={cy} r={radPx} />
                    <circle
                      className="grid-ring grid-ring-feather"
                      cx={cx}
                      cy={cy}
                      r={Math.max(2, innerPx)}
                    />
                    <g
                      className="grid-node-remove"
                      transform={`translate(${cx + radPx * 0.7071}, ${cy - radPx * 0.7071})`}
                    >
                      <circle r={9} />
                      <line x1={-3.5} y1={-3.5} x2={3.5} y2={3.5} />
                      <line x1={-3.5} y1={3.5} x2={3.5} y2={-3.5} />
                    </g>
                    <circle className="grid-node-center" cx={cx} cy={cy} r={6} />
                  </>
                )}
              </g>
            );
          })}

          {ghost && (
            <g className="grid-ghost">
              <line x1={ghost.x - 6} y1={ghost.y} x2={ghost.x + 6} y2={ghost.y} />
              <line x1={ghost.x} y1={ghost.y - 6} x2={ghost.x} y2={ghost.y + 6} />
            </g>
          )}
        </svg>
      )}
    </>
  );
}
