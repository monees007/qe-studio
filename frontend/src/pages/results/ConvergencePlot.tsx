import { useMemo, useState } from 'react';
import { Alert, Card, Group, NumberInput, Table, Text, Title } from '@mantine/core';
import type { ConvergenceResult } from '../../api/types';
import { Plot } from '../../components/Plot';
import { fmt, fmtDuration } from '../../lib/format';

/** Convergence scan (ecutwfc, ecutrho, k-points, smearing): |ΔE| per atom vs parameter. */
export function ConvergencePlot({ conv }: { conv: ConvergenceResult }) {
  const [thr, setThr] = useState<number>(conv.recommended?.threshold_mev_per_atom ?? 1);
  const rows = conv.rows;
  const numeric = rows.every((r) => typeof r.value === 'number');
  const xs = useMemo(() => rows.map((r, i) => (numeric ? (r.value as number) : i)), [rows, numeric]);
  const ticktext = useMemo(() => rows.map((r) => r.label), [rows]);

  const data = useMemo(() => {
    const valid = rows
      .map((r, i) => ({ r, x: xs[i] }))
      .filter(({ r }) => r.delta_mev_per_atom !== null && Math.abs(r.delta_mev_per_atom) > 1e-9);
    const d: any[] = [
      {
        type: 'scatter',
        mode: 'lines+markers',
        name: '|ΔE| (meV/atom)',
        x: valid.map((v) => v.x),
        y: valid.map((v) => Math.abs(v.r.delta_mev_per_atom as number)),
        text: valid.map((v) => v.r.label),
        line: { color: '#1c7ed6' },
        marker: { size: 7 },
        hovertemplate: '%{text}<br>|ΔE| = %{y:.4f} meV/atom<extra></extra>',
      },
    ];
    const dp = rows
      .map((r, i) => ({ r, x: xs[i] }))
      .filter(({ r }) => r.delta_p_kbar !== null && Math.abs(r.delta_p_kbar) > 1e-9);
    if (dp.length) {
      d.push({
        type: 'scatter',
        mode: 'lines+markers',
        name: '|ΔP| (kbar)',
        x: dp.map((v) => v.x),
        y: dp.map((v) => Math.abs(v.r.delta_p_kbar as number)),
        yaxis: 'y2',
        text: dp.map((v) => v.r.label),
        line: { color: '#e8590c', dash: 'dot' },
        marker: { size: 6, symbol: 'square' },
        hovertemplate: '%{text}<br>|ΔP| = %{y:.3f} kbar<extra></extra>',
      });
    }
    return d;
  }, [rows, xs]);

  const layout = useMemo(
    () =>
      ({
        xaxis: numeric
          ? { title: { text: conv.parameter } }
          : { title: { text: conv.parameter }, tickvals: xs, ticktext },
        yaxis: { title: { text: '|E − E<sub>ref</sub>| (meV/atom)' }, type: 'log', exponentformat: 'power' },
        yaxis2: {
          title: { text: '|ΔP| (kbar)' },
          overlaying: 'y',
          side: 'right',
          type: 'log',
          showgrid: false,
          exponentformat: 'power',
        },
        shapes: [
          {
            type: 'line',
            xref: 'paper',
            x0: 0,
            x1: 1,
            y0: thr,
            y1: thr,
            line: { color: 'rgba(200,50,50,0.7)', dash: 'dash', width: 1 },
          },
        ],
        legend: { orientation: 'h', y: -0.22 },
        margin: { l: 70, r: 70, t: 16, b: 70 },
      }) as any,
    [numeric, xs, ticktext, conv.parameter, thr],
  );

  // recommendation for the user-chosen threshold (the backend one uses 1 meV/atom)
  const rec = useMemo(() => {
    for (let i = 0; i < rows.length; i++) {
      const tail = rows.slice(i);
      if (tail.every((t) => t.delta_mev_per_atom !== null && Math.abs(t.delta_mev_per_atom) < thr)) return rows[i];
    }
    return null;
  }, [rows, thr]);

  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Title order={5}>Convergence: {conv.parameter}</Title>
        <NumberInput
          size="xs"
          w={170}
          label="threshold (meV/atom)"
          value={thr}
          min={0.001}
          step={0.5}
          decimalScale={3}
          onChange={(v) => typeof v === 'number' && v > 0 && setThr(v)}
        />
      </Group>
      {rec ? (
        <Alert color="teal" mb="xs" title={`Converged within ${thr} meV/atom at ${conv.parameter} = ${rec.label}`}>
          Relative to the most converged point ({rows[rows.length - 1]?.label}). Total-energy convergence is necessary
          but not sufficient: also check forces, stress and the property you care about.
        </Alert>
      ) : (
        <Alert color="orange" mb="xs" title="Not converged within the scanned range">
          Extend the scan to larger values.
        </Alert>
      )}
      <Plot data={data} layout={layout} height={340} filename={`convergence-${conv.parameter}`} />
      <Table.ScrollContainer minWidth={640}>
        <Table striped fz="xs" className="qes-mono" mt="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{conv.parameter}</Table.Th>
              <Table.Th>E (eV)</Table.Th>
              <Table.Th>E/atom (eV)</Table.Th>
              <Table.Th>ΔE (meV/atom)</Table.Th>
              <Table.Th>P (kbar)</Table.Th>
              <Table.Th>ΔP (kbar)</Table.Th>
              <Table.Th>
                F<sub>max</sub> (Ry/bohr)
              </Table.Th>
              <Table.Th>wall</Table.Th>
              <Table.Th>status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r, i) => (
              <Table.Tr key={i} bg={rec === r ? 'var(--mantine-color-teal-light)' : undefined}>
                <Table.Td>{r.label}</Table.Td>
                <Table.Td>{fmt(r.energy_ev, 6)}</Table.Td>
                <Table.Td>{fmt(r.energy_per_atom_ev, 6)}</Table.Td>
                <Table.Td>{fmt(r.delta_mev_per_atom, 3)}</Table.Td>
                <Table.Td>{fmt(r.pressure_kbar, 2)}</Table.Td>
                <Table.Td>{fmt(r.delta_p_kbar, 2)}</Table.Td>
                <Table.Td>{fmt(r.max_force, 5)}</Table.Td>
                <Table.Td>{fmtDuration(r.wall_s)}</Table.Td>
                <Table.Td>
                  <Text size="xs" c={r.status === 'done' ? 'teal' : 'red'}>
                    {r.status}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
