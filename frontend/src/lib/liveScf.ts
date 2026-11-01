// Incremental parser for streamed pw.x output: drives the live SCF convergence plot.
// Robust to chunks that split lines; ignores everything it does not recognise.

export interface LiveIteration {
  iter: number;
  energyRy: number | null;
  accuracyRy: number | null;
}

export interface LiveIonicStep {
  iterations: LiveIteration[];
  finalRy: number | null;
  converged: boolean;
}

export interface LiveScfState {
  steps: LiveIonicStep[];
  /** Total number of SCF iterations seen (all ionic steps). */
  total: number;
  /** Text after the last newline (incomplete line). */
  pending: string;
  notConverged: boolean;
  jobDone: boolean;
}

const NUM = String.raw`[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eEdD][-+]?\d+)?`;
const RE_ITER = /iteration #\s*(\d+)/;
const RE_ETOT = new RegExp(String.raw`^\s+total energy\s+=\s+(${NUM})\s+Ry`);
const RE_FINAL = new RegExp(String.raw`^!\s+total energy\s+=\s+(${NUM})\s+Ry`);
const RE_ACC = new RegExp(String.raw`estimated scf accuracy\s+<\s+(${NUM})\s+Ry`);
const RE_CONV = /convergence has been achieved/;
const RE_NOTCONV = /convergence NOT achieved/;

const num = (s: string) => Number(s.replace(/[dD]/, 'e'));

export function emptyScf(): LiveScfState {
  return { steps: [], total: 0, pending: '', notConverged: false, jobDone: false };
}

/** Feed a chunk of output; returns a NEW state object when something changed (else the same object). */
export function feedScf(prev: LiveScfState, chunk: string): LiveScfState {
  if (!chunk) return prev;
  const text = prev.pending + chunk;
  const lines = text.split('\n');
  const pending = lines.pop() ?? '';
  // copy-on-write (steps are small)
  const steps = prev.steps.map((s) => ({ ...s, iterations: s.iterations.slice() }));
  let total = prev.total;
  let notConverged = prev.notConverged;
  let jobDone = prev.jobDone;
  let changed = false;
  let cur = steps[steps.length - 1];

  for (const ln of lines) {
    let m = ln.match(RE_ITER);
    if (m) {
      if (!cur || cur.converged || cur.finalRy !== null) {
        cur = { iterations: [], finalRy: null, converged: false };
        steps.push(cur);
      }
      cur.iterations.push({ iter: Number(m[1]), energyRy: null, accuracyRy: null });
      total += 1;
      changed = true;
      continue;
    }
    if (!cur) continue;
    const last = cur.iterations[cur.iterations.length - 1];
    m = ln.match(RE_FINAL);
    if (m) {
      cur.finalRy = num(m[1]);
      if (last && last.energyRy === null) last.energyRy = cur.finalRy;
      changed = true;
      continue;
    }
    m = ln.match(RE_ETOT);
    if (m && last && last.energyRy === null) {
      last.energyRy = num(m[1]);
      changed = true;
      continue;
    }
    m = ln.match(RE_ACC);
    if (m && last && last.accuracyRy === null && !cur.converged) {
      last.accuracyRy = num(m[1]);
      changed = true;
      continue;
    }
    if (RE_CONV.test(ln)) {
      cur.converged = true;
      changed = true;
    } else if (RE_NOTCONV.test(ln)) {
      notConverged = true;
      cur.converged = true;
      changed = true;
    } else if (ln.includes('JOB DONE.')) {
      jobDone = true;
      changed = true;
    }
  }
  if (!changed) return pending === prev.pending ? prev : { ...prev, pending };
  return { steps, total, pending, notConverged, jobDone };
}

/** Convenience: parse a whole text at once. */
export function parseScf(text: string): LiveScfState {
  return feedScf(emptyScf(), text.endsWith('\n') ? text : `${text}\n`);
}
