// Create / edit form for local, SSH and Kaggle/Jupyter connections.
import { useState } from 'react';
import {
  Alert,
  Button,
  Code,
  Divider,
  Group,
  List,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost, apiPut, errMsg } from '../../api/client';
import { notifyOk, qk } from '../../api/hooks';
import type { Connection, ConnectionConfig } from '../../api/types';
import { EMPTY_CFG } from './constants';

export function ConnectionForm({
  initial,
  kind,
  onDone,
}: {
  initial?: Connection;
  kind: Connection['kind'];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(
    initial?.name ?? (kind === 'jupyter' ? 'Kaggle' : kind === 'ssh' ? 'Cluster' : 'This computer'),
  );
  const [cfg, setCfg] = useState<Partial<ConnectionConfig>>({
    ...EMPTY_CFG,
    ...(kind === 'jupyter' ? { work_root: '/kaggle/working/qe-studio-runs', mpi_command: 'mpirun -np {np}' } : {}),
    ...(initial?.config ?? {}),
  });
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const up = (p: Partial<ConnectionConfig>) => setCfg((c) => ({ ...c, ...p }));
  const sd = (cfg.scheduler_defaults ?? {}) as Record<string, any>;
  const upSd = (k: string, v: unknown) => up({ scheduler_defaults: { ...sd, [k]: v } });

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const body = {
      name,
      kind,
      config: cfg,
      password: password || undefined,
      passphrase: passphrase || undefined,
      jupyter_url: url || undefined,
    };
    try {
      if (initial) await apiPut(`/api/connections/${initial.id}`, body);
      else await apiPost('/api/connections', body);
      qc.invalidateQueries({ queryKey: qk.connections });
      notifyOk(`Connection “${name}” saved`);
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="sm">
      <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
      {kind === 'ssh' && (
        <>
          <Group grow align="flex-start">
            <TextInput
              label="Host"
              placeholder="login.cluster.edu"
              value={cfg.host}
              onChange={(e) => up({ host: e.currentTarget.value })}
              required
            />
            <NumberInput
              label="Port"
              value={cfg.port}
              min={1}
              max={65535}
              onChange={(v) => up({ port: Number(v) || 22 })}
              maw={110}
            />
            <TextInput
              label="Username"
              value={cfg.username}
              onChange={(e) => up({ username: e.currentTarget.value })}
            />
          </Group>
          <SegmentedControl
            value={cfg.auth}
            onChange={(v) => up({ auth: v as ConnectionConfig['auth'] })}
            data={[
              { value: 'key', label: 'Private key' },
              { value: 'agent', label: 'SSH agent' },
              { value: 'password', label: 'Password' },
            ]}
          />
          {cfg.auth === 'key' && (
            <Group grow>
              <TextInput
                label="Private key path (on this computer)"
                value={cfg.key_path}
                onChange={(e) => up({ key_path: e.currentTarget.value })}
              />
              <PasswordInput
                label="Key passphrase"
                placeholder={initial?.has_passphrase ? '(stored)' : 'optional'}
                value={passphrase}
                onChange={(e) => setPassphrase(e.currentTarget.value)}
              />
            </Group>
          )}
          {cfg.auth === 'password' && (
            <PasswordInput
              label="Password"
              placeholder={initial?.has_password ? '(stored — leave empty to keep)' : ''}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          )}
          <Group grow>
            <TextInput
              label="Jump host (optional)"
              placeholder="user@gateway:22"
              value={cfg.jump_host}
              onChange={(e) => up({ jump_host: e.currentTarget.value })}
            />
            <Select
              label="Host key policy"
              value={cfg.host_key_policy}
              allowDeselect={false}
              onChange={(v) => v && up({ host_key_policy: v as ConnectionConfig['host_key_policy'] })}
              data={[
                { value: 'tofu', label: 'Trust on first use (recommended)' },
                { value: 'strict', label: 'Strict (known_hosts only)' },
                { value: 'ignore', label: 'Do not check (insecure)' },
              ]}
            />
          </Group>
        </>
      )}
      {kind === 'jupyter' && (
        <>
          <Alert color="blue" title="Kaggle: get the VS Code URL">
            <List size="sm" spacing={2}>
              <List.Item>
                Open your notebook on kaggle.com and turn <b>Internet</b> on (Settings panel) if you want to install QE
                there.
              </List.Item>
              <List.Item>
                Menu <b>Run ▸ Kaggle Jupyter Server</b>, copy the <b>VS Code Compatible URL</b> (it contains the access
                token).
              </List.Item>
              <List.Item>
                Paste it below. Any JupyterLab / JupyterHub URL with <Code>?token=…</Code> works too.
              </List.Item>
              <List.Item>
                Kaggle sessions are ephemeral: results are downloaded automatically when jobs finish, but files left on
                Kaggle disappear when the session stops.
              </List.Item>
            </List>
          </Alert>
          <PasswordInput
            label="Jupyter / Kaggle URL"
            placeholder={
              initial?.has_jupyter_url
                ? `(stored for ${initial.jupyter_host}) — paste a new one to replace`
                : 'https://kkb-production.jupyter-proxy.kaggle.net/k/…/proxy'
            }
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            required={!initial}
          />
        </>
      )}
      <Divider label="Quantum ESPRESSO & resources" labelPosition="left" />
      <Group grow>
        <TextInput
          label="Work directory"
          description="Job folders are created here"
          placeholder={kind === 'local' ? 'default: QE Studio data dir' : '~/qe-studio-runs'}
          value={cfg.work_root}
          onChange={(e) => up({ work_root: e.currentTarget.value })}
        />
        <TextInput
          label="QE bin directory"
          description="Folder with pw.x (empty = use PATH)"
          value={cfg.qe_bin_dir}
          onChange={(e) => up({ qe_bin_dir: e.currentTarget.value })}
        />
      </Group>
      <Textarea
        label="Environment setup"
        description="Shell lines run before every job, e.g. module load quantum-espresso/7.3"
        autosize
        minRows={2}
        className="qes-mono"
        value={cfg.env_setup}
        onChange={(e) => up({ env_setup: e.currentTarget.value })}
      />
      <Group grow>
        <TextInput
          label="MPI launcher"
          description="{np} = processes; empty = serial"
          value={cfg.mpi_command}
          onChange={(e) => up({ mpi_command: e.currentTarget.value })}
        />
        <NumberInput
          label="Default MPI processes"
          min={1}
          value={cfg.default_np}
          onChange={(v) => up({ default_np: Number(v) || 1 })}
        />
        <NumberInput
          label="OpenMP threads"
          min={1}
          value={cfg.default_nthreads}
          onChange={(v) => up({ default_nthreads: Number(v) || 1 })}
        />
      </Group>
      {kind !== 'jupyter' && (
        <>
          <Group grow align="flex-end">
            <Select
              label="Scheduler"
              value={cfg.scheduler}
              allowDeselect={false}
              onChange={(v) => v && up({ scheduler: v as ConnectionConfig['scheduler'] })}
              data={[
                { value: 'direct', label: 'None (run directly)' },
                { value: 'slurm', label: 'SLURM (sbatch)' },
                { value: 'pbs', label: 'PBS / Torque (qsub)' },
              ]}
            />
            {kind === 'ssh' && (
              <Switch
                label="Use login shell (bash -l)"
                description="Loads ~/.bash_profile, needed for 'module'"
                checked={cfg.login_shell ?? true}
                onChange={(e) => up({ login_shell: e.currentTarget.checked })}
              />
            )}
          </Group>
          {cfg.scheduler !== 'direct' && (
            <SimpleGrid cols={3}>
              <TextInput
                label="Partition / queue"
                value={sd.partition ?? ''}
                onChange={(e) => upSd('partition', e.currentTarget.value)}
              />
              <TextInput
                label="Account"
                value={sd.account ?? ''}
                onChange={(e) => upSd('account', e.currentTarget.value)}
              />
              <TextInput
                label="Wall time"
                placeholder="02:00:00"
                value={sd.walltime ?? ''}
                onChange={(e) => upSd('walltime', e.currentTarget.value)}
              />
              <TextInput label="QOS" value={sd.qos ?? ''} onChange={(e) => upSd('qos', e.currentTarget.value)} />
              <TextInput
                label="Memory"
                placeholder="16G"
                value={sd.memory ?? ''}
                onChange={(e) => upSd('memory', e.currentTarget.value)}
              />
              <TextInput
                label="Launcher in batch jobs"
                placeholder={cfg.scheduler === 'slurm' ? 'srun' : 'mpirun -np {np}'}
                value={cfg.mpi_command_batch}
                onChange={(e) => up({ mpi_command_batch: e.currentTarget.value })}
              />
            </SimpleGrid>
          )}
        </>
      )}
      {err && <Alert color="red">{err}</Alert>}
      <Group justify="flex-end">
        <Button variant="default" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={submit} loading={busy}>
          {initial ? 'Save' : 'Create'}
        </Button>
      </Group>
    </Stack>
  );
}
