import { HA_EV, RY_EV } from './units';

export { HA_EV, RY_EV }; // re-exported for existing imports

export function fmt(x: number | null | undefined, digits = 4): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (x !== 0 && (Math.abs(x) < 1e-3 || Math.abs(x) >= 1e6)) return x.toExponential(Math.max(1, digits - 1));
  return x.toFixed(digits);
}

export function fmtEnergy(ev: number | null | undefined, unit: 'eV' | 'Ry' | 'Ha' = 'eV', digits = 6): string {
  if (ev === null || ev === undefined) return '—';
  const v = unit === 'eV' ? ev : unit === 'Ry' ? ev / RY_EV : ev / HA_EV;
  return `${v.toFixed(digits)} ${unit}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || Number.isNaN(s)) return '—';
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function elapsed(fromIso: string | null | undefined, toIso?: string | null): string {
  if (!fromIso) return '—';
  const a = new Date(fromIso).getTime();
  const b = toIso ? new Date(toIso).getTime() : Date.now();
  return fmtDuration(Math.max(0, (b - a) / 1000));
}

export const STATUS_COLOR: Record<string, string> = {
  created: 'gray',
  submitting: 'cyan',
  queued: 'yellow',
  running: 'blue',
  done: 'teal',
  failed: 'red',
  cancelled: 'orange',
  lost: 'grape',
};
