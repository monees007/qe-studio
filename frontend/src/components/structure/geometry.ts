// Pure geometry helpers for structures (no React).
import type { Structure, Vec3 } from '../../api/types';
import { MASSES, Z, labelToElement } from '../../lib/elements';

export type Mat3 = [Vec3, Vec3, Vec3];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function det(m: Mat3): number {
  return dot(m[0], cross(m[1], m[2]));
}

/** Inverse of a 3x3 matrix (rows). Returns null if singular. */
export function inv(m: Mat3): Mat3 | null {
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  const [a, b, c] = m;
  const r0 = scale(cross(b, c), 1 / d);
  const r1 = scale(cross(c, a), 1 / d);
  const r2 = scale(cross(a, b), 1 / d);
  // columns of inverse are r0,r1,r2 -> transpose to rows
  return [
    [r0[0], r1[0], r2[0]],
    [r0[1], r1[1], r2[1]],
    [r0[2], r1[2], r2[2]],
  ];
}

/** row vector v times matrix m (rows) */
export function vecMat(v: Vec3, m: Mat3): Vec3 {
  return [
    v[0] * m[0][0] + v[1] * m[1][0] + v[2] * m[2][0],
    v[0] * m[0][1] + v[1] * m[1][1] + v[2] * m[2][1],
    v[0] * m[0][2] + v[1] * m[1][2] + v[2] * m[2][2],
  ];
}

export function toFrac(xyz: Vec3, cell: Mat3): Vec3 {
  const im = inv(cell);
  return im ? vecMat(xyz, im) : [0, 0, 0];
}

export function toCart(frac: Vec3, cell: Mat3): Vec3 {
  return vecMat(frac, cell);
}

export interface LatticeParams {
  a: number;
  b: number;
  c: number;
  alpha: number;
  beta: number;
  gamma: number;
  volume: number;
}

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

export function latticeParams(cell: Mat3): LatticeParams {
  const [a, b, c] = cell;
  const ang = (u: Vec3, v: Vec3) => deg(Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (norm(u) * norm(v) || 1)))));
  return {
    a: norm(a),
    b: norm(b),
    c: norm(c),
    alpha: ang(b, c),
    beta: ang(a, c),
    gamma: ang(a, b),
    volume: Math.abs(det(cell)),
  };
}

/** Standard orientation: a along x, b in the xy plane. */
export function cellFromParams(p: Omit<LatticeParams, 'volume'>): Mat3 {
  const ca = Math.cos(rad(p.alpha));
  const cb = Math.cos(rad(p.beta));
  const cg = Math.cos(rad(p.gamma));
  const sg = Math.sin(rad(p.gamma));
  const cx = cb;
  const cy = (ca - cb * cg) / sg;
  const cz = Math.sqrt(Math.max(0, 1 - cx * cx - cy * cy));
  return [
    [p.a, 0, 0],
    [p.b * cg, p.b * sg, 0],
    [p.c * cx, p.c * cy, p.c * cz],
  ];
}

/** Minimum-image distance vector b - a (checks the 27 neighbouring images). */
export function micVector(a: Vec3, b: Vec3, cell: Mat3, pbc: [boolean, boolean, boolean]): Vec3 {
  const im = inv(cell);
  let d = sub(b, a);
  if (!im || !pbc.some(Boolean)) return d;
  const f = vecMat(d, im);
  const fr: Vec3 = [
    pbc[0] ? f[0] - Math.round(f[0]) : f[0],
    pbc[1] ? f[1] - Math.round(f[1]) : f[1],
    pbc[2] ? f[2] - Math.round(f[2]) : f[2],
  ];
  let best = vecMat(fr, cell);
  let bestN = norm(best);
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      for (let k = -1; k <= 1; k++) {
        if ((i && !pbc[0]) || (j && !pbc[1]) || (k && !pbc[2])) continue;
        const v = vecMat([fr[0] + i, fr[1] + j, fr[2] + k], cell);
        const n = norm(v);
        if (n < bestN - 1e-12) {
          best = v;
          bestN = n;
        }
      }
  d = best;
  return d;
}

export function angleDeg(u: Vec3, v: Vec3): number {
  return deg(Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (norm(u) * norm(v) || 1)))));
}

export function elementOf(s: Structure, label: string): string {
  return s.species[label]?.element ?? labelToElement(label);
}

export function formulaOf(s: Structure): string {
  const counts = new Map<string, number>();
  for (const site of s.sites) {
    const el = elementOf(s, site.species);
    counts.set(el, (counts.get(el) ?? 0) + 1);
  }
  return [...counts.entries()].map(([el, n]) => `${el}${n > 1 ? n : ''}`).join('');
}

/** Reduced formula (counts divided by their greatest common divisor). */
export function reducedFormula(s: Structure): string {
  const counts = new Map<string, number>();
  for (const site of s.sites) {
    const el = elementOf(s, site.species);
    counts.set(el, (counts.get(el) ?? 0) + 1);
  }
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = [...counts.values()].reduce((a, b) => gcd(a, b), 0) || 1;
  return [...counts.entries()].map(([el, n]) => `${el}${n / g > 1 ? n / g : ''}`).join('');
}

export function speciesOrder(s: Structure): string[] {
  const out: string[] = [];
  for (const site of s.sites) if (!out.includes(site.species)) out.push(site.species);
  return out;
}

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** Ensure every label used by a site has a species entry with an element (+ default mass). */
export function ensureSpecies(s: Structure): Structure {
  const species = { ...s.species };
  for (const site of s.sites) {
    if (!species[site.species]) {
      const el = labelToElement(site.species);
      species[site.species] = {
        element: el,
        mass: MASSES[Z[el] ?? 0] ?? null,
        pseudo: null,
        magnetization: null,
        hubbard_u: null,
      };
    }
  }
  const used = new Set(s.sites.map((x) => x.species));
  for (const k of Object.keys(species)) if (!used.has(k)) delete species[k];
  return { ...s, species };
}

const f = (x: number, d = 6) => x.toFixed(d).padStart(d + 5);

/** Plain-text description used as AI context. */
export function structureText(s: Structure, name?: string, spacegroup?: string | null): string {
  const lp = latticeParams(s.cell as Mat3);
  const lines = [
    `name: ${name ?? s.name ?? 'structure'}`,
    `formula: ${formulaOf(s)} (${s.sites.length} atoms)`,
    spacegroup ? `space group: ${spacegroup}` : '',
    `pbc: ${s.pbc.join(' ')}`,
    `lattice (Angstrom/deg): a=${lp.a.toFixed(5)} b=${lp.b.toFixed(5)} c=${lp.c.toFixed(5)} alpha=${lp.alpha.toFixed(3)} beta=${lp.beta.toFixed(3)} gamma=${lp.gamma.toFixed(3)} V=${lp.volume.toFixed(4)} A^3`,
    'cell vectors (Angstrom):',
    ...s.cell.map((v) => `  ${f(v[0])} ${f(v[1])} ${f(v[2])}`),
    'species:',
    ...Object.entries(s.species).map(
      ([k, v]) =>
        `  ${k}: element=${v.element} mass=${v.mass ?? 'default'} pseudo=${v.pseudo ?? 'library default'}` +
        `${v.magnetization != null ? ` starting_magnetization=${v.magnetization}` : ''}${v.hubbard_u != null ? ` U=${v.hubbard_u} eV` : ''}`,
    ),
    'sites (fractional coordinates):',
  ].filter(Boolean);
  const maxSites = 400;
  s.sites.slice(0, maxSites).forEach((site) => {
    const fr = toFrac(site.xyz, s.cell as Mat3);
    const fx = site.fixed?.some(Boolean) ? `  fixed=${site.fixed.map((b) => (b ? 0 : 1)).join('')}` : '';
    lines.push(`  ${site.species.padEnd(5)} ${f(fr[0])} ${f(fr[1])} ${f(fr[2])}${fx}`);
  });
  if (s.sites.length > maxSites) lines.push(`  ... ${s.sites.length - maxSites} more sites omitted`);
  return lines.join('\n');
}
