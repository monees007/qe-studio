import { useMemo, useState } from 'react';
import { Alert, Card, Group, MultiSelect, NumberInput, SegmentedControl, Switch, Text, Title } from '@mantine/core';
import type { DosCurve, DosResult } from '../../api/types';
import { Plot } from '../../components/Plot';
import { PALETTE } from '../../lib/palette';
import { fmt } from '../../lib/format';

type Group_ = 'by_element' | 'by_orbital' | 'by_atom';

/** Total DOS (dos.x) and projected DOS (projwfc.x), spin-down mirrored, E_F at zero. */
export function DosPlot({ dos, height = 440 }: { dos: DosResult; height?: number }) {
  const ef = dos.fermi_energy_ev ?? dos.dos?.fermi_energy_ev ?? null;
  const pd = dos.pdos;
  const [group, setGroup] = useState<Group_>('by_element');
  const options = useMemo(() => (pd ? Object.keys(pd[group] ?? {}).sort() : []), [pd, group]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const sel = useMemo(
    () => selected ?? (group === 'by_atom' ? options.slice(0, 4) : options),
    [selected, group, options],
  );
  const [showTotal, setShowTotal] = useState(true);
  const [showInt, setShowInt] = useState(false);
  const [emin, setEmin] = useState<number>(-10);
  const [emax, setEmax] = useState<number>(6);
  const shift = ef ?? 0;

  const data = useMemo(() => {
    const d: any[] = [];
    const add = (name: string, E: number[], c: DosCurve, color: string, fill = false, width = 1.5) => {
      const x = E.map((e) => e - shift);
      if (c.dos) {
        d.push({
          type: 'scatter',
          mode: 'lines',
          name,
          x,
          y: c.dos,
          line: { color, width },
          fill: fill ? 'tozeroy' : undefined,
          fillcolor: fill ? 'rgba(128,128,128,0.18)' : undefined,
          hovertemplate: `${name}: %{y:.3f} states/eV<extra></extra>`,
        });
      } else {
        d.push({
          type: 'scatter',
          mode: 'lines',
          name: `${name} ↑`,
          x,
          y: c.up,
          line: { color, width },
          fill: fill ? 'tozeroy' : undefined,
          fillcolor: fill ? 'rgba(128,128,128,0.18)' : undefined,
          legendgroup: name,
          hovertemplate: `${name} ↑: %{y:.3f}<extra></extra>`,
        });
        d.push({
          type: 'scatter',
          mode: 'lines',
          name: `${name} ↓`,
          x,
          y: (c.down ?? []).map((v) => (v == null ? null : -v)),
          line: { color, width, dash: 'dot' },
          fill: fill ? 'tozeroy' : undefined,
          fillcolor: fill ? 'rgba(128,128,128,0.18)' : undefined,
          legendgroup: name,
          showlegend: false,
          hovertemplate: `${name} ↓: %{y:.3f}<extra></extra>`,
        });
      }
    };
    if (showTotal) {
      if (dos.dos) {
        const t = dos.dos;
        add(
          'total (dos.x)',
          t.energy_ev,
          t.spin ? { up: t.dos_up, down: t.dos_down } : { dos: t.dos },
          '#495057',
          true,
          1.8,
        );
        if (showInt && t.int_dos) {
          d.push({
            type: 'scatter',
            mode: 'lines',
            name: 'integrated',
            x: t.energy_ev.map((e) => e - shift),
            y: t.int_dos,
            yaxis: 'y2',
            line: { color: '#868e96', dash: 'dash', width: 1 },
            hovertemplate: 'N(E) = %{y:.3f}<extra></extra>',
          });
        }
      } else if (pd?.total && pd.energy_ev) {
        add('total (projwfc)', pd.energy_ev, pd.total, '#495057', true, 1.8);
      }
    }
    if (pd?.energy_ev) {
      sel.forEach((k, i) => {
        const c = pd[group]?.[k];
        if (c) add(k, pd.energy_ev!, c, PALETTE[i % PALETTE.length]);
      });
    }
    return d;
  }, [dos, pd, group, sel, showTotal, showInt, shift]);

  const spin = !!(dos.dos?.spin || pd?.spin);
  const layout = useMemo(() => {
    const l: any = {
      xaxis: {
        title: { text: ef !== null ? 'E − E<sub>F</sub> (eV)' : 'E (eV)' },
        range: ef !== null ? [emin, emax] : undefined,
      },
      yaxis: { title: { text: 'DOS (states/eV)' }, zeroline: true },
      legend: { orientation: 'h', y: -0.2 },
      margin: { l: 64, r: showInt ? 64 : 16, t: 16, b: 80 },
      shapes:
        ef !== null
          ? [
              {
                type: 'line',
                xref: 'x',
                yref: 'paper',
                x0: 0,
                x1: 0,
                y0: 0,
                y1: 1,
                line: { color: 'rgba(200,50,50,0.7)', dash: 'dash', width: 1 },
              },
            ]
          : [],
    };
    if (showInt) l.yaxis2 = { title: { text: 'electrons' }, overlaying: 'y', side: 'right', showgrid: false };
    return l;
  }, [ef, emin, emax, showInt]);

  return (
    <Card>
      <Group justify="space-between" mb="xs" wrap="wrap" align="flex-end">
        <Group gap="xs">
          <Title order={5}>Density of states</Title>
          {ef !== null && (
            <Text size="xs" c="dimmed">
              E<sub>F</sub> = {fmt(ef, 4)} eV
            </Text>
          )}
          {spin && (
            <Text size="xs" c="dimmed">
              spin ↓ drawn negative
            </Text>
          )}
        </Group>
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Switch size="xs" label="total" checked={showTotal} onChange={(e) => setShowTotal(e.currentTarget.checked)} />
          {dos.dos?.int_dos && (
            <Switch
              size="xs"
              label="integrated"
              checked={showInt}
              onChange={(e) => setShowInt(e.currentTarget.checked)}
            />
          )}
          {ef !== null && (
            <>
              <NumberInput
                size="xs"
                w={80}
                label="E min"
                value={emin}
                step={1}
                onChange={(v) => typeof v === 'number' && setEmin(v)}
              />
              <NumberInput
                size="xs"
                w={80}
                label="E max"
                value={emax}
                step={1}
                onChange={(v) => typeof v === 'number' && setEmax(v)}
              />
            </>
          )}
        </Group>
      </Group>
      {pd && (
        <Group gap="xs" mb="xs" align="flex-end" wrap="wrap">
          <SegmentedControl
            size="xs"
            value={group}
            onChange={(v) => {
              setGroup(v as Group_);
              setSelected(null);
            }}
            data={[
              { value: 'by_element', label: 'element' },
              { value: 'by_orbital', label: 'element + orbital' },
              { value: 'by_atom', label: 'atom' },
            ]}
          />
          <MultiSelect
            size="xs"
            style={{ flex: 1, minWidth: 240 }}
            placeholder="projections"
            data={options}
            value={sel}
            onChange={setSelected}
            searchable
            clearable
            maxDropdownHeight={260}
          />
        </Group>
      )}
      {dos.dos?.has_nan && (
        <Alert color="yellow" mb="xs">
          The DOS file contains NaN values (shown as gaps).
        </Alert>
      )}
      <Plot data={data} layout={layout} height={height} filename="dos" />
      {pd && (
        <Text size="xs" c="dimmed">
          PDOS from Löwdin projections (projwfc.x); their sum can be below the total DOS (spilling).
        </Text>
      )}
    </Card>
  );
}
