import { useMemo } from 'react';
import { Alert, Card, Grid, Group, Table, Text, Title } from '@mantine/core';
import type { EosResult } from '../../api/types';
import { Plot } from '../../components/Plot';
import { fmt } from '../../lib/format';

/** Equation of state: E(V) points with a 3rd-order Birch–Murnaghan fit. */
export function EosPlot({ eos }: { eos: EosResult }) {
  const fit = eos.fit;
  const pts = eos.points.filter((p) => p.energy_ev !== null) as { volume: number; energy_ev: number }[];
  const e0 = fit?.e0_ev ?? Math.min(...pts.map((p) => p.energy_ev));
  const data = useMemo(() => {
    const d: any[] = [
      {
        type: 'scatter',
        mode: 'markers',
        name: 'DFT',
        x: pts.map((p) => p.volume),
        y: pts.map((p) => (p.energy_ev - e0) * 1000),
        marker: { size: 9, color: '#1c7ed6' },
        hovertemplate: 'V = %{x:.3f} Å³<br>E − E₀ = %{y:.2f} meV<extra></extra>',
      },
    ];
    if (fit?.curve?.energy_ev) {
      d.push({
        type: 'scatter',
        mode: 'lines',
        name: 'Birch–Murnaghan',
        x: fit.curve.volume,
        y: fit.curve.energy_ev.map((e) => (e - e0) * 1000),
        line: { color: '#e8590c', width: 2 },
        hoverinfo: 'skip',
      });
    }
    return d;
  }, [pts, fit, e0]);
  const layout = useMemo(
    () =>
      ({
        xaxis: { title: { text: 'V (Å³ per cell)' } },
        yaxis: { title: { text: 'E − E<sub>0</sub> (meV per cell)' } },
        shapes: fit
          ? [
              {
                type: 'line',
                xref: 'x',
                yref: 'paper',
                x0: fit.v0,
                x1: fit.v0,
                y0: 0,
                y1: 1,
                line: { dash: 'dot', color: 'rgba(128,128,128,0.7)', width: 1 },
              },
            ]
          : [],
        legend: { orientation: 'h', y: -0.2 },
        margin: { l: 70, r: 16, t: 16, b: 70 },
      }) as any,
    [fit],
  );

  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Title order={5}>Equation of state</Title>
        <Text size="xs" c="dimmed">
          {pts.length}/{eos.points.length} volumes converged
        </Text>
      </Group>
      {eos.fit_error && (
        <Alert color="red" mb="xs" title="Fit not available">
          {eos.fit_error}
        </Alert>
      )}
      {fit?.warning && (
        <Alert color="orange" mb="xs" title="Check the sampled range">
          {fit.warning}
        </Alert>
      )}
      <Grid>
        <Grid.Col span={{ base: 12, md: fit ? 8 : 12 }}>
          <Plot data={data} layout={layout} height={360} filename="eos" />
        </Grid.Col>
        {fit && (
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Table withTableBorder fz="sm" className="qes-mono">
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td>V₀</Table.Td>
                  <Table.Td>{fmt(fit.v0, 4)} Å³</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>V₀ / atom</Table.Td>
                  <Table.Td>{fmt(fit.v0_per_atom, 4)} Å³</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>
                    V₀<sup>1/3</sup>
                  </Table.Td>
                  <Table.Td>{fmt(fit.a0_cubic_equiv, 4)} Å</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>E₀</Table.Td>
                  <Table.Td>{fmt(fit.e0_ev, 6)} eV</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>B₀</Table.Td>
                  <Table.Td>{fmt(fit.B0_GPa, 2)} GPa</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>B₀′</Table.Td>
                  <Table.Td>{fmt(fit.B0_prime, 3)}</Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
            <Text size="xs" c="dimmed" mt={6}>
              {fit.eos}. V₀<sup>1/3</sup> equals the lattice constant only for a simple-cubic cell; for an fcc primitive
              cell a = (4V₀)<sup>1/3</sup>, for bcc a = (2V₀)<sup>1/3</sup>. Volumes were scaled isotropically.
            </Text>
          </Grid.Col>
        )}
      </Grid>
    </Card>
  );
}
