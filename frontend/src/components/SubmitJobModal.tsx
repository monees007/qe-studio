// Submit a job (one or more steps) to a compute connection.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Group,
  Loader,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconAlertTriangle, IconRocket } from '@tabler/icons-react';
import { apiPost, errMsg } from '../api/client';
import { notifyOk, qk, useConnections, useSettings } from '../api/hooks';
import type { Connection, Job, StepSpec, ValidationResult } from '../api/types';

export interface SubmitSpec {
  name: string;
  kind?: string;
  steps: StepSpec[];
  workflow?: Record<string, unknown>;
  structure_id?: string | null;
}

const EXE_PROGRAM: Record<string, string> = {
  'pw.x': 'pw',
  'ph.x': 'ph',
  'pp.x': 'pp',
  'dos.x': 'dos',
  'projwfc.x': 'projwfc',
  'bands.x': 'bands',
  'q2r.x': 'q2r',
  'matdyn.x': 'matdyn',
  'hp.x': 'hp',
};

type Scheduler = 'direct' | 'slurm' | 'pbs';

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

export function SubmitJobModal({
  opened,
  onClose,
  spec,
}: {
  opened: boolean;
  onClose: () => void;
  spec: SubmitSpec | null;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: conns, isLoading: connLoading } = useConnections();
  const { data: settings } = useSettings();
  const [connId, setConnId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [np, setNp] = useState<number | string>(1);
  const [nthreads, setNthreads] = useState<number | string>(1);
  const [npool, setNpool] = useState<number | string>('');
  const [scheduler, setScheduler] = useState<Scheduler>('direct');
  const [sched, setSched] = useState<Record<string, string>>({});
  const [mpiOverride, setMpiOverride] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validations, setValidations] = useState<(ValidationResult | null)[]>([]);
  const [validating, setValidating] = useState(false);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const conn: Connection | undefined = conns?.find((c) => c.id === connId);

  // initialise on open
  useEffect(() => {
    if (!opened || !spec) return;
    setName(spec.name);
    setError(null);
    setForce(false);
    setBusy(false);
  }, [opened, spec]);

  useEffect(() => {
    if (!opened || !conns?.length) return;
    if (!connId || !conns.some((c) => c.id === connId)) {
      const def = settings?.default_connection_id && conns.find((c) => c.id === settings.default_connection_id);
      setConnId((def || conns[0]).id);
    }
  }, [opened, conns, settings, connId]);

  useEffect(() => {
    if (!conn) return;
    setNp(conn.config.default_np || 1);
    setNthreads(conn.config.default_nthreads || 1);
    setScheduler(conn.config.scheduler);
    const d = conn.config.scheduler_defaults ?? {};
    setSched({
      partition: str(d.partition),
      walltime: str(d.walltime || '02:00:00'),
      account: str(d.account),
      qos: str(d.qos),
      nodes: str(d.nodes),
      memory: str(d.memory),
      extra_directives: str(d.extra_directives),
    });
    setMpiOverride('');
  }, [conn]);

  // validate steps that do not carry a validation result yet
  useEffect(() => {
    if (!opened || !spec) return;
    let alive = true;
    setValidating(true);
    Promise.all(
      spec.steps.map(async (s) => {
        if (s.validation) return s.validation;
        const program = EXE_PROGRAM[s.program];
        if (!program) return null;
        try {
          return await apiPost<ValidationResult>('/api/qe/validate', { text: s.input, program });
        } catch {
          return null;
        }
      }),
    ).then((v) => {
      if (alive) {
        setValidations(v);
        setValidating(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [opened, spec]);

  const nErrors = validations.reduce((a, v) => a + (v?.issues.filter((i) => i.severity === 'error').length ?? 0), 0);
  const nWarnings = validations.reduce(
    (a, v) => a + (v?.issues.filter((i) => i.severity === 'warning').length ?? 0),
    0,
  );
  const det = conn?.config.detected ?? {};
  const nproc: number | undefined = det.nproc ?? undefined;
  const onlyPost = spec ? spec.steps.length === 1 && !['pw.x', 'shell'].includes(spec.steps[0].program) : false;
  const missingPrograms = useMemo(() => {
    if (!spec || !det.programs) return [];
    return [...new Set(spec.steps.map((s) => s.program))].filter((p) => p !== 'shell' && det.programs[p] === null);
  }, [spec, det.programs]);

  const submit = async () => {
    if (!spec || !conn) return;
    setBusy(true);
    setError(null);
    const resources: Record<string, unknown> = {
      np: Number(np) || 1,
      nthreads: Number(nthreads) || 1,
    };
    if (Number(npool) > 1) resources.npool = Number(npool);
    if (mpiOverride.trim()) resources.mpi_command = mpiOverride.trim();
    if (scheduler !== 'direct') {
      for (const [k, v] of Object.entries(sched)) {
        if (v.trim()) resources[k] = k === 'nodes' ? Number(v) || v : v.trim();
      }
    }
    const steps = spec.steps.map(({ validation: _v, ...s }) => ({
      ...s,
      output_name: s.output_name || s.input_name.replace(/\.[^.]+$/, '') + '.out',
      cwd: s.cwd || '.',
    }));
    try {
      const job = await apiPost<Job>('/api/jobs', {
        name: name.trim() || spec.name,
        connection_id: conn.id,
        steps,
        kind: spec.kind,
        scheduler,
        resources,
        workflow: spec.workflow ?? {},
        structure_id: spec.structure_id ?? null,
      });
      qc.invalidateQueries({ queryKey: qk.jobs });
      notifyOk(`Job “${job.name}” submitted to ${conn.name}`, 'Submitted');
      onClose();
      navigate(`/jobs/${job.id}`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const blocked = nErrors > 0 && !force;

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={600}>Submit job</Text>} size="lg">
      {!spec ? null : (
        <Stack gap="sm">
          <TextInput label="Job name" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
          <Select
            label="Run on"
            data={(conns ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` }))}
            value={connId}
            onChange={setConnId}
            allowDeselect={false}
            rightSection={connLoading ? <Loader size="xs" /> : undefined}
          />
          {conn && (
            <Group gap={6}>
              <Badge variant="outline">{conn.kind}</Badge>
              {det.qe_version ? <Badge color="teal">QE {det.qe_version}</Badge> : null}
              {nproc ? <Badge color="gray">{nproc} cores</Badge> : null}
              {det.host ? (
                <Badge color="gray" variant="outline">
                  {det.host}
                </Badge>
              ) : null}
              {conn.config.qe_bin_dir ? (
                <Text size="xs" c="dimmed" ff="monospace">
                  {conn.config.qe_bin_dir}
                </Text>
              ) : null}
            </Group>
          )}
          {conn && !det.programs && (
            <Alert color="yellow" p="xs" icon={<IconAlertTriangle size={16} />}>
              This connection has not been tested yet.{' '}
              <Link to="/connections" onClick={onClose}>
                Test it
              </Link>{' '}
              to detect QE.
            </Alert>
          )}
          {conn && det.programs && det.qe_found === false && (
            <Alert color="red" p="xs" icon={<IconAlertTriangle size={16} />}>
              pw.x was not found on this connection. Install QE or set the binary directory on the{' '}
              <Link to="/connections" onClick={onClose}>
                Connections page
              </Link>
              .
            </Alert>
          )}
          {missingPrograms.length > 0 && det.qe_found !== false && (
            <Alert color="orange" p="xs">
              Not found on this connection: {missingPrograms.join(', ')}
            </Alert>
          )}
          {onlyPost && (
            <Alert color="blue" p="xs">
              {spec.steps[0].program} reads the data written by a previous pw.x run (outdir/prefix). A job runs in a
              fresh directory, so run post-processing as part of a workflow (Workflows page) or together with its SCF
              step.
            </Alert>
          )}

          <SegmentedControl
            fullWidth
            value={scheduler}
            onChange={(v) => setScheduler(v as Scheduler)}
            data={[
              { value: 'direct', label: 'Run directly' },
              { value: 'slurm', label: 'SLURM' },
              { value: 'pbs', label: 'PBS/Torque' },
            ]}
          />
          <SimpleGrid cols={3}>
            <NumberInput
              label="MPI processes"
              min={1}
              value={np}
              onChange={setNp}
              allowDecimal={false}
              error={scheduler === 'direct' && nproc && Number(np) > nproc ? `> ${nproc} cores` : undefined}
            />
            <NumberInput label="OpenMP threads" min={1} value={nthreads} onChange={setNthreads} allowDecimal={false} />
            <NumberInput
              label="k-point pools (-nk)"
              min={1}
              value={npool}
              onChange={setNpool}
              allowDecimal={false}
              placeholder="auto"
              description={
                Number(npool) > 1 && Number(np) % Number(npool) !== 0 ? 'should divide MPI processes' : undefined
              }
            />
          </SimpleGrid>
          {scheduler !== 'direct' && (
            <SimpleGrid cols={3}>
              <TextInput
                label={scheduler === 'slurm' ? 'Partition' : 'Queue'}
                value={sched.partition ?? ''}
                onChange={(e) => setSched({ ...sched, partition: e.currentTarget.value })}
              />
              <TextInput
                label="Walltime"
                placeholder="HH:MM:SS"
                value={sched.walltime ?? ''}
                onChange={(e) => setSched({ ...sched, walltime: e.currentTarget.value })}
              />
              <TextInput
                label="Account"
                value={sched.account ?? ''}
                onChange={(e) => setSched({ ...sched, account: e.currentTarget.value })}
              />
              <TextInput
                label="Nodes"
                value={sched.nodes ?? ''}
                onChange={(e) => setSched({ ...sched, nodes: e.currentTarget.value })}
              />
              <TextInput
                label="Memory"
                placeholder="e.g. 16G"
                value={sched.memory ?? ''}
                onChange={(e) => setSched({ ...sched, memory: e.currentTarget.value })}
              />
              {scheduler === 'slurm' && (
                <TextInput
                  label="QOS"
                  value={sched.qos ?? ''}
                  onChange={(e) => setSched({ ...sched, qos: e.currentTarget.value })}
                />
              )}
            </SimpleGrid>
          )}
          <Button variant="subtle" size="compact-xs" onClick={() => setShowAdvanced((x) => !x)} w="fit-content">
            {showAdvanced ? 'Hide' : 'Show'} advanced options
          </Button>
          <Collapse in={showAdvanced}>
            <Stack gap="xs">
              <TextInput
                label="MPI launcher override"
                placeholder={conn?.config.mpi_command || 'mpirun -np {np}'}
                description="{np} and {nthreads} are substituted. Leave empty to use the connection default."
                value={mpiOverride}
                onChange={(e) => setMpiOverride(e.currentTarget.value)}
                classNames={{ input: 'qes-mono' }}
              />
              {scheduler !== 'direct' && (
                <Textarea
                  label="Extra scheduler directives"
                  placeholder={scheduler === 'slurm' ? '#SBATCH --constraint=cpu' : '#PBS -l feature=xyz'}
                  autosize
                  minRows={2}
                  value={sched.extra_directives ?? ''}
                  classNames={{ input: 'qes-mono' }}
                  onChange={(e) => setSched({ ...sched, extra_directives: e.currentTarget.value })}
                />
              )}
            </Stack>
          </Collapse>

          <Accordion variant="contained" chevronPosition="left">
            <Accordion.Item value="steps">
              <Accordion.Control>
                <Group gap="xs">
                  <Text size="sm">
                    {spec.steps.length} step{spec.steps.length > 1 ? 's' : ''}
                  </Text>
                  {validating ? (
                    <Loader size="xs" />
                  ) : (
                    <>
                      {nErrors > 0 && (
                        <Badge color="red">
                          {nErrors} error{nErrors > 1 ? 's' : ''}
                        </Badge>
                      )}
                      {nWarnings > 0 && (
                        <Badge color="yellow">
                          {nWarnings} warning{nWarnings > 1 ? 's' : ''}
                        </Badge>
                      )}
                      {nErrors === 0 && nWarnings === 0 && <Badge color="teal">inputs valid</Badge>}
                    </>
                  )}
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack gap={4}>
                  {spec.steps.map((s, i) => {
                    const v = validations[i];
                    return (
                      <div key={i}>
                        <Group gap={6}>
                          <Text size="sm" fw={500}>
                            {i + 1}. {s.label || s.program}
                          </Text>
                          <Badge size="xs" variant="outline" ff="monospace">
                            {s.program}
                          </Badge>
                          <Text size="xs" c="dimmed" ff="monospace">
                            {s.cwd && s.cwd !== '.' ? `${s.cwd}/` : ''}
                            {s.input_name}
                          </Text>
                        </Group>
                        {v?.issues
                          .filter((x) => x.severity !== 'info')
                          .slice(0, 6)
                          .map((x, j) => (
                            <Text key={j} size="xs" c={x.severity === 'error' ? 'red' : 'yellow.8'} ml="md">
                              {x.line ? `line ${x.line}: ` : ''}
                              {x.message}
                            </Text>
                          ))}
                      </div>
                    );
                  })}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          {nErrors > 0 && (
            <Checkbox
              color="red"
              label="Submit anyway (QE will probably stop with an error)"
              checked={force}
              onChange={(e) => setForce(e.currentTarget.checked)}
            />
          )}
          {error && (
            <Alert color="red" title="Submission failed">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              leftSection={<IconRocket size={16} />}
              onClick={submit}
              loading={busy}
              disabled={!conn || blocked || validating}
            >
              Submit
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
