import { describe, expect, it } from 'vitest';
import { CM1_PER_MEV, CM1_PER_THZ, RY_BOHR_TO_EV_A, joinSeries } from './util';
import { BOHR_A, HA_EV, RY_EV } from '../../lib/units';

describe('unit conversions (CODATA 2018)', () => {
  it('are consistent with each other', () => {
    expect(HA_EV / RY_EV).toBeCloseTo(2, 12);
    expect(BOHR_A).toBe(0.529177210903); // as in QE 7.x (see backend test_units_match_quantum_espresso)
    expect(RY_BOHR_TO_EV_A).toBeCloseTo(25.711033738, 8);
    expect(CM1_PER_THZ).toBeCloseTo(1e12 / 2.99792458e10, 9); // c in cm/s
    expect(CM1_PER_MEV).toBeCloseTo(8065.543937 / 1000, 9); // 1 eV = 8065.543937 cm^-1
  });
});

describe('joinSeries (band/phonon line plots)', () => {
  it('draws each band as one polyline, separated by nulls and split at path breaks', () => {
    const x = [0, 1, 2, 3];
    const bands = [
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ];
    const j = joinSeries(x, bands, [2], 1, 2);
    // band 0: k=0,1 | break | k=2,3 | end ; band 1 likewise
    expect(j.x).toEqual([0, 1, null, 2, 3, null, 0, 1, null, 2, 3, null]);
    expect(j.y).toEqual([0, 2, null, 4, 6, null, 18, 38, null, 58, 78, null]);
  });
});
