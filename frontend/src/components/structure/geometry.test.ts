import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../api/types';
import { cellFromParams, latticeParams, toCart, toFrac, type Mat3 } from './geometry';

// fcc primitive cell of Si, a = 5.43 Angstrom (ibrav=2 convention)
const A = 5.43;
const FCC: Mat3 = [
  [0, A / 2, A / 2],
  [A / 2, 0, A / 2],
  [A / 2, A / 2, 0],
];

describe('lattice geometry', () => {
  it('computes lattice parameters and volume of the fcc primitive cell', () => {
    const p = latticeParams(FCC);
    expect(p.a).toBeCloseTo(A / Math.SQRT2, 10);
    expect(p.alpha).toBeCloseTo(60, 10);
    expect(p.beta).toBeCloseTo(60, 10);
    expect(p.gamma).toBeCloseTo(60, 10);
    expect(p.volume).toBeCloseTo(A ** 3 / 4, 10); // a^3/4 for fcc
  });

  it('round-trips fractional <-> cartesian coordinates', () => {
    const frac: Vec3 = [0.25, 0.25, 0.25];
    const cart = toCart(frac, FCC);
    expect(cart.map((x) => x / A)).toEqual([0.25, 0.25, 0.25].map((x) => expect.closeTo(x, 12)));
    expect(toFrac(cart, FCC).map((x) => expect.closeTo(x, 12))).toEqual(frac.map((x) => expect.closeTo(x, 12)));
  });

  it('rebuilds a cell with the same parameters from (a, b, c, alpha, beta, gamma)', () => {
    const p = latticeParams(FCC);
    const q = latticeParams(cellFromParams(p));
    for (const k of ['a', 'b', 'c', 'alpha', 'beta', 'gamma', 'volume'] as const) expect(q[k]).toBeCloseTo(p[k], 10);
  });
});
