// Quantum ESPRESSO detection and installation (conda-forge, own binaries, apt) for one connection.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Code, Group, Select, Stack, Table, Tabs, Text } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconCheck, IconCloudDownload, IconPackage, IconTerminal2, IconUpload, IconX } from '@tabler/icons-react';
import { apiPost, apiUpload } from '../../api/client';
import { notifyError, notifyOk } from '../../api/hooks';
import type { Connection, Job } from '../../api/types';
import { TaskProgress } from '../common';
import { QE_VERSIONS } from './constants';

export function QESetup({ conn, onChanged }: { conn: Connection; onChanged: () => void }) {
  const navigate = useNavigate();
  const [version, setVersion] = useState<string | null>('7.6');
  const [mpi, setMpi] = useState<string>('openmpi');
  const [installing, setInstalling] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const det = conn.config.detected ?? {};
  const progs: Record<string, string | null> = det.programs ?? {};

  const install = async (method: 'conda' | 'apt') => {
    setInstalling(true);
    try {
      const job = await apiPost<Job>(`/api/connections/${conn.id}/qe/install`, {
        method,
        version: method === 'conda' ? version : undefined,
        mpi,
      });
      notifyOk('Installation started — follow its log on the job page');
      navigate(`/jobs/${job.id}`);
    } catch (e) {
      notifyError(e, 'Install failed to start');
    } finally {
      setInstalling(false);
    }
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    const fd = new FormData();
    fd.append('file', files[0]);
    setUploadPct(0);
    try {
      const r = await apiUpload<{ task_id: string }>(`/api/connections/${conn.id}/qe/archive`, fd, (f) =>
        setUploadPct(f),
      );
      setTaskId(r.task_id);
    } catch (e) {
      notifyError(e, 'Upload failed');
    } finally {
      setUploadPct(null);
    }
  };

  return (
    <Stack gap="sm">
      <Group gap="xs">
        {det.qe_found ? (
          <Badge color="teal" leftSection={<IconCheck size={12} />}>
            QE {det.qe_version ?? 'found'}
          </Badge>
        ) : det.programs ? (
          <Badge color="red" leftSection={<IconX size={12} />}>
            pw.x not found
          </Badge>
        ) : (
          <Badge color="gray">not tested yet</Badge>
        )}
        {det.nproc && <Badge variant="outline">{det.nproc} cores</Badge>}
        {det.mem && <Badge variant="outline">{(det.mem / 1024).toFixed(1)} GB RAM</Badge>}
        {det.uname && (
          <Badge variant="outline" color="gray">
            {det.uname}
          </Badge>
        )}
      </Group>
      {det.missing_libs?.length > 0 && (
        <Alert color="orange" title="Missing shared libraries">
          <Text size="sm" className="qes-mono">
            {det.missing_libs.join('\n')}
          </Text>
          <Text size="sm" mt={4}>
            Load the matching modules in “Environment setup”, or use the conda-forge installer which ships all runtime
            libraries.
          </Text>
        </Alert>
      )}
      {det.programs && (
        <Table withTableBorder fz="xs" verticalSpacing={2}>
          <Table.Tbody>
            {Object.entries(progs).map(([p, path]) => (
              <Table.Tr key={p}>
                <Table.Td w={110}>
                  <Code>{p}</Code>
                </Table.Td>
                <Table.Td className="qes-mono">
                  {path ?? (
                    <Text span c="dimmed" size="xs">
                      not found
                    </Text>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
            <Table.Tr>
              <Table.Td>MPI</Table.Td>
              <Table.Td className="qes-mono">
                {[det.mpi?.mpirun, det.mpi?.mpiexec, det.mpi?.srun].filter(Boolean).join(' · ') || '—'}
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>Schedulers</Table.Td>
              <Table.Td className="qes-mono">
                {[det.schedulers?.sbatch, det.schedulers?.qsub].filter(Boolean).join(' · ') || '—'}
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      )}
      <Tabs defaultValue="conda" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="conda" leftSection={<IconCloudDownload size={14} />}>
            Install (conda-forge)
          </Tabs.Tab>
          <Tabs.Tab value="archive" leftSection={<IconPackage size={14} />}>
            Bring your own binaries
          </Tabs.Tab>
          <Tabs.Tab value="apt" leftSection={<IconTerminal2 size={14} />}>
            System package
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="conda" pt="sm">
          <Stack gap="xs">
            <Text size="sm">
              Downloads <b>micromamba</b> and installs precompiled Quantum ESPRESSO from conda-forge (Linux
              x86-64/aarch64/ppc64le, macOS) into
              <Code>{(conn.config.work_root || '~') + '/qe-tools'}</Code>. No root needed; requires internet on the
              target.
            </Text>
            <Group align="flex-end">
              <Select
                label="QE version"
                data={QE_VERSIONS}
                value={version}
                onChange={setVersion}
                w={130}
                clearable
                placeholder="latest"
              />
              <Select
                label="MPI"
                data={[
                  { value: 'openmpi', label: 'Open MPI' },
                  { value: 'mpich', label: 'MPICH (QE ≥ 7.6)' },
                ]}
                value={mpi}
                onChange={(v) => v && setMpi(v)}
                w={170}
                allowDeselect={false}
              />
              <Button
                leftSection={<IconCloudDownload size={16} />}
                onClick={() => install('conda')}
                loading={installing}
                disabled={conn.kind === 'local' && navigator.userAgent.includes('Windows')}
              >
                Install
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              conda-forge QE builds are all MPI-enabled; for serial runs use 1 process. On HPC clusters prefer the
              site-provided, optimised build (add its <Code>module load</Code> line to Environment setup).
            </Text>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="archive" pt="sm">
          <Stack gap="xs">
            <Text size="sm">
              Upload precompiled QE as <Code>.tar.gz</Code>, <Code>.tar.xz</Code>, <Code>.zip</Code>, a conda{' '}
              <Code>.conda</Code>/<Code>.tar.bz2</Code> package or a <Code>.deb</Code>. QE Studio extracts it, finds the
              folder with <Code>pw.x</Code> (or <Code>pw.exe</Code> on Windows), installs it on this connection and sets
              the bin directory. The binaries must match the target's OS/CPU and need their runtime libraries (MPI,
              BLAS/LAPACK, FFTW, gfortran).
            </Text>
            <Dropzone onDrop={upload} maxFiles={1} multiple={false} maxSize={2 * 1024 ** 3}>
              <Group justify="center" mih={70} style={{ pointerEvents: 'none' }}>
                <IconUpload size={26} />
                <Text size="sm">Drop an archive here or click to choose</Text>
              </Group>
            </Dropzone>
            {uploadPct !== null && <Text size="sm">Uploading… {(uploadPct * 100).toFixed(0)}%</Text>}
            <TaskProgress
              taskId={taskId}
              onDone={(ok) => {
                onChanged();
                if (ok) notifyOk('Binaries installed');
              }}
            />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="apt" pt="sm">
          <Stack gap="xs">
            <Text size="sm">
              Debian/Ubuntu targets with root or password-less sudo (e.g. Kaggle): installs the distribution package{' '}
              <Code>quantum-espresso</Code> (often an older QE version).
            </Text>
            <Group>
              <Button variant="light" onClick={() => install('apt')} loading={installing}>
                apt-get install quantum-espresso
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
