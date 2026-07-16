import { useSyncExternalStore } from 'react';
import { Folder, Toggle } from 'dialkit';
import {
  getState,
  setDensity,
  setVisible,
  subscribe,
  DENSITY_MIN,
  DENSITY_MAX,
} from '../engine/gridStore';

export function GridControls() {
  const state = useSyncExternalStore(subscribe, getState);
  const { visible, density } = state;

  return (
    <Folder title="Grid" defaultOpen={false}>
      <Toggle label="Show grid" checked={visible} onChange={setVisible} />
      <div className="flm-stepper-row">
        <span className="flm-stepper-label">Density</span>
        <div className="flm-stepper-controls">
          <button
            className="flm-step-btn"
            onClick={() => setDensity(density - 1)}
            disabled={density <= DENSITY_MIN}
            aria-label="Decrease density"
          >
            −
          </button>
          <span className="flm-stepper-value">{density}</span>
          <button
            className="flm-step-btn"
            onClick={() => setDensity(density + 1)}
            disabled={density >= DENSITY_MAX}
            aria-label="Increase density"
          >
            +
          </button>
        </div>
      </div>
    </Folder>
  );
}
