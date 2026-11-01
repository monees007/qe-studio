// Helpers to convert between Fortran-namelist values (as JSON from the backend) and form strings.
import type { SchemaVar } from '../../api/types';

export type NLValue = string | number | boolean | (string | number | boolean)[] | null;

const REAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eEdDqQ][+-]?\d+)?$/;
const INT_RE = /^[+-]?\d+$/;

export function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '.true.' : '.false.';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v);
}

export function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(formatScalar).join(', ');
  return formatScalar(v);
}

export function parseReal(s: string): number | null {
  const t = s.trim();
  if (!REAL_RE.test(t)) return null;
  const n = Number(t.replace(/[dDqQ]/, 'e'));
  return Number.isFinite(n) ? n : null;
}

/** Parse free text the way QE would read an unquoted scalar. */
export function parseLoose(s: string): string | number | boolean {
  const t = s.trim();
  const low = t.toLowerCase();
  if (['.true.', '.t.', 'true', 't'].includes(low)) return true;
  if (['.false.', '.f.', 'false', 'f'].includes(low)) return false;
  if (INT_RE.test(t)) return parseInt(t, 10);
  const r = parseReal(t);
  if (r !== null) return r;
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
}

export function parseList(s: string): NLValue {
  const parts = s
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(parseLoose);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : parts;
}

/** Sensible initial value when a parameter is added from the schema. */
export function defaultFor(v: SchemaVar): NLValue {
  const d = (v.default ?? '').trim().replace(/^'|'$/g, '');
  if (v.type === 'logical') return /true|\.t\./i.test(d);
  if (v.type === 'integer') {
    const n = parseInt(d, 10);
    return Number.isFinite(n) ? n : v.options?.length ? parseInt(v.options[0], 10) || 0 : 0;
  }
  if (v.type === 'real') {
    const r = parseReal(d);
    return r ?? 0;
  }
  if (v.options?.length) return v.options.includes(d) ? d : v.options[0];
  return d && !/\s/.test(d) ? d : '';
}

export function baseName(key: string): string {
  return key.split('(')[0];
}

export function indexOf(key: string): string | null {
  const m = key.match(/\(([^)]*)\)$/);
  return m ? m[1] : null;
}
