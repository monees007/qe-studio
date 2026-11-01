import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Accordion,
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  CopyButton,
  Group,
  List,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconArrowLeft,
  IconCheck,
  IconCloudDownload,
  IconCopy,
  IconDownload,
  IconEdit,
  IconFileZip,
  IconPlayerStop,
  IconRefresh,
  IconRepeat,
  IconTrash,
} from '@tabler/icons-react';
import { apiDownload, apiGet, apiPost, errMsg, saveText } from '../api/client';
import { notifyError, notifyOk, qk, useAIAvailable, useCancelJob, useJob, useJobResults } from '../api/hooks';
import type { AIContextItem, FileEntry, Job, JobResults, StepSummary } from '../api/types';
import { AskAIButton, StatusBadge } from '../components/common';
import { QEEditor } from '../components/QEEditor';
import { elapsed, fmtDate, fmtDuration } from '../lib/format';
import { useWorkbench } from '../store/app';
import { FilesBrowser } from './results/FilesBrowser';
import { confirmDeleteJobs } from './results/jobActions';
import { JobLog } from './results/JobLog';
import { ResultsPanel } from './results/ResultsPanel';
import { ACTIVE_STATUSES, compactJson, FINAL_STATUSES, PROGRAM_KEY, utcIso } from './results/util';

type StepState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'lost' | 'skipped';
const STEP_COLOR: Record<StepState, string> = {
  pending: 'gray',
  running: 'blue',
  done: 'teal',
  failed: 'red',
  cancelled: 'orange',
  lost: 'grape',
  skipped: 'gray',
};

function stepState(job: Job, i: number): StepState {
  const n = i + 1;
  const cur = job.current_step || 0;
  switch (job.status) {
    case 'done':
      return 'done';
    case 'running':
      return n < cur ? 'done' : n === cur ? 'running' : 'pending';
    case 'failed':
    case 'cancelled':
    case 'lost':
      if (!cur) return n === 1 && job.status !== 'failed' ? (job.status as StepState) : 'skipped';
      return n < cur ? 'done' : n === cur ? (job.status as StepState) : 'skipped';
    default:
      return 'pending';
  }
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <div>{children}</div>
    </div>
  );
}

/** Tail of the most relevant output (failing / running / last step) for AI context. */
function useOutputTail(job: Job | undefined, enabled: boolean) {
  const idx = job ? Math.max(0, Math.min(job.steps.length - 1, (job.current_step || job.steps.length) - 1)) : 0;
  const st = job?.steps[idx];
  const path = st ? (st.cwd && st.cwd !== '.' ? `${st.cwd}/${st.output_name}` : st.output_name) : '';
  const source = job?.fetched ? 'local' : 'remote';
  return useQuery({
    queryKey: ['jobtail', job?.id, path, source, job?.status],
    enabled: enabled && !!job && !!path && (source === 'local' || !!job.remote_dir),
    staleTime: 15_000,
    retry: 0,
    queryFn: async () => {
      let size = 0;
      try {
        const list = await apiGet<{ entries: FileEntry[] }>(`/api/jobs/${job!.id}/files?source=${source}`);
        size = list.entries.find((e) => e.path === path)?.size ?? 0;
      } catch {
        size = 0;
      }
      const offset = Math.max(0, size - 60_000);
      const text = await apiGet<string>(
        `/api/jobs/${job!.id}/file?path=${encodeURIComponent(path)}&source=${source}&offset=${offset}&max_bytes=60000`,
      );
      return { path, text: typeof text === 'string' ? text : '', truncated: offset > 0 };
    },
  });
}

function Overview({ job, results }: { job: Job; results?: JobResults }) {
  const sums: StepSummary[] = results?.steps ?? [];
  const res = job.resources ?? {};
  return (
    <Stack gap="md">
      <Card>
        <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
          <Info label="Connection">
            <Anchor component={Link} to="/connections" size="sm">
              {job.connection_name ?? job.connection_id}
            </Anchor>
          </Info>
          <Info label="Scheduler">
            <Text size="sm">
              {job.scheduler}
              {job.remote_job_id ? ` · ${job.scheduler === 'direct' ? 'pid' : 'id'} ${job.remote_job_id}` : ''}
            </Text>
          </Info>
          <Info label="Resources">
            <Text size="sm">
              {String(res.np ?? 1)} MPI × {String(res.nthreads ?? 1)} OpenMP
              {res.npool ? ` · npool ${String(res.npool)}` : ''}
            </Text>
          </Info>
          <Info label="Kind">
            <Badge variant="outline">{job.kind}</Badge>
          </Info>
          <Info label="Created">
            <Text size="sm">{fmtDate(utcIso(job.created_at))}</Text>
          </Info>
          <Info label="Started">
            <Text size="sm">{fmtDate(utcIso(job.started_at))}</Text>
          </Info>
          <Info label="Finished">
            <Text size="sm">{fmtDate(utcIso(job.finished_at))}</Text>
          </Info>
          <Info label="Elapsed">
            <Text size="sm">
              {job.started_at || job.submitted_at
                ? elapsed(utcIso(job.started_at ?? job.submitted_at), utcIso(job.finished_at))
                : '—'}
            </Text>
          </Info>
        </SimpleGrid>
        {job.remote_dir && (
          <Group gap={4} mt="md" wrap="nowrap">
            <Text size="xs" c="dimmed">
              Remote directory:
            </Text>
            <Text size="xs" className="qes-mono" truncate>
              {job.remote_dir}
            </Text>
            <CopyButton value={job.remote_dir}>
              {({ copied, copy }) => (
                <ActionIcon size="xs" variant="subtle" onClick={copy}>
                  {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                </ActionIcon>
              )}
            </CopyButton>
          </Group>
        )}
      </Card>
      <Card p={0}>
        <Table.ScrollContainer minWidth={760}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={40}>#</Table.Th>
                <Table.Th>Step</Table.Th>
                <Table.Th>Program</Table.Th>
                <Table.Th>Files</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Wall time</Table.Th>
                <Table.Th>Messages</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {job.steps.map((s, i) => {
                const st = stepState(job, i);
                const sm = sums[i];
                const errs = sm?.errors ?? [];
                const warns = sm?.warnings ?? [];
                return (
                  <Table.Tr key={i}>
                    <Table.Td>{i + 1}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{s.label || s.program}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" className="qes-mono">
                        {s.program}
                        {s.np ? ` (np=${s.np})` : ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" className="qes-mono">
                        {s.cwd && s.cwd !== '.' ? `${s.cwd}/` : ''}
                        {s.input_name} → {s.output_name}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={STEP_COLOR[st]} variant={st === 'running' ? 'filled' : 'light'} size="sm">
                        {st}
                      </Badge>
                      {sm?.status && sm.status !== 'done' && st !== 'pending' && st !== 'skipped' && (
                        <Text size="xs" c={sm.status === 'error' ? 'red' : 'yellow'}>
                          output: {sm.status}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{fmtDuration(sm?.wall_time_s ?? null)}</Text>
                    </Table.Td>
                    <Table.Td>
                      {errs.length > 0 && (
                        <Text size="xs" c="red" lineClamp={3}>
                          {errs.join(' | ')}
                        </Text>
                      )}
                      {warns.length > 0 && (
                        <Text size="xs" c="yellow.8" lineClamp={2}>
                          {warns.length} warning(s): {warns[0]}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      {job.summary?.errors?.length > 0 && (
        <Alert color="red" title="QE error messages">
          <List size="sm">
            {job.summary.errors.map((e: string, i: number) => (
              <List.Item key={i}>{e}</List.Item>
            ))}
          </List>
        </Alert>
      )}
    </Stack>
  );
}

function Inputs({ job }: { job: Job }) {
  const setInput = useWorkbench((s) => s.setInput);
  const navigate = useNavigate();
  return (
    <Accordion variant="separated" multiple defaultValue={['0']}>
      {job.steps.map((s, i) => (
        <Accordion.Item key={i} value={String(i)}>
          <Accordion.Control>
            <Group gap="xs">
              <Text size="sm" fw={500}>
                {i + 1}. {s.label || s.program}
              </Text>
              <Text size="xs" c="dimmed" className="qes-mono">
                {s.program} · {s.cwd && s.cwd !== '.' ? `${s.cwd}/` : ''}
                {s.input_name}
              </Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Group gap="xs" mb="xs">
              {s.program !== 'shell' && (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconEdit size={14} />}
                  onClick={() => {
                    setInput(s.input ?? '', PROGRAM_KEY[s.program] ?? 'pw', null, s.input_name);
                    navigate('/editor');
                  }}
                >
                  Open in input editor
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconDownload size={14} />}
                onClick={() => saveText(s.input ?? '', s.input_name)}
              >
                Download
              </Button>
              {s.args && (
                <Text size="xs" c="dimmed" className="qes-mono">
                  extra args: {s.args}
                </Text>
              )}
            </Group>
            {s.input !== undefined ? (
              <QEEditor
                value={s.input}
                readOnly
                program={PROGRAM_KEY[s.program]}
                height={Math.min(520, 40 + 19 * (s.input.split('\n').length + 1))}
              />
            ) : (
              <Loader size="sm" />
            )}
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}

export default function JobDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: job, isLoading, error } = useJob(id);
  const final = job ? FINAL_STATUSES.includes(job.status) : false;
  const active = job ? ACTIVE_STATUSES.includes(job.status) : false;
  const results = useJobResults(id, !!job && (final || job.fetched));
  const cancel = useCancelJob();
  const ai = useAIAvailable();
  const tail = useOutputTail(job, ai);
  const [tab, setTab] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (job && tab === null) setTab(active ? 'log' : job.status === 'done' ? 'results' : 'overview');
  }, [job, tab, active]);

  // refresh results once a running job finishes
  const status = job?.status;
  useEffect(() => {
    if (status && FINAL_STATUSES.includes(status)) qc.invalidateQueries({ queryKey: qk.results(id) });
  }, [status, id, qc]);

  const aiContext = useMemo<AIContextItem[]>(() => {
    if (!job) return [];
    const ctx: AIContextItem[] = job.steps.map((s, i) => ({
      kind: 'input',
      title: `step ${i + 1}: ${s.input_name} (${s.program})`,
      content: s.input ?? '',
    }));
    if (tail.data?.text)
      ctx.push({
        kind: 'output',
        title: `${tail.data.path}${tail.data.truncated ? ' (tail)' : ''}`,
        content: tail.data.text,
      });
    const summary = {
      status: job.status,
      error: job.error,
      exit_code: job.exit_code,
      summary: job.summary,
      kind: job.kind,
      results: results.data
        ? { ...results.data, steps: results.data.steps?.map(({ ionic_steps: _i, ...r }) => r) }
        : undefined,
    };
    ctx.push({ kind: 'analysis', title: 'job status & parsed results', content: compactJson(summary) });
    return ctx;
  }, [job, tail.data, results.data]);

  if (isLoading)
    return (
      <Center h={300}>
        <Loader />
      </Center>
    );
  if (error || !job)
    return (
      <Alert color="red" title="Job not found">
        {error ? errMsg(error) : id}
      </Alert>
    );

  const act = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    try {
      await fn();
      if (ok) notifyOk(ok);
    } catch (e) {
      notifyError(e, `${name} failed`);
    } finally {
      setBusy(null);
    }
  };
  const refreshStatus = () =>
    act('Refresh', async () => {
      const j = await apiPost<Job>(`/api/jobs/${id}/refresh`);
      qc.setQueryData(qk.job(id), (old: Job | undefined) => (old ? { ...old, ...j, steps: old.steps } : old));
    });
  const fetchResults = () =>
    act('Fetch', async () => {
      const r = await apiPost<{ files: string[] }>(`/api/jobs/${id}/fetch`);
      await qc.invalidateQueries({ queryKey: qk.job(id) });
      const fresh = await apiGet<JobResults>(`/api/jobs/${id}/results`);
      qc.setQueryData(qk.results(id), fresh);
      notifyOk(`${r.files.length} file(s) cached locally`);
    });
  const refreshResults = () =>
    act('Re-analyse', async () => {
      const fresh = await apiGet<JobResults>(`/api/jobs/${id}/results?refresh=true`);
      qc.setQueryData(qk.results(id), fresh);
      qc.invalidateQueries({ queryKey: qk.job(id) });
    });
  const resubmit = () =>
    act('Resubmit', async () => {
      const nj = await apiPost<Job>(`/api/jobs/${id}/resubmit`);
      qc.invalidateQueries({ queryKey: qk.jobs });
      navigate(`/jobs/${nj.id}`);
    });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={2}>
          <Group gap="xs">
            <ActionIcon variant="subtle" component={Link} to="/jobs" aria-label="Back to jobs">
              <IconArrowLeft size={18} />
            </ActionIcon>
            <Title order={3}>{job.name}</Title>
            <StatusBadge status={job.status} size="md" />
            {job.status === 'running' && job.steps.length > 1 && (
              <Badge variant="outline">
                step {job.current_step}/{job.steps.length}
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed" className="qes-mono" ml={36}>
            {job.id} · {job.kind} · {job.connection_name}
          </Text>
        </Stack>
        <Group gap="xs">
          <AskAIButton
            context={aiContext}
            size="xs"
            prompt={
              job.status === 'failed' || job.status === 'lost'
                ? 'Why did this calculation fail and how do I fix it?'
                : 'Interpret these results. Are they physically reasonable and converged?'
            }
          />
          {active && (
            <Button
              size="xs"
              color="orange"
              variant="light"
              leftSection={<IconPlayerStop size={14} />}
              loading={cancel.isPending}
              onClick={() => cancel.mutate(job.id)}
            >
              Cancel
            </Button>
          )}
          <Tooltip label="Poll the job state on the target now">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconRefresh size={14} />}
              loading={busy === 'Refresh'}
              onClick={refreshStatus}
              disabled={!active}
            >
              Refresh
            </Button>
          </Tooltip>
          <Tooltip label="Download outputs into the local results cache and re-analyse">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconCloudDownload size={14} />}
              loading={busy === 'Fetch'}
              onClick={fetchResults}
              disabled={!job.remote_dir}
            >
              Fetch results
            </Button>
          </Tooltip>
          <Tooltip label="Download the cached results as a zip">
            <ActionIcon
              variant="default"
              size="lg"
              disabled={!job.fetched}
              onClick={() =>
                apiDownload(`/api/jobs/${id}/archive`, undefined, `job-${id}.zip`).catch((e) =>
                  notifyError(e, 'Download failed'),
                )
              }
            >
              <IconFileZip size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Submit a copy of this job">
            <ActionIcon variant="default" size="lg" loading={busy === 'Resubmit'} onClick={resubmit}>
              <IconRepeat size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete job">
            <ActionIcon
              variant="default"
              color="red"
              size="lg"
              onClick={() =>
                confirmDeleteJobs([job], () => {
                  qc.invalidateQueries({ queryKey: qk.jobs });
                  navigate('/jobs');
                })
              }
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {job.error && (
        <Alert
          color={job.status === 'cancelled' ? 'orange' : 'red'}
          title={job.status === 'lost' ? 'Job lost' : job.status === 'cancelled' ? 'Cancelled' : 'Job failed'}
        >
          {job.error}
          {job.exit_code != null && job.status === 'failed' ? ` (exit code ${job.exit_code})` : ''}
        </Alert>
      )}
      {job.summary?.poll_error && (
        <Alert color="yellow" title="Cannot reach the target right now">
          {job.summary.poll_error} — the job keeps running; status will update when the connection recovers.
        </Alert>
      )}
      {job.summary?.fetch_error && (
        <Alert color="yellow" title="Results could not be downloaded">
          {job.summary.fetch_error}
        </Alert>
      )}
      {job.summary?.analysis_error && (
        <Alert color="yellow" title="Analysis">
          {job.summary.analysis_error}
        </Alert>
      )}

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="log">Live log</Tabs.Tab>
          <Tabs.Tab value="inputs">Inputs ({job.steps.length})</Tabs.Tab>
          <Tabs.Tab value="files">Files</Tabs.Tab>
          <Tabs.Tab value="results" rightSection={results.isFetching ? <Loader size={10} /> : null}>
            Results
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview" pt="md">
          <Overview job={job} results={results.data} />
        </Tabs.Panel>
        <Tabs.Panel value="log" pt="md">
          <JobLog job={job} />
        </Tabs.Panel>
        <Tabs.Panel value="inputs" pt="md">
          <Inputs job={job} />
        </Tabs.Panel>
        <Tabs.Panel value="files" pt="md">
          <FilesBrowser job={job} />
        </Tabs.Panel>
        <Tabs.Panel value="results" pt="md">
          <Stack gap="md">
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {final
                  ? 'Analysis of the downloaded outputs.'
                  : 'The job is still running — results are partial; use “Re-analyse” to update.'}
              </Text>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconRefresh size={14} />}
                loading={busy === 'Re-analyse'}
                onClick={refreshResults}
                disabled={!job.remote_dir}
              >
                Re-analyse
              </Button>
            </Group>
            {results.isLoading && (
              <Center p="xl">
                <Loader />
              </Center>
            )}
            {results.error && (
              <Alert color="red" title="Could not load results">
                {errMsg(results.error)}
              </Alert>
            )}
            {!results.data && !results.isLoading && !results.error && (
              <Text size="sm" c="dimmed">
                {job.remote_dir ? 'Results not downloaded yet — press “Re-analyse”.' : 'This job never started.'}
              </Text>
            )}
            {results.data && <ResultsPanel results={results.data} jobId={job.id} jobName={job.name} />}
            {results.data && (
              <Text size="xs" c="dimmed">
                Wall times and energies are parsed from the QE outputs; plots export to PNG at 3× resolution (camera
                icon).
              </Text>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
