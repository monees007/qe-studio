import type { Structure, Vec3 } from '../../api/types';
import { SYMBOLS } from '../../lib/elements';

export { CM1_PER_MEV, CM1_PER_THZ, RY_BOHR_TO_EV_A } from '../../lib/units';

export const PROGRAM_KEY: Record<string, string> = {
  'pw.x': 'pw',
  'ph.x': 'ph',
  'pp.x': 'pp',
  'dos.x': 'dos',
  'projwfc.x': 'projwfc',
  'bands.x': 'bands',
  'q2r.x': 'q2r',
  'matdyn.x': 'matdyn',
  'hp.x': 'hp',
  'neb.x': 'neb',
};

export const FINAL_STATUSES = ['done', 'failed', 'cancelled', 'lost'];
export const ACTIVE_STATUSES = ['submitting', 'queued', 'running'];

/** Backend timestamps may lack a UTC offset (SQLite); treat those as UTC. */
export function utcIso<T extends string | null | undefined>(iso: T): T {
  if (!iso) return iso;
  return (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`) as T;
}

export function parseIso(iso: string | null | undefined): number {
  return iso ? new Date(utcIso(iso)).getTime() : NaN;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = parseIso(iso);
  if (Number.isNaN(t)) return iso;
  const s = (Date.now() - t) / 1000;
  if (s < 0) return 'just now';
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 30 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

/**
 * Flatten series that share an x-axis (bands, phonon branches) into a single Plotly trace,
 * separating series by `null` and breaking lines at path discontinuities.
 * values[k][b] -> one polyline per b.
 */
export function joinSeries(
  x: number[],
  values: (number | null)[][],
  breaks: number[] = [],
  shift = 0,
  scale = 1,
): {
  x: (number | null)[];
  y: (number | null)[];
} {
  const nk = Math.min(x.length, values.length);
  const nb = nk ? Math.max(...values.slice(0, nk).map((r) => r.length)) : 0;
  const br = new Set(breaks);
  const X: (number | null)[] = [];
  const Y: (number | null)[] = [];
  for (let b = 0; b < nb; b++) {
    for (let k = 0; k < nk; k++) {
      if (br.has(k) && k > 0) {
        X.push(null);
        Y.push(null);
      }
      const v = values[k][b];
      X.push(x[k]);
      Y.push(v === null || v === undefined || Number.isNaN(v) ? null : (v - shift) * scale);
    }
    X.push(null);
    Y.push(null);
  }
  return { x: X, y: Y };
}

/** Plotly shapes: vertical lines at high-symmetry ticks and a horizontal reference line at y=0. */
export function tickShapes(ticks: { x: number }[], zeroLine = true): any[] {
  const shapes: any[] = ticks.map((t) => ({
    type: 'line',
    xref: 'x',
    yref: 'paper',
    x0: t.x,
    x1: t.x,
    y0: 0,
    y1: 1,
    line: { color: 'rgba(128,128,128,0.55)', width: 1 },
  }));
  if (zeroLine) {
    shapes.push({
      type: 'line',
      xref: 'paper',
      yref: 'y',
      x0: 0,
      x1: 1,
      y0: 0,
      y1: 0,
      line: { color: 'rgba(200,50,50,0.7)', width: 1, dash: 'dash' },
    });
  }
  return shapes;
}

/** Structure for the 3D viewer from cube-file atoms (atomic numbers) and cell. */
export function structureFromCube(atoms: { z: number; xyz: Vec3 | number[] }[], cell: number[][]): Structure {
  const species: Structure['species'] = {};
  const sites = atoms.map((a) => {
    const el = SYMBOLS[a.z] ?? 'X';
    species[el] = { element: el };
    return {
      species: el,
      xyz: [a.xyz[0], a.xyz[1], a.xyz[2]] as Vec3,
      fixed: [false, false, false] as [boolean, boolean, boolean],
    };
  });
  return {
    cell: [
      [cell[0][0], cell[0][1], cell[0][2]],
      [cell[1][0], cell[1][1], cell[1][2]],
      [cell[2][0], cell[2][1], cell[2][2]],
    ],
    pbc: [true, true, true],
    sites,
    species,
  };
}

export function finiteMin(arr: (number | null | undefined)[]): number | null {
  let m: number | null = null;
  for (const v of arr) if (v !== null && v !== undefined && Number.isFinite(v) && (m === null || v < m)) m = v;
  return m;
}

export function finiteMax(arr: (number | null | undefined)[]): number | null {
  let m: number | null = null;
  for (const v of arr) if (v !== null && v !== undefined && Number.isFinite(v) && (m === null || v > m)) m = v;
  return m;
}

/** Compact JSON for AI context (drops large arrays). */
export function compactJson(obj: unknown, maxArray = 12, maxLen = 40_000): string {
  const s = JSON.stringify(
    obj,
    (_k, v) => {
      if (Array.isArray(v) && v.length > maxArray) {
        return [...v.slice(0, maxArray), `… ${v.length - maxArray} more`];
      }
      if (typeof v === 'number' && !Number.isInteger(v)) return Number(v.toPrecision(8));
      return v;
    },
    1,
  );
  return s.length > maxLen ? `${s.slice(0, maxLen)}\n… truncated` : s;
}
