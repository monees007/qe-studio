import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyScf, feedScf, parseScf } from './liveScf';

// real pw.x 7.6 output shipped with the backend tests (Si, 2 atoms, scf)
const SCF_OUT = readFileSync(
  fileURLToPath(new URL('../../../backend/tests/data/scf/si.scf.out', import.meta.url)),
  'utf8',
);

describe('live SCF parser', () => {
  it('reads iterations, accuracy and the final energy of a pw.x run', () => {
    const s = parseScf(SCF_OUT);
    expect(s.steps).toHaveLength(1);
    expect(s.total).toBe(5);
    expect(s.steps[0].converged).toBe(true);
    expect(s.steps[0].finalRy).toBeCloseTo(-20.41157462, 8);
    expect(s.jobDone).toBe(true);
    expect(s.notConverged).toBe(false);
    const acc = s.steps[0].iterations.map((i) => i.accuracyRy);
    expect(acc.every((a) => a !== null && a > 0)).toBe(true);
  });

  it('gives the same result when the text arrives in arbitrary chunks', () => {
    let s = emptyScf();
    for (let i = 0; i < SCF_OUT.length; i += 777) s = feedScf(s, SCF_OUT.slice(i, i + 777));
    s = feedScf(s, '\n');
    const whole = parseScf(SCF_OUT);
    expect(s.total).toBe(whole.total);
    expect(s.steps[0].finalRy).toBe(whole.steps[0].finalRy);
    expect(s.steps[0].iterations).toEqual(whole.steps[0].iterations);
  });

  it('returns the same object when nothing changed (cheap React updates)', () => {
    const s = parseScf(SCF_OUT + '\n');
    expect(feedScf(s, '')).toBe(s);
  });
});
