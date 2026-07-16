import { useState } from 'react';
import { Folder, Slider, Toggle } from 'dialkit';
import type { Config } from '../engine/config';
import { cfg } from '../engine/config';
import { drawFrame, rebuildStrokes } from '../engine/engine';
import { AnglePicker } from './AnglePicker';
import { ColorRow } from './ColorRow';
import { GridControls } from './GridControls';

type NumKey = {
  [K in keyof Config]: Config[K] extends number ? K : never;
}[keyof Config];

function useNumCfg(key: NumKey, rebuild = false) {
  const [v, setV] = useState<number>(cfg[key] as number);
  const onChange = (next: number) => {
    setV(next);
    (cfg[key] as number) = next;
    if (rebuild) rebuildStrokes();
    if (!cfg.playing) drawFrame();
  };
  return [v, onChange] as const;
}

function useBoolCfg(key: 'grain') {
  const [v, setV] = useState<boolean>(cfg[key]);
  const onChange = (next: boolean) => {
    setV(next);
    cfg[key] = next;
    if (!cfg.playing) drawFrame();
  };
  return [v, onChange] as const;
}

export function FlowmakerControls() {
  const [frequency, setFrequency] = useNumCfg('frequency', true);
  const [intensity, setIntensity] = useNumCfg('intensity');
  const [length, setLength] = useNumCfg('length', true);
  const [smear, setSmear] = useNumCfg('smear', true);
  const [soft, setSoft] = useNumCfg('soft', true);
  const [toneVariance, setToneVariance] = useNumCfg('toneVariance');
  const [edgeRough, setEdgeRough] = useNumCfg('edgeRough');
  const [turbulence, setTurbulence] = useNumCfg('turbulence', true);
  const [speed, setSpeed] = useNumCfg('speed');
  const [seed, setSeed] = useNumCfg('seed', true);
  const [grain, setGrain] = useBoolCfg('grain');
  const [grainAmt, setGrainAmt] = useNumCfg('grainAmt');
  const [grainSpeed, setGrainSpeed] = useNumCfg('grainSpeed');

  return (
    <>
      <Folder title="Color" defaultOpen>
        <ColorRow label="Ink" cfgKey="ink" />
        <ColorRow label="Paper" cfgKey="paper" />
      </Folder>

      <Folder title="Direction" defaultOpen>
        <AnglePicker />
      </Folder>

      <GridControls />

      <Folder title="Stroke" defaultOpen>
        <Slider label="Frequency" value={frequency} onChange={setFrequency} min={1} max={10} step={1} />
        <Slider label="Intensity" value={intensity} onChange={setIntensity} min={1} max={10} step={1} />
        <Slider label="Length" value={length} onChange={setLength} min={1} max={10} step={1} />
        <Slider label="Smear" value={smear} onChange={setSmear} min={1} max={10} step={1} />
        <Slider label="Softness" value={soft} onChange={setSoft} min={1} max={10} step={1} />
        <Slider label="Tone Variance" value={toneVariance} onChange={setToneVariance} min={1} max={10} step={1} />
        <Slider label="Edge Texture" value={edgeRough} onChange={setEdgeRough} min={0} max={10} step={1} />
        <Slider label="Turbulence" value={turbulence} onChange={setTurbulence} min={0} max={10} step={1} />
      </Folder>

      <Folder title="Motion" defaultOpen={false}>
        <Slider label="Speed" value={speed} onChange={setSpeed} min={1} max={10} step={1} />
      </Folder>

      <Folder title="Random" defaultOpen={false}>
        <Slider label="Seed" value={seed} onChange={setSeed} min={0} max={999} step={1} />
      </Folder>

      <Folder title="Grain" defaultOpen={false}>
        <Toggle label="Enabled" checked={grain} onChange={setGrain} />
        <Slider label="Amount" value={grainAmt} onChange={setGrainAmt} min={1} max={10} step={1} />
        <Slider label="Grain Speed" value={grainSpeed} onChange={setGrainSpeed} min={1} max={10} step={1} />
      </Folder>
    </>
  );
}
