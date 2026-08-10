import { describe, it, expect } from 'vitest';
import { cfg } from './config';

// The engine's motion is verified by flow.test.ts (pure field/trail math) and
// by manual visual checks (GL output). This guards the config surface the UI
// drives so a renamed/removed key is caught by the suite.
describe('engine config surface', () => {
  it('exposes the flow controls the UI binds to', () => {
    for (const k of ['flow', 'flowScale', 'flowDrift', 'detail', 'speed'] as const) {
      expect(typeof cfg[k]).toBe('number');
    }
  });
});
