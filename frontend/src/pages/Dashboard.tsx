import { Link, useNavigate } from 'react-router-dom';
import {
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconAtom,
  IconBrandStackshare,
  IconCheck,
  IconCircleDashed,
  IconFileCode,
  IconFlask2,
  IconPlugConnected,
} from '@tabler/icons-react';
import { useConnections, useJobs, usePseudos, useSettings, useStructures } from '../api/hooks';
import { StatusBadge } from '../components/common';
import { elapsed, fmtDate, fmtEnergy } from '../lib/format';

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <List.Item
      icon={
        <ThemeIcon size={20} radius="xl" color={done ? 'teal' : 'gray'} variant={done ? 'filled' : 'light'}>
          {done ? <IconCheck size={12} /> : <IconCircleDashed size={12} />}
        </ThemeIcon>
      }
    >
      {children}
    </List.Item>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { data: jobs } = useJobs();
  const { data: conns } = useConnections();
  const { data: ps } = usePseudos();
  const { data: structs } = useStructures();
  const { data: settings } = useSettings();
  const unit = settings?.energy_unit ?? 'eV';
  const qeReady = (conns ?? []).some((c) => c.config.detected?.qe_found);
  const counts = (jobs ?? []).reduce<Record<string, number>>(
    (a, j) => ({ ...a, [j.status]: (a[j.status] ?? 0) + 1 }),
    {},
  );

  return (
    <Stack>
      <Title order={2}>Dashboard</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        {[
          { icon: IconAtom, label: 'Build or import a structure', to: '/structures', color: 'blue' },
          { icon: IconFileCode, label: 'Write / edit an input', to: '/editor', color: 'cyan' },
          { icon: IconBrandStackshare, label: 'Run a workflow', to: '/run', color: 'grape' },
          { icon: IconPlugConnected, label: 'Set up compute & QE', to: '/connections', color: 'teal' },
        ].map((a) => (
          <Card key={a.to} style={{ cursor: 'pointer' }} onClick={() => navigate(a.to)}>
            <Group>
              <ThemeIcon size="lg" color={a.color} variant="light">
                <a.icon size={20} />
              </ThemeIcon>
              <Text fw={500}>{a.label}</Text>
            </Group>
          </Card>
        ))}
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 3 }}>
        <Card style={{ gridColumn: 'span 2' }}>
          <Group justify="space-between" mb="xs">
            <Text fw={600}>Recent jobs</Text>
            <Group gap={4}>
              {Object.entries(counts).map(([s, n]) => (
                <Badge key={s} variant="outline" size="sm">
                  {s}: {n}
                </Badge>
              ))}
            </Group>
          </Group>
          {jobs?.length ? (
            <Table highlightOnHover verticalSpacing={4} fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Where</Table.Th>
                  <Table.Th>Result</Table.Th>
                  <Table.Th>Created</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {jobs.slice(0, 10).map((j) => (
                  <Table.Tr key={j.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/jobs/${j.id}`)}>
                    <Table.Td>
                      {j.name}
                      <Text size="xs" c="dimmed">
                        {j.kind}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={j.status} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{j.connection_name}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">
                        {j.summary?.final_energy_ev != null
                          ? fmtEnergy(j.summary.final_energy_ev, unit, 5)
                          : j.summary?.recommended
                            ? `converged at ${j.summary.recommended}`
                            : j.summary?.eos
                              ? `B₀ = ${j.summary.eos.B0_GPa.toFixed(1)} GPa`
                              : ''}
                        {j.summary?.gap_ev != null ? ` · gap ${j.summary.gap_ev.toFixed(3)} eV` : ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{fmtDate(j.created_at)}</Text>
                      {['running', 'queued'].includes(j.status) && (
                        <Text size="xs" c="dimmed">
                          {elapsed(j.started_at ?? j.submitted_at)}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text size="sm" c="dimmed">
              No jobs yet.
            </Text>
          )}
          <Anchor component={Link} to="/jobs" size="sm" mt="xs">
            All jobs →
          </Anchor>
        </Card>

        <Card>
          <Text fw={600} mb="xs">
            Getting started
          </Text>
          <List spacing="sm" size="sm">
            <Step done={qeReady}>
              Make Quantum ESPRESSO available on a{' '}
              <Anchor component={Link} to="/connections">
                connection
              </Anchor>{' '}
              (detect, install from conda-forge, or upload your own binaries).
            </Step>
            <Step done={(ps?.pseudos.length ?? 0) > 0}>
              Add{' '}
              <Anchor component={Link} to="/pseudos">
                pseudopotentials
              </Anchor>{' '}
              (e.g. SSSP).
            </Step>
            <Step done={(structs?.length ?? 0) > 0}>
              Build or import a{' '}
              <Anchor component={Link} to="/structures">
                structure
              </Anchor>
              .
            </Step>
            <Step done={(jobs?.length ?? 0) > 0}>
              Generate an input, check it, and{' '}
              <Anchor component={Link} to="/run">
                run a workflow
              </Anchor>
              .
            </Step>
          </List>
          <Stack gap={4} mt="md">
            <Text size="sm" fw={500}>
              Compute
            </Text>
            {(conns ?? []).map((c) => (
              <Group key={c.id} gap={6} justify="space-between">
                <Text size="sm">{c.name}</Text>
                {c.config.detected?.qe_found ? (
                  <Badge color="teal" size="sm">
                    QE {c.config.detected.qe_version ?? '✓'}
                  </Badge>
                ) : (
                  <Badge color="gray" size="sm">
                    QE ?
                  </Badge>
                )}
              </Group>
            ))}
            <Group gap={6} mt="xs">
              <IconFlask2 size={14} />
              <Text size="sm">
                {ps?.pseudos.length ?? 0} pseudopotentials · {structs?.length ?? 0} structures
              </Text>
            </Group>
          </Stack>
          <Button mt="md" variant="light" fullWidth onClick={() => navigate('/analysis')}>
            Analyze an existing output file
          </Button>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
