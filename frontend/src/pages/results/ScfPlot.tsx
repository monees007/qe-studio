import { useMemo } from 'react';
import { Card, Group, Text, Title } from '@mantine/core';
import type { IonicStep } from '../../api/types';
import { Plot } from '../../components/Plot';
import { PALETTE } from '../../lib/palette';
import type { LiveScfState } from '../../lib/liveScf';
import { RY_EV } from '../../lib/format';

interface Series {
  label: string;
  x: number[];
  acc: (number | null)[];
  energy: (number | null)[]; // eV
}

function plotData(series: Series[], showEnergy: boolean) {
  const data: any[] = [];
  const many = series.length > 10;
  series.forEach((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    data.push({
      type: 'scatter',
      mode: 'lines+markers',
      name: s.label,
      x: s.x,
      y: s.acc,
      line: { color, width: 1.5 },
      marker: { size: many ? 3 : 5, color },
      showlegend: !many || i === 0 || i === series.length - 1,
      hovertemplate: 'iter %{x}<br>accuracy %{y:.2e} Ry<extra>' + s.label + '</extra>',
    });
  });
  if (showEnergy && series.length) {
    const xs: number[] = [];
    const ys: (number | null)[] = [];
    series.forEach((s) => {
      xs.push(...s.x);
      ys.push(...s.energy);
    });
    data.push({
      type: 'scatter',
      mode: 'lines',
      name: 'total energy',
      x: xs,
      y: ys,
      yaxis: 'y2',
      line: { color: 'rgba(120,120,120,0.7)', width: 1, dash: 'dot' },
      hovertemplate: 'iter %{x}<br>E = %{y:.6f} eV<extra></extra>',
    });
  }
  return data;
}

function layout(showEnergy: boolean, thr?: number | null) {
  const l: any = {
    xaxis: { title: { text: 'SCF iteration (cumulative)' } },
    yaxis: { title: { text: 'estimated scf accuracy (Ry)' }, type: 'log', exponentformat: 'power' },
    legend: { orientation: 'h', y: -0.22 },
    margin: { l: 70, r: showEnergy ? 70 : 20, t: 20, b: 70 },
  };
  if (showEnergy)
    l.yaxis2 = { title: { text: 'E (eV)' }, overlaying: 'y', side: 'right', showgrid: false, tickformat: '.4f' };
  if (thr) {
    l.shapes = [
      {
        type: 'line',
        xref: 'paper',
        x0: 0,
        x1: 1,
        y0: thr,
        y1: thr,
        line: { color: 'rgba(200,50,50,0.6)', dash: 'dash', width: 1 },
      },
    ];
  }
  return l;
}

/** SCF convergence of a finished pw.x run (one trace per ionic step). */
export function ScfPlot({
  steps,
  convThr,
  height = 340,
}: {
  steps: IonicStep[];
  convThr?: number | null;
  height?: number;
}) {
  const series = useMemo<Series[]>(() => {
    let offset = 0;
    return steps
      .map((st, i) => {
        const its = st.iterations ?? [];
        const s: Series = {
          label: steps.length > 1 ? `step ${i + 1}` : 'SCF',
          x: its.map((_, k) => offset + k + 1),
          acc: its.map((it) => it.accuracy_ry),
          energy: its.map((it) => it.energy_ev),
        };
        offset += its.length;
        return s;
      })
      .filter((s) => s.x.length > 0);
  }, [steps]);
  const total = series.reduce((a, s) => a + s.x.length, 0);
  if (!total) return null;
  return (
    <Card>
      <Group justify="space-between" mb={4}>
        <Title order={5}>SCF convergence</Title>
        <Text size="xs" c="dimmed">
          {total} iterations{steps.length > 1 ? ` in ${steps.length} ionic steps` : ''}
        </Text>
      </Group>
      <Plot
        data={plotData(series, steps.length === 1)}
        layout={layout(steps.length === 1, convThr)}
        height={height}
        filename="scf-convergence"
      />
    </Card>
  );
}

/** Live SCF plot driven by the streamed log. */
export function LiveScfPlot({ state, height = 260 }: { state: LiveScfState; height?: number }) {
  const series = useMemo<Series[]>(() => {
    let offset = 0;
    return state.steps.map((st, i) => {
      const s: Series = {
        label: state.steps.length > 1 ? `step ${i + 1}` : 'SCF',
        x: st.iterations.map((_, k) => offset + k + 1),
        acc: st.iterations.map((it) => it.accuracyRy),
        energy: st.iterations.map((it) => (it.energyRy !== null ? it.energyRy * RY_EV : null)),
      };
      offset += st.iterations.length;
      return s;
    });
  }, [state]);
  if (!state.total) return null;
  return (
    <Plot
      data={plotData(series, state.steps.length === 1)}
      layout={layout(state.steps.length === 1)}
      height={height}
      filename="scf-live"
    />
  );
}
