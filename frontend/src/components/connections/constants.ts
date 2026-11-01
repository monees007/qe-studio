// Shared constants and types for the connection components.
import { IconBrandPython, IconDeviceDesktop, IconServer } from '@tabler/icons-react';
import type { ConnectionConfig } from '../../api/types';

export const KIND_ICON = { local: IconDeviceDesktop, ssh: IconServer, jupyter: IconBrandPython } as const;
export const QE_VERSIONS = ['7.6', '7.5', '7.4', '7.2'];

export interface TestResult {
  ok: boolean;
  error?: string;
  info?: Record<string, any>;
  log?: string[];
}

export const EMPTY_CFG: Partial<ConnectionConfig> = {
  work_root: '',
  qe_bin_dir: '',
  env_setup: '',
  mpi_command: 'mpirun -np {np}',
  mpi_command_batch: '',
  default_np: 1,
  default_nthreads: 1,
  scheduler: 'direct',
  scheduler_defaults: {},
  login_shell: null,
  host: '',
  port: 22,
  username: '',
  auth: 'key',
  key_path: '~/.ssh/id_ed25519',
  jump_host: '',
  host_key_policy: 'tofu',
  kernel_name: 'python3',
};
