// Workflow catalogue: kinds, default parameters and conversion to backend /api/qe/workflow params.
import {
  IconAtom,
  IconChartDots,
  IconChartLine,
  IconCube,
  IconPlayerPlay,
  IconRoute,
  IconTarget,
  IconWaveSine,
} from '@tabler/icons-react';

export type Kind = 'single' | 'bands' | 'dos' | 'phonon' | 'density' | 'convergence' | 'eos';

export const KINDS: { kind: Kind; title: string; desc: string; icon: typeof IconAtom; color: string }[] = [
  {
    kind: 'single',
    title: 'Single pw.x run',
    desc: 'Run the base input as is (scf, relax, vc-relax, md…).',
    icon: IconPlayerPlay,
    color: 'blue',
  },
  {
    kind: 'bands',
    title: 'Band structure',
    desc: 'SCF → NSCF on a high-symmetry path → bands.x (optional fat bands).',
    icon: IconRoute,
    color: 'indigo',
  },
  {
    kind: 'dos',
    title: 'DOS / PDOS',
    desc: 'SCF → dense NSCF → dos.x → projwfc.x.',
    icon: IconChartLine,
    color: 'teal',
  },
  {
    kind: 'phonon',
    title: 'Phonons',
    desc: 'SCF → ph.x on a q-grid → q2r.x → matdyn.x dispersion and DOS.',
    icon: IconWaveSine,
    color: 'grape',
  },
  {
    kind: 'density',
    title: 'Charge density',
    desc: 'SCF → pp.x to a Gaussian cube (density, potentials, ELF…).',
    icon: IconCube,
    color: 'orange',
  },
  {
    kind: 'convergence',
    title: 'Convergence test',
    desc: 'Independent SCFs scanning a cutoff, k-mesh or smearing.',
    icon: IconTarget,
    color: 'red',
  },
  {
    kind: 'eos',
    title: 'Equation of state',
    desc: 'Volume scan and Birch–Murnaghan fit (V₀, B₀, B′).',
    icon: IconChartDots,
    color: 'cyan',
  },
];

export const PLOT_NUMS = [
  { value: '0', label: '0 · electron (pseudo-)charge density' },
  { value: '1', label: '1 · total potential V_bare + V_H + V_xc' },
  { value: '2', label: '2 · local ionic potential V_bare' },
  { value: '6', label: '6 · spin polarization ρ↑ − ρ↓' },
  { value: '8', label: '8 · electron localization function (ELF)' },
  { value: '9', label: '9 · ρ minus superposition of atomic densities' },
  { value: '11', label: '11 · V_bare + V_H potential' },
  { value: '21', label: '21 · all-electron density (PAW only)' },
];

export type Params = Record<string, any>;

export const DEFAULTS: Record<Kind, Params> = {
  single: {},
  bands: { npoints: 120, path: '', nbnd: '', projwfc: false },
  dos: { kmesh_factor: 2, nbnd: '', emin: '', emax: '', delta_e: 0.01, pdos: true, occupations: 'tetrahedra_opt' },
  phonon: {
    nq1: '',
    nq2: '',
    nq3: '',
    npoints: 100,
    path: '',
    tr2_ph: '1e-14',
    asr: 'crystal',
    d1: '',
    d2: '',
    d3: '',
    epsil: false,
  },
  density: { plot_num: '0', output_format: '6', extra: '' },
  convergence: { parameter: 'ecutwfc', values: '25, 30, 35, 40, 45, 50, 60', dual: '', start: '', stop: '', step: '' },
  eos: { npoints: 7, max_strain: 0.06, relax_ions: false },
};

export function num(v: unknown): number | undefined {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseValues(param: string, raw: string): unknown[] {
  const entries = raw
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (param === 'kpoints') {
    return entries.map((e) => {
      const p = e
        .split(/[x×\s]+/)
        .map((x) => parseInt(x, 10))
        .filter((x) => Number.isFinite(x));
      return p.length === 1 ? [p[0], p[0], p[0]] : p.slice(0, 3);
    });
  }
  return entries.map(Number).filter((x) => Number.isFinite(x));
}

export function buildParams(kind: Kind, p: Params): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (kind) {
    case 'bands':
      out.npoints = num(p.npoints) ?? 120;
      if (p.path?.trim()) out.path = p.path.trim();
      if (num(p.nbnd)) out.nbnd = num(p.nbnd);
      out.projwfc = !!p.projwfc;
      break;
    case 'dos':
      out.kmesh_factor = num(p.kmesh_factor) ?? 2;
      if (num(p.nbnd)) out.nbnd = num(p.nbnd);
      if (num(p.emin) !== undefined) out.emin = num(p.emin);
      if (num(p.emax) !== undefined) out.emax = num(p.emax);
      out.delta_e = num(p.delta_e) ?? 0.01;
      out.pdos = !!p.pdos;
      out.occupations = p.occupations;
      break;
    case 'phonon': {
      const nq = [num(p.nq1), num(p.nq2), num(p.nq3)];
      if (nq.every((x) => x)) out.nq = nq;
      out.npoints = num(p.npoints) ?? 100;
      if (p.path?.trim()) out.path = p.path.trim();
      out.tr2_ph = num(String(p.tr2_ph).replace(/[dD]/, 'e')) ?? 1e-14;
      out.asr = p.asr;
      const dm = [num(p.d1), num(p.d2), num(p.d3)];
      if (dm.every((x) => x)) out.dos_mesh = dm;
      out.epsil = !!p.epsil;
      break;
    }
    case 'density':
      out.plot_num = Number(p.plot_num);
      out.output_format = Number(p.output_format);
      if (p.extra?.trim()) out.extra = JSON.parse(p.extra);
      break;
    case 'convergence':
      out.parameter = p.parameter;
      out.values = parseValues(p.parameter, p.values);
      if (num(p.dual)) out.dual = num(p.dual);
      break;
    case 'eos':
      out.npoints = num(p.npoints) ?? 7;
      out.max_strain = num(p.max_strain) ?? 0.06;
      out.relax_ions = !!p.relax_ions;
      break;
    default:
      break;
  }
  return out;
}

export function buildParamsSafe(kind: Kind, p: Params): Record<string, unknown> {
  try {
    return buildParams(kind, p);
  } catch {
    return p;
  }
}
