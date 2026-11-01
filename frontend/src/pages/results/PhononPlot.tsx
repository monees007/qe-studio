import { useMemo, useState } from 'react';
import { Alert, Card, Group, SegmentedControl, Text, Title } from '@mantine/core';
import type { PhononResult } from '../../api/types';
import { Plot } from '../../components/Plot';
import { fmt } from '../../lib/format';
import { CM1_PER_MEV, CM1_PER_THZ, finiteMax, finiteMin, joinSeries, tickShapes } from './util';

type Unit = 'cm-1' | 'THz' | 'meV';
const FACTOR: Record<Unit, number> = { 'cm-1': 1, THz: 1 / CM1_PER_THZ, meV: 1 / CM1_PER_MEV };
const LABEL: Record<Unit, string> = { 'cm-1': 'ω (cm<sup>−1</sup>)', THz: 'ν (THz)', meV: 'ħω (meV)' };

/** Phonon dispersion (matdyn.x) with the phonon DOS side panel. */
export function PhononPlot({ phonon, height = 460 }: { phonon: PhononResult; height?: number }) {
  const [unit, setUnit] = useState<Unit>('cm-1');
  const f = FACTOR[unit];
  const disp = phonon.dispersion;
  const pdos = phonon.dos;

  const { data, layout } = useMemo(() => {
    const d: any[] = [];
    const allF: number[] = [];
    if (disp) {
      const j = joinSeries(disp.x, disp.freq_cm1, disp.breaks ?? [], 0, f);
      d.push({
        type: 'scatter',
        mode: 'lines',
        name: 'dispersion',
        x: j.x,
        y: j.y,
        line: { color: '#1c7ed6', width: 1.6 },
        hovertemplate: `%{y:.2f} ${unit}<extra></extra>`,
        xaxis: 'x',
        yaxis: 'y',
      });
      disp.freq_cm1.forEach((r) => r.forEach((v) => allF.push(v * f)));
    }
    if (pdos) {
      const fr = pdos.freq_cm1.map((v) => v * f);
      d.push({
        type: 'scatter',
        mode: 'lines',
        name: 'phonon DOS',
        x: pdos.dos,
        y: fr,
        line: { color: '#495057', width: 1.4 },
        fill: 'tozerox',
        fillcolor: 'rgba(120,120,120,0.2)',
        xaxis: disp ? 'x2' : 'x',
        yaxis: 'y',
        hovertemplate: 'g = %{x:.4f}<extra></extra>',
      });
      fr.forEach((v) => allF.push(v));
    }
    const lo = Math.min(0, finiteMin(allF) ?? 0);
    const hi = (finiteMax(allF) ?? 1) * 1.05;
    const l: any = {
      yaxis: { title: { text: LABEL[unit] }, range: [lo - 0.02 * (hi - lo), hi], zeroline: true },
      showlegend: false,
      margin: { l: 64, r: 16, t: 16, b: 40 },
      shapes: [] as any[],
    };
    if (disp) {
      const ticks = disp.ticks ?? [];
      l.xaxis = {
        domain: [0, pdos ? 0.76 : 1],
        tickvals: ticks.map((t) => t.x),
        ticktext: ticks.map((t) => t.label),
        showgrid: false,
        zeroline: false,
        range: [disp.x[0] ?? 0, disp.x[disp.x.length - 1] ?? 1],
        ticks: '',
      };
      l.shapes = tickShapes(ticks, false);
      if (pdos) l.xaxis2 = { domain: [0.8, 1], title: { text: 'DOS' }, showticklabels: false, zeroline: false };
    } else {
      l.xaxis = { title: { text: 'phonon DOS (states/unit)' } };
    }
    return { data: d, layout: l };
  }, [disp, pdos, f, unit]);

  const imag = phonon.imaginary_modes || (disp && disp.min_freq_cm1 < -5);
  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Title order={5}>Phonons</Title>
        <SegmentedControl size="xs" value={unit} onChange={(v) => setUnit(v as Unit)} data={['cm-1', 'THz', 'meV']} />
      </Group>
      {imag && disp && (
        <Alert color="orange" mb="xs" title="Imaginary (negative) frequencies">
          Lowest frequency {fmt(disp.min_freq_cm1, 1)} cm<sup>−1</sup>. Small negative values near Γ usually come from
          the acoustic sum rule or loose convergence (tr2_ph, ecutwfc, k/q grids); large ones indicate a dynamical
          instability of the structure.
        </Alert>
      )}
      {pdos?.note && (
        <Alert color="yellow" mb="xs">
          {pdos.note}
        </Alert>
      )}
      {pdos?.has_nan && !pdos.note && (
        <Alert color="yellow" mb="xs">
          The phonon DOS from matdyn.x contains NaN values and no q-grid frequency file was found to recompute it.
        </Alert>
      )}
      <Plot data={data} layout={layout} height={height} filename="phonons" />
      {phonon.ph && (
        <Text size="xs" c="dimmed">
          ph.x: {phonon.ph.q_points ?? '?'} q-points computed
          {phonon.ph.wall_time_s != null ? `, wall ${fmt(phonon.ph.wall_time_s, 1)} s` : ''}
          {phonon.ph.epsilon ? ' · dielectric tensor available' : ''}.
        </Text>
      )}
      {pdos?.integral != null && pdos.expected_integral != null && (
        <Text size="xs" c="dimmed">
          DOS integral {fmt(pdos.integral, 3)} (expected 3·nat = {pdos.expected_integral}); source:{' '}
          {pdos.source === 'qestudio' ? 'recomputed by QE Studio' : 'matdyn.x'}.
        </Text>
      )}
    </Card>
  );
}
