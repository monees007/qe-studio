// Shared types mirroring the backend JSON.

export type Vec3 = [number, number, number];

export interface SpeciesInfo {
  element: string;
  mass?: number | null;
  pseudo?: string | null;
  magnetization?: number | null;
  hubbard_u?: number | null;
}

export interface Site {
  species: string;
  xyz: Vec3;
  fixed?: [boolean, boolean, boolean];
}

export interface Structure {
  name?: string;
  cell: [Vec3, Vec3, Vec3];
  pbc: [boolean, boolean, boolean];
  sites: Site[];
  species: Record<string, SpeciesInfo>;
  _spacegroup?: string | null;
}

export interface StructureRecord {
  id: string;
  name: string;
  formula: string;
  natoms: number;
  source: string;
  spacegroup?: string | null;
  structure?: Structure;
  created_at: string;
  updated_at: string;
}

export interface SymmetryInfo {
  number: number;
  international: string;
  hall: string;
  pointgroup: string;
  wyckoffs: string[];
  equivalent_atoms: number[];
  n_operations: number;
  crystal_system: string;
  symprec: number;
}

export interface StructureAnalysis {
  formula: string;
  reduced_formula: string;
  natoms: number;
  lattice: { a: number; b: number; c: number; alpha: number; beta: number; gamma: number; volume: number };
  density: number | null;
  species: string[];
  min_distance: number | null;
  symmetry?: SymmetryInfo | null;
}

export interface KPath {
  path: string;
  special_points: Record<string, Vec3>;
  lines: string[];
  labels: string[];
  segments: string[][];
  card: string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number | null;
  namelist: string | null;
  key: string | null;
}

export interface ValidationResult {
  program: string;
  issues: ValidationIssue[];
  ok: boolean;
}

export interface SchemaVar {
  name: string;
  type: 'real' | 'integer' | 'logical' | 'character';
  label: string;
  default: string | null;
  required: boolean;
  status: string | null;
  options: string[] | null;
  dimension: boolean;
  description: string;
}

export interface ProgramSchema {
  namelists: Record<string, SchemaVar[]>;
}

export interface QECard {
  name: string;
  option: string | null;
  lines: string[];
}

export interface QEDoc {
  program: string;
  preamble: string[];
  namelists: Record<string, Record<string, unknown>>;
  cards: QECard[];
  trailing: string[];
}

export interface StepSpec {
  label: string;
  program: string;
  input_name: string;
  input: string;
  output_name: string;
  cwd: string;
  np: number | null;
  args: string;
  save_xml?: string | null;
  validation?: ValidationResult | null;
}

export interface WorkflowSpec {
  kind: string;
  name: string;
  steps: StepSpec[];
  workflow: Record<string, unknown>;
}

export type JobStatus = 'created' | 'submitting' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'lost';

export interface Job {
  id: string;
  name: string;
  connection_id: string;
  connection_name: string | null;
  status: JobStatus;
  kind: string;
  steps: StepSpec[];
  resources: Record<string, unknown>;
  workflow: Record<string, unknown>;
  remote_dir: string;
  scheduler: string;
  remote_job_id: string;
  current_step: number;
  exit_code: number | null;
  error: string;
  summary: Record<string, any>;
  structure_id: string | null;
  fetched: boolean;
  created_at: string;
  submitted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ConnectionConfig {
  work_root: string;
  qe_bin_dir: string;
  env_setup: string;
  mpi_command: string;
  mpi_command_batch: string;
  default_np: number;
  default_nthreads: number;
  scheduler: 'direct' | 'slurm' | 'pbs';
  scheduler_defaults: Record<string, unknown>;
  login_shell: boolean | null;
  host: string;
  port: number;
  username: string;
  auth: 'key' | 'password' | 'agent';
  key_path: string;
  jump_host: string;
  host_key_policy: 'tofu' | 'strict' | 'ignore';
  kernel_name: string;
  detected: Record<string, any>;
}

export interface Connection {
  id: string;
  name: string;
  kind: 'local' | 'ssh' | 'jupyter';
  config: ConnectionConfig;
  has_password: boolean;
  has_passphrase: boolean;
  has_jupyter_url: boolean;
  jupyter_host: string | null;
  created_at: string;
  updated_at: string;
}

export interface PseudoInfo {
  filename: string;
  size: number;
  md5: string;
  element: string | null;
  type: string | null;
  functional: string | null;
  relativistic: string | null;
  has_so?: boolean;
  nlcc?: boolean;
  z_valence: number | null;
  suggested_ecutwfc: number | null;
  suggested_ecutrho: number | null;
  recommended_ecutwfc: number | null;
  recommended_ecutrho: number | null;
  family: string | null;
  error: string | null;
  is_default: boolean;
}

export interface PseudoFamily {
  id: string;
  title: string;
  archive: string;
  json: string;
  license: string;
  reference: string;
}

export interface AppSettings {
  ai_enabled: boolean;
  ai_model: string;
  ai_max_tokens: number;
  ai_send_outputs: boolean;
  energy_unit: 'eV' | 'Ry' | 'Ha';
  default_connection_id: string | null;
  poll_interval_s: number;
  max_download_mb: number;
  theme: 'auto' | 'light' | 'dark';
  ai_hard_disabled: boolean;
  ai_available: boolean;
  has_anthropic_key: boolean;
  has_mp_key: boolean;
}

export interface Meta {
  version: string;
  python: string;
  platform: string;
  home: string;
  ai: { available: boolean; enabled: boolean; hard_disabled: boolean; configured: boolean; model: string };
}

export interface TaskInfo {
  id: string;
  title: string;
  status: 'running' | 'done' | 'failed';
  log: string[];
  log_offset: number;
  result: any;
  error: string | null;
  progress: number | null;
  created: number;
  finished: number | null;
}

export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
  is_dir: boolean;
}

export interface AIContextItem {
  kind: 'input' | 'output' | 'structure' | 'analysis' | 'error' | 'text';
  title: string;
  content: string;
}

/* ------------------------------------------------------------------ results */
export interface ScfIteration {
  iter: number;
  energy_ev: number | null;
  accuracy_ry: number | null;
  cpu_s?: number | null;
}

export interface IonicStep {
  step: number;
  energy_ev: number | null;
  n_scf: number;
  converged: boolean | null;
  max_force: number | null;
  total_force: number | null;
  pressure_kbar: number | null;
  magnetization: number | number[] | null;
  iterations: ScfIteration[];
}

export interface GapInfo {
  gap_ev: number;
  metal: boolean;
  vbm_ev: number | null;
  cbm_ev: number | null;
  direct: boolean | null;
  direct_gap_ev?: number;
  k_vbm?: number[];
  k_cbm?: number[];
}

export interface TrajectoryFrame {
  structure: Structure;
  energy_ev: number | null;
  max_force_ev_a: number | null;
  volume: number;
}

export interface PwResult {
  summary: Record<string, any>;
  scf: IonicStep[];
  forces_ry_bohr?: number[][];
  stress_kbar?: number[][] | null;
  xml?: Record<string, any>;
  gap?: GapInfo | null;
  trajectory?: TrajectoryFrame[];
}

export interface PathTick {
  x: number;
  label: string;
  index: number;
}

export interface BandsResult {
  x: number[];
  ticks: PathTick[];
  breaks?: number[];
  bands: number[][][]; // [spin][k][band]
  reference_ev: number | null;
  reference_kind: 'fermi' | 'vbm';
  gap?: GapInfo | null;
  lsda?: boolean;
  source: string;
}

export interface DosCurve {
  dos?: (number | null)[];
  up?: (number | null)[];
  down?: (number | null)[];
}

export interface DosResult {
  dos?: {
    fermi_energy_ev: number | null;
    energy_ev: number[];
    spin: boolean;
    dos?: (number | null)[];
    dos_up?: (number | null)[];
    dos_down?: (number | null)[];
    int_dos?: (number | null)[] | null;
    has_nan: boolean;
  };
  pdos?: {
    energy_ev: number[] | null;
    total: DosCurve | null;
    by_element: Record<string, DosCurve>;
    by_orbital: Record<string, DosCurve>;
    by_atom: Record<string, DosCurve>;
    spin: boolean;
  };
  fermi_energy_ev: number | null;
}

export interface PhononResult {
  dispersion?: { x: number[]; ticks: PathTick[]; breaks: number[]; freq_cm1: number[][]; min_freq_cm1: number };
  dos?: {
    freq_cm1: number[];
    dos: (number | null)[];
    pdos: (number | null)[][];
    has_nan: boolean;
    /** integral of the DOS and the expected 3·nat (when the q-grid file was available) */
    integral?: number;
    expected_integral?: number;
    /** 'matdyn' (matdyn.x fldos) or 'qestudio' (Gaussian DOS recomputed from matdyn's grid) */
    source?: 'matdyn' | 'qestudio';
    note?: string;
  };
  imaginary_modes?: boolean;
  ph?: Record<string, any>;
}

export interface ConvergenceRow {
  label: string;
  value: unknown;
  energy_ev: number | null;
  energy_per_atom_ev: number | null;
  pressure_kbar: number | null;
  max_force: number | null;
  wall_s: number | null;
  status: string;
  delta_mev_per_atom: number | null;
  delta_p_kbar: number | null;
}

export interface ConvergenceResult {
  parameter: string;
  rows: ConvergenceRow[];
  recommended: { label: string; value: unknown; threshold_mev_per_atom: number; note: string } | null;
}

export interface EosResult {
  points: { volume: number; energy_ev: number | null }[];
  fit: null | {
    eos: string;
    v0: number;
    e0_ev: number;
    B0_GPa: number;
    B0_prime: number | null;
    v0_per_atom: number;
    a0_cubic_equiv: number;
    curve: { volume: number[]; energy_ev: number[] | null };
    warning?: string;
  };
  fit_error?: string;
}

export interface DensityResult {
  file: string;
  shape: number[];
  stats: { min: number; max: number; mean: number; integral: number };
  levels: number[];
  atoms: { z: number; xyz: Vec3 }[];
  cell: number[][];
  stride: number;
  plot_num?: number;
}

export interface StepSummary {
  label: string;
  program: string;
  output: string;
  exists: boolean;
  status?: string;
  errors?: string[];
  warnings?: string[];
  wall_time_s?: number | null;
  [k: string]: any;
}

export interface JobResults {
  kind: string;
  steps: StepSummary[];
  pw?: PwResult;
  bands?: BandsResult;
  dos?: DosResult;
  phonon?: PhononResult;
  convergence?: ConvergenceResult;
  eos?: EosResult;
  density?: DensityResult;
  error?: string;
}

export interface Isosurface {
  vertices: number[];
  faces: number[];
  normals: number[];
  level: number;
}
