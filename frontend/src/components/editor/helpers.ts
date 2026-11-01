export const PROGRAM_EXE: Record<string, string> = {
  pw: 'pw.x',
  ph: 'ph.x',
  pp: 'pp.x',
  dos: 'dos.x',
  projwfc: 'projwfc.x',
  bands: 'bands.x',
  q2r: 'q2r.x',
  matdyn: 'matdyn.x',
  hp: 'hp.x',
};

/** File name acceptable to the backend ([A-Za-z0-9_.-]), with an extension. */
export function safeFileName(name: string, fallback = 'input.in'): string {
  const n = name
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^\.+/, '');
  if (!n) return fallback;
  return /\.[A-Za-z0-9]+$/.test(n) ? n : `${n}.in`;
}
