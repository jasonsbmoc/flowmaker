import { useEffect, useRef, useState } from 'react';
import Coloris from '@melloware/coloris';
import { cfg } from '../engine/config';
import { drawFrame } from '../engine/engine';
import { drawGridLayer } from '../engine/gridLayer';

interface ColorRowProps {
  label: string;
  cfgKey: 'ink' | 'paper';
}

export function ColorRow({ label, cfgKey }: ColorRowProps) {
  const [hex, setHex] = useState<string>(cfg[cfgKey]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Wrap this input in a .clr-field if it isn't already (re-mounted after
    // folder collapse/expand needs re-wrapping). The `wrap` method exists at
    // runtime but is missing from upstream Coloris types.
    (Coloris as unknown as { wrap: (el: HTMLElement) => void }).wrap(el);
    const onInput = () => {
      const v = el.value;
      setHex(v);
      cfg[cfgKey] = v;
      if (!cfg.playing) drawFrame();
      // Grid squares track the paper color.
      if (cfgKey === 'paper') drawGridLayer();
    };
    el.addEventListener('input', onInput);
    return () => el.removeEventListener('input', onInput);
  }, [cfgKey]);

  return (
    <div className="dialkit-color-control">
      <span className="dialkit-color-label">{label}</span>
      <div className="dialkit-color-inputs">
        <span className="dialkit-color-hex">{hex.toUpperCase()}</span>
        <input
          ref={inputRef}
          data-coloris
          type="text"
          defaultValue={hex}
          aria-label={`${label} color`}
        />
      </div>
    </div>
  );
}
