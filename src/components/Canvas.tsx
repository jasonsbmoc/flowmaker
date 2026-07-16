import { useEffect, useRef } from 'react';
import { dispose, init, resize } from '../engine/engine';
import { GridLayer } from './GridLayer';

export function Canvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    init(canvas, wrap);

    let rszTimer: number | undefined;
    const onResize = () => {
      window.clearTimeout(rszTimer);
      rszTimer = window.setTimeout(resize, 120);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(rszTimer);
      dispose();
    };
  }, []);

  return (
    <div id="canvas-wrap" ref={wrapRef}>
      <canvas id="canvas" ref={canvasRef} />
      <GridLayer wrapRef={wrapRef} />
    </div>
  );
}
