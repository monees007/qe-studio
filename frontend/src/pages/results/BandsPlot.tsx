import { useMemo, useState } from 'react';
import { Badge, Card, Group, NumberInput, Text, Title } from '@mantine/core';
import type { BandsResult } from '../../api/types';
import { Plot } from '../../components/Plot';
import { fmt } from '../../lib/format';
import { finiteMax, finiteMin, joinSeries, tickShapes } from './util';

/** Electronic band structure along a k-path (E − E_ref), both spin channels, gap annotation. */
export function BandsPlot({
  bands,
  title = 'Band structure',
  height = 480,
}: {
  bands: BandsResult;
  title?: string;
  height?: number;
}) {
  const ref = bands.reference_ev ?? 0;
  const hasRef = bands.reference_ev !== null && bands.reference_ev !== undefined;
  const allE = useMemo(() => bands.bands.flat(2) as number[], [bands]);
  const lo = (finiteMin(allE) ?? 0) - ref;
  const hi = (finiteMax(allE) ?? 0) - ref;
  const [emin, setEmin] = useState<number>(hasRef ? Math.max(Math.floor(lo - 0.5), -20) : Math.floor(lo - 0.5));
  const [emax, setEmax] = useState<number>(hasRef ? Math.min(Math.ceil(hi + 0.5), 10) : Math.ceil(hi + 0.5));

  const data = useMemo(() => {
    const d: any[] = [];
    const spinNames = bands.bands.length > 1 ? ['spin ↑', 'spin ↓'] : ['bands'];
    const colors = ['#1c7ed6', '#e03131'];
    bands.bands.forEach((spin, s) => {
      const j = joinSeries(bands.x, spin, bands.breaks ?? [], ref);
      d.push({
        type: 'scatter',
        mode: 'lines',
        name: spinNames[s],
        x: j.x,
        y: j.y,
        line: { color: colors[s % 2], width: 1.6, dash: s === 1 ? 'dash' : 'solid' },
        connectgaps: false,
        hovertemplate: 'E − E<sub>ref</sub> = %{y:.3f} eV<extra>' + spinNames[s] + '</extra>',
      });
    });
    const g = bands.gap;
    if (g && !g.metal && g.vbm_ev != null && g.cbm_ev != null) {
      // locate band extrema on the path for markers
      const flat = (e: number) => {
        let bestK = -1;
        let bestD = Infinity;
        bands.bands.forEach((spin) =>
          spin.forEach((row, k) =>
            row.forEach((v) => {
              const dd = Math.abs(v - e);
              if (dd < bestD) {
                bestD = dd;
                bestK = k;
              }
            }),
          ),
        );
        return bestK;
      };
      const kv = flat(g.vbm_ev);
      const kc = flat(g.cbm_ev);
      if (kv >= 0 && kc >= 0) {
        d.push({
          type: 'scatter',
          mode: 'markers',
          name: 'VBM / CBM',
          x: [bands.x[kv], bands.x[kc]],
          y: [g.vbm_ev - ref, g.cbm_ev - ref],
          marker: {
            size: 9,
            color: ['#2b8a3e', '#f08c00'],
            symbol: ['triangle-up', 'triangle-down'],
            line: { width: 1, color: '#000' },
          },
          hovertemplate: '%{y:.3f} eV<extra></extra>',
        });
      }
    }
    return d;
  }, [bands, ref]);

  const layout = useMemo(() => {
    const ticks = bands.ticks ?? [];
    const yLabel = !hasRef
      ? 'E (eV)'
      : bands.reference_kind === 'vbm'
        ? 'E − E<sub>VBM</sub> (eV)'
        : 'E − E<sub>F</sub> (eV)';
    return {
      xaxis: {
        tickvals: ticks.map((t) => t.x),
        ticktext: ticks.map((t) => t.label),
        showgrid: false,
        zeroline: false,
        range: [bands.x[0] ?? 0, bands.x[bands.x.length - 1] ?? 1],
        ticks: '',
      },
      yaxis: { title: { text: yLabel }, range: [emin, emax], zeroline: false },
      shapes: tickShapes(ticks, hasRef),
      showlegend: bands.bands.length > 1,
      legend: { orientation: 'h', y: 1.06 },
      margin: { l: 64, r: 16, t: 24, b: 40 },
    } as any;
  }, [bands, emin, emax, hasRef]);

  const g = bands.gap;
  return (
    <Card>
      <Group justify="space-between" mb={4} wrap="wrap">
        <Group gap="xs">
          <Title order={5}>{title}</Title>
          {g &&
            (g.metal ? (
              <Badge color="gray">metallic</Badge>
            ) : (
              <Badge color="teal" tt="none">
                E<sub>g</sub> = {fmt(g.gap_ev, 3)} eV {g.direct ? '(direct)' : '(indirect)'}
              </Badge>
            ))}
          {g && !g.metal && !g.direct && g.direct_gap_ev != null && (
            <Badge color="gray" variant="outline" tt="none">
              direct {fmt(g.direct_gap_ev, 3)} eV
            </Badge>
          )}
        </Group>
        <Group gap="xs">
          <NumberInput
            size="xs"
            w={90}
            label="E min"
            value={emin}
            step={1}
            onChange={(v) => typeof v === 'number' && setEmin(v)}
          />
          <NumberInput
            size="xs"
            w={90}
            label="E max"
            value={emax}
            step={1}
            onChange={(v) => typeof v === 'number' && setEmax(v)}
          />
        </Group>
      </Group>
      <Plot data={data} layout={layout} height={height} filename="band-structure" />
      <Text size="xs" c="dimmed">
        {hasRef
          ? `Reference ${bands.reference_kind === 'vbm' ? 'VBM' : 'Fermi level'} = ${fmt(ref, 4)} eV (from the SCF run). `
          : ''}
        Gap from the path eigenvalues; band edges off the path are not sampled. Source: {bands.source}.
      </Text>
    </Card>
  );
}
