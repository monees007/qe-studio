import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Menu,
  MultiSelect,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import {
  IconArrowsSort,
  IconChevronDown,
  IconChevronUp,
  IconDots,
  IconEye,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconRepeat,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react';
import { apiPost } from '../api/client';
import { notifyError, notifyOk, qk, useCancelJob, useConnections, useJobs } from '../api/hooks';
import type { Job } from '../api/types';
import { EmptyState, StatusBadge } from '../components/common';
import { elapsed, fmt, fmtDate } from '../lib/format';
import { confirmDeleteJobs } from './results/jobActions';
import { ACTIVE_STATUSES, parseIso, relTime, utcIso } from './results/util';

type SortKey = 'created' | 'name' | 'status' | 'duration';

const STATUSES = ['submitting', 'queued', 'running', 'done', 'failed', 'cancelled', 'lost', 'created'];

function durationS(j: Job): number {
  const a = j.started_at ?? j.submitted_at;
  if (!a) return 0;
  const b = j.finished_at ? parseIso(j.finished_at) : Date.now();
  return (b - parseIso(a)) / 1000;
}

function summaryText(j: Job): string {
  const s = j.summary ?? {};
  const parts: string[] = [];
  if (s.final_energy_ev != null) parts.push(`E = ${fmt(s.final_energy_ev, 5)} eV`);
  if (s.gap_ev != null) parts.push(`Eg = ${fmt(s.gap_ev, 3)} eV`);
  if (s.eos) parts.push(`B₀ = ${fmt(s.eos.B0_GPa, 1)} GPa`);
  if (s.recommended) parts.push(`converged at ${s.recommended}`);
  if (s.min_phonon_cm1 != null) parts.push(`ω_min = ${fmt(s.min_phonon_cm1, 1)} cm⁻¹`);
  if (s.total_magnetization != null && typeof s.total_magnetization === 'number')
    parts.push(`M = ${fmt(s.total_magnetization, 2)} μB`);
  return parts.join(' · ');
}

function SortHeader({
  label,
  k,
  sort,
  setSort,
}: {
  label: string;
  k: SortKey;
  sort: [SortKey, boolean];
  setSort: (s: [SortKey, boolean]) => void;
}) {
  const active = sort[0] === k;
  const Icon = !active ? IconArrowsSort : sort[1] ? IconChevronUp : IconChevronDown;
  return (
    <UnstyledButton onClick={() => setSort([k, active ? !sort[1] : k === 'name'])}>
      <Group gap={4} wrap="nowrap">
        <Text fw={600} size="sm">
          {label}
        </Text>
        <Icon size={14} />
      </Group>
    </UnstyledButton>
  );
}

export default function Jobs() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: jobs, isLoading, refetch, isFetching } = useJobs();
  const { data: conns } = useConnections();
  const cancel = useCancelJob();
  const [q, setQ] = useState('');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [conn, setConn] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [sort, setSort] = useState<[SortKey, boolean]>(['created', false]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const kinds = useMemo(() => [...new Set((jobs ?? []).map((j) => j.kind))].sort(), [jobs]);
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const list = (jobs ?? []).filter(
      (j) =>
        (!statuses.length || statuses.includes(j.status)) &&
        (!conn || j.connection_id === conn) &&
        (!kind || j.kind === kind) &&
        (!ql ||
          j.name.toLowerCase().includes(ql) ||
          j.id.includes(ql) ||
          (j.remote_dir ?? '').toLowerCase().includes(ql)),
    );
    const dir = sort[1] ? 1 : -1;
    list.sort((a, b) => {
      switch (sort[0]) {
        case 'name':
          return dir * a.name.localeCompare(b.name);
        case 'status':
          return dir * a.status.localeCompare(b.status);
        case 'duration':
          return dir * (durationS(a) - durationS(b));
        default:
          return dir * (parseIso(a.created_at) - parseIso(b.created_at));
      }
    });
    return list;
  }, [jobs, q, statuses, conn, kind, sort]);

  const resubmit = async (j: Job) => {
    try {
      const nj = await apiPost<Job>(`/api/jobs/${j.id}/resubmit`);
      qc.invalidateQueries({ queryKey: qk.jobs });
      notifyOk(`Resubmitted as ${nj.id}`);
      navigate(`/jobs/${nj.id}`);
    } catch (e) {
      notifyError(e, 'Resubmit failed');
    }
  };
  const refreshAfterDelete = () => {
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: qk.jobs });
  };
  const selJobs = rows.filter((j) => selected.has(j.id));
  const allSel = rows.length > 0 && rows.every((j) => selected.has(j.id));

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={3}>Jobs</Title>
        <Group gap="xs">
          {selJobs.length > 0 && (
            <Button
              size="xs"
              color="red"
              variant="light"
              leftSection={<IconTrash size={14} />}
              onClick={() => confirmDeleteJobs(selJobs, refreshAfterDelete)}
            >
              Delete {selJobs.length}
            </Button>
          )}
          <Tooltip label="Reload list">
            <ActionIcon variant="default" onClick={() => refetch()} loading={isFetching}>
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
          <Button size="xs" leftSection={<IconPlus size={14} />} component={Link} to="/run">
            New job
          </Button>
        </Group>
      </Group>
      <Card p="sm">
        <Group gap="xs" wrap="wrap">
          <TextInput
            size="xs"
            placeholder="Search name, id, directory"
            leftSection={<IconSearch size={14} />}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            w={240}
          />
          <MultiSelect
            size="xs"
            placeholder="Status"
            data={STATUSES}
            value={statuses}
            onChange={setStatuses}
            clearable
            w={260}
          />
          <Select
            size="xs"
            placeholder="Connection"
            data={(conns ?? []).map((c) => ({ value: c.id, label: c.name }))}
            value={conn}
            onChange={setConn}
            clearable
            w={200}
          />
          <Select size="xs" placeholder="Kind" data={kinds} value={kind} onChange={setKind} clearable w={160} />
          <Text size="xs" c="dimmed">
            {rows.length} of {jobs?.length ?? 0}
          </Text>
        </Group>
      </Card>
      {isLoading ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : !jobs?.length ? (
        <Card>
          <EmptyState
            title="No jobs yet"
            action={
              <Button component={Link} to="/run">
                Set up a calculation
              </Button>
            }
          >
            Generate an input from a structure, pick a workflow and submit it to a connection.
          </EmptyState>
        </Card>
      ) : (
        <Card p={0}>
          <Table.ScrollContainer minWidth={980}>
            <Table highlightOnHover verticalSpacing="xs" stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={36}>
                    <Checkbox
                      size="xs"
                      checked={allSel}
                      indeterminate={!allSel && selJobs.length > 0}
                      onChange={() => setSelected(allSel ? new Set() : new Set(rows.map((j) => j.id)))}
                    />
                  </Table.Th>
                  <Table.Th>
                    <SortHeader label="Name" k="name" sort={sort} setSort={setSort} />
                  </Table.Th>
                  <Table.Th>Kind</Table.Th>
                  <Table.Th>
                    <SortHeader label="Status" k="status" sort={sort} setSort={setSort} />
                  </Table.Th>
                  <Table.Th>Connection</Table.Th>
                  <Table.Th>
                    <SortHeader label="Created" k="created" sort={sort} setSort={setSort} />
                  </Table.Th>
                  <Table.Th>
                    <SortHeader label="Duration" k="duration" sort={sort} setSort={setSort} />
                  </Table.Th>
                  <Table.Th>Result</Table.Th>
                  <Table.Th w={70} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((j) => {
                  const active = ACTIVE_STATUSES.includes(j.status);
                  return (
                    <Table.Tr key={j.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/jobs/${j.id}`)}>
                      <Table.Td onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          size="xs"
                          checked={selected.has(j.id)}
                          onChange={() => {
                            const s = new Set(selected);
                            if (s.has(j.id)) s.delete(j.id);
                            else s.add(j.id);
                            setSelected(s);
                          }}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Anchor
                          component={Link}
                          to={`/jobs/${j.id}`}
                          size="sm"
                          fw={500}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {j.name}
                        </Anchor>
                        <Text size="xs" c="dimmed" className="qes-mono">
                          {j.id}
                          {j.steps.length > 1 ? ` · ${j.steps.length} steps` : ''}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="outline" size="sm">
                          {j.kind}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <StatusBadge status={j.status} />
                          {j.status === 'running' && j.steps.length > 1 && (
                            <Text size="xs" c="dimmed">
                              {j.current_step}/{j.steps.length}
                            </Text>
                          )}
                        </Group>
                        {j.error && (
                          <Text size="xs" c="red" lineClamp={1} maw={260} title={j.error}>
                            {j.error}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{j.connection_name ?? j.connection_id}</Text>
                        {j.scheduler !== 'direct' && (
                          <Text size="xs" c="dimmed">
                            {j.scheduler} {j.remote_job_id}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Tooltip label={fmtDate(utcIso(j.created_at))}>
                          <Text size="sm">{relTime(j.created_at)}</Text>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {j.started_at || j.submitted_at
                            ? elapsed(utcIso(j.started_at ?? j.submitted_at), utcIso(j.finished_at))
                            : '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" className="qes-mono" lineClamp={2} maw={300}>
                          {summaryText(j)}
                        </Text>
                      </Table.Td>
                      <Table.Td onClick={(e) => e.stopPropagation()}>
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target>
                            <ActionIcon variant="subtle">
                              <IconDots size={16} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item leftSection={<IconEye size={14} />} onClick={() => navigate(`/jobs/${j.id}`)}>
                              Open
                            </Menu.Item>
                            {active && (
                              <Menu.Item
                                leftSection={<IconPlayerStop size={14} />}
                                color="orange"
                                onClick={() => cancel.mutate(j.id)}
                              >
                                Cancel
                              </Menu.Item>
                            )}
                            <Menu.Item leftSection={<IconRepeat size={14} />} onClick={() => resubmit(j)}>
                              Resubmit (copy)
                            </Menu.Item>
                            <Menu.Divider />
                            <Menu.Item
                              leftSection={<IconTrash size={14} />}
                              color="red"
                              onClick={() => confirmDeleteJobs([j], refreshAfterDelete)}
                            >
                              Delete…
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
    </Stack>
  );
}
