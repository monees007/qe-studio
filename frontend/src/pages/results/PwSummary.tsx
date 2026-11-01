import { Accordion, Alert, Badge, Card, Group, List, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconCircleX } from '@tabler/icons-react';
import { useSettings } from '../../api/hooks';
import type { PwResult } from '../../api/types';
import { fmt, fmtDuration, fmtEnergy, RY_EV } from '../../lib/format';
import { RY_BOHR_TO_EV_A } from './util';

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="sm" fw={500} className="qes-mono">
        {value}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed" className="qes-mono">
          {sub}
        </Text>
      )}
    </div>
  );
}

/** Key quantities of a pw.x run (energies, levels, gap, magnetization, forces, stress, timing). */
export function PwSummary({ pw, title = 'pw.x summary' }: { pw: PwResult; title?: string }) {
  const { data: settings } = useSettings();
  const unit = settings?.energy_unit ?? 'eV';
  const s = pw.summary ?? {};
  const steps = pw.scf ?? [];
  const last = steps[steps.length - 1];
  const nat: number | null = s.nat ?? null;
  const e: number | null = s.final_energy_ev ?? pw.xml?.total_energy_ev ?? null;
  const status: string = s.status ?? 'unknown';
  const relax = s.relax as Record<string, any> | null | undefined;
  const gap = pw.gap;
  const forces = pw.forces_ry_bohr ?? [];
  const stress = pw.stress_kbar;
  const maxForce = last?.max_force ?? null;
  const mag = s.total_magnetization;

  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Title order={5}>{title}</Title>
        <Group gap={6}>
          {s.version && <Badge variant="outline">QE {s.version}</Badge>}
          <Badge
            color={status === 'done' ? 'teal' : status === 'incomplete' ? 'yellow' : 'red'}
            leftSection={
              status === 'done' ? (
                <IconCircleCheck size={12} />
              ) : status === 'incomplete' ? (
                <IconAlertTriangle size={12} />
              ) : (
                <IconCircleX size={12} />
              )
            }
          >
            {status === 'not_converged' ? 'SCF not converged' : status}
          </Badge>
        </Group>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="md" verticalSpacing="sm">
        <Stat
          label="Total energy"
          value={fmtEnergy(e, unit)}
          sub={e !== null ? `${(e / RY_EV).toFixed(8)} Ry${nat ? ` · ${fmt(e / nat, 5)} eV/atom` : ''}` : undefined}
        />
        {s.fermi_energy_ev != null && (
          <Stat
            label="Fermi energy"
            value={`${fmt(s.fermi_energy_ev, 4)} eV`}
            sub={
              s.fermi_energies_ev
                ? `up/down ${fmt(s.fermi_energies_ev[0], 4)} / ${fmt(s.fermi_energies_ev[1], 4)} eV`
                : undefined
            }
          />
        )}
        {s.homo_ev != null && (
          <Stat
            label={s.lumo_ev != null ? 'HOMO / LUMO' : 'Highest occupied'}
            value={s.lumo_ev != null ? `${fmt(s.homo_ev, 4)} / ${fmt(s.lumo_ev, 4)} eV` : `${fmt(s.homo_ev, 4)} eV`}
          />
        )}
        {gap && (
          <Stat
            label="Band gap (k-mesh)"
            value={gap.metal ? 'metallic' : `${fmt(gap.gap_ev, 3)} eV`}
            sub={
              !gap.metal && gap.direct !== null
                ? gap.direct
                  ? 'direct'
                  : `indirect · direct ${fmt(gap.direct_gap_ev ?? null, 3)} eV`
                : undefined
            }
          />
        )}
        {mag != null && (
          <Stat
            label="Total magnetization"
            value={`${Array.isArray(mag) ? mag.map((m: number) => fmt(m, 3)).join(', ') : fmt(mag, 3)} μB/cell`}
            sub={s.absolute_magnetization != null ? `absolute ${fmt(s.absolute_magnetization, 3)} μB/cell` : undefined}
          />
        )}
        {last?.pressure_kbar != null && (
          <Stat
            label="Pressure"
            value={`${fmt(last.pressure_kbar, 2)} kbar`}
            sub={`${fmt(last.pressure_kbar / 10, 3)} GPa`}
          />
        )}
        {maxForce != null && (
          <Stat
            label="Max force"
            value={`${fmt(maxForce, 5)} Ry/bohr`}
            sub={`${fmt(maxForce * RY_BOHR_TO_EV_A, 4)} eV/Å`}
          />
        )}
        {last && (
          <Stat
            label="SCF iterations"
            value={`${last.n_scf ?? last.iterations?.length ?? '—'}${steps.length > 1 ? ` (last of ${steps.length} ionic steps)` : ''}`}
          />
        )}
        {s.wall_time_s != null && (
          <Stat
            label="Wall time"
            value={fmtDuration(s.wall_time_s)}
            sub={s.mpi_processes ? `${s.mpi_processes} MPI × ${s.threads ?? 1} OpenMP` : undefined}
          />
        )}
        {s.xc && <Stat label="Functional" value={s.xc} />}
        {s.ecutwfc != null && (
          <Stat label="Cutoffs" value={`${fmt(s.ecutwfc, 1)} / ${fmt(s.ecutrho, 1)} Ry`} sub="ecutwfc / ecutrho" />
        )}
        {s.nks != null && (
          <Stat
            label="k-points"
            value={`${s.nks} (irreducible)`}
            sub={s.nelec != null ? `${fmt(s.nelec, 2)} electrons, ${s.nbnd} bands` : undefined}
          />
        )}
      </SimpleGrid>

      {relax && (
        <Alert
          mt="md"
          color={relax.converged ? 'teal' : relax.converged === false ? 'orange' : 'gray'}
          variant="light"
          title={
            relax.converged
              ? 'Geometry optimization converged'
              : relax.converged === false
                ? 'Geometry optimization NOT converged'
                : 'Geometry optimization'
          }
        >
          {relax.bfgs_steps != null && (
            <Text size="sm">
              {relax.bfgs_steps} BFGS steps, {relax.scf_cycles} SCF cycles.
            </Text>
          )}
          {relax.final_energy_ry != null && (
            <Text size="sm">Final energy {fmt(relax.final_energy_ry * RY_EV, 6)} eV.</Text>
          )}
          {relax.message && <Text size="sm">{relax.message}</Text>}
        </Alert>
      )}

      {(s.errors?.length > 0 || s.warnings?.length > 0) && (
        <Stack gap={6} mt="md">
          {s.errors?.length > 0 && (
            <Alert color="red" title="Errors reported by pw.x" icon={<IconCircleX size={16} />}>
              <List size="sm">
                {s.errors.map((x: string, i: number) => (
                  <List.Item key={i}>{x}</List.Item>
                ))}
              </List>
            </Alert>
          )}
          {s.warnings?.length > 0 && (
            <Alert color="yellow" title={`${s.warnings.length} warning(s)`} icon={<IconAlertTriangle size={16} />}>
              <List size="xs">
                {s.warnings.slice(0, 15).map((x: string, i: number) => (
                  <List.Item key={i}>{x}</List.Item>
                ))}
              </List>
            </Alert>
          )}
        </Stack>
      )}

      {(forces.length > 0 || stress) && (
        <Accordion variant="contained" mt="md" multiple>
          {forces.length > 0 && (
            <Accordion.Item value="forces">
              <Accordion.Control>Forces on atoms ({forces.length})</Accordion.Control>
              <Accordion.Panel>
                <Table.ScrollContainer minWidth={420} mah={320}>
                  <Table striped withTableBorder fz="xs" className="qes-mono">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>#</Table.Th>
                        <Table.Th>Fx</Table.Th>
                        <Table.Th>Fy</Table.Th>
                        <Table.Th>Fz</Table.Th>
                        <Table.Th>|F| (Ry/bohr)</Table.Th>
                        <Table.Th>|F| (eV/Å)</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {forces.map((f, i) => {
                        const n = Math.hypot(f[0], f[1], f[2]);
                        return (
                          <Table.Tr key={i}>
                            <Table.Td>{i + 1}</Table.Td>
                            <Table.Td>{f[0].toFixed(6)}</Table.Td>
                            <Table.Td>{f[1].toFixed(6)}</Table.Td>
                            <Table.Td>{f[2].toFixed(6)}</Table.Td>
                            <Table.Td>{n.toFixed(6)}</Table.Td>
                            <Table.Td>{(n * RY_BOHR_TO_EV_A).toFixed(5)}</Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Accordion.Panel>
            </Accordion.Item>
          )}
          {stress && (
            <Accordion.Item value="stress">
              <Accordion.Control>Stress tensor (kbar)</Accordion.Control>
              <Accordion.Panel>
                <Table withTableBorder fz="xs" className="qes-mono" w={360}>
                  <Table.Tbody>
                    {stress.map((r, i) => (
                      <Table.Tr key={i}>
                        {r.map((v, j) => (
                          <Table.Td key={j}>{v.toFixed(2)}</Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                <Text size="xs" c="dimmed" mt={4}>
                  Positive values: tensile in QE's sign convention (P = −Tr(σ)/3 is printed as "P=").
                </Text>
              </Accordion.Panel>
            </Accordion.Item>
          )}
        </Accordion>
      )}
    </Card>
  );
}
