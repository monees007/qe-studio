import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Card,
  Group,
  List,
  Loader,
  NumberInput,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconFileAnalytics, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { apiUpload, errMsg } from '../api/client';
import type { BandsResult, DosResult, IonicStep, PhononResult, PwResult } from '../api/types';
import { AskAIButton, EmptyState } from '../components/common';
import { fmt, fmtDuration } from '../lib/format';
import { BandsPlot } from './results/BandsPlot';
import { DosPlot } from './results/DosPlot';
import { PhononPlot } from './results/PhononPlot';
import { PwSummary } from './results/PwSummary';
import { RelaxView } from './results/RelaxView';
import { ScfPlot } from './results/ScfPlot';
import { compactJson } from './results/util';

interface Item {
  id: string;
  name: string;
  size: number;
  status: 'loading' | 'ok' | 'error';
  data?: any;
  error?: string;
  tail?: string;
}

const TYPE_LABEL: Record<string, string> = {
  pw: 'pw.x output',
  xml: 'QE XML data file',
  dos: 'dos.x DOS',
  pdos: 'projwfc.x PDOS',
  phonon_freq: 'matdyn.x frequencies',
  phdos: 'phonon DOS',
  cube: 'cube volumetric data',
  bands_gnu: 'bands.x (gnuplot)',
  generic: 'QE program output',
};

function transpose(m: number[][]): number[][] {
  if (!m.length) return [];
  return m[0].map((_, k) => m.map((row) => row[k]));
}

function PdosView({ data }: { data: any }) {
  const [ef, setEf] = useState<number | ''>('');
  const dos: DosResult = { pdos: data, fermi_energy_ev: typeof ef === 'number' ? ef : null };
  return (
    <Stack gap="xs">
      <NumberInput
        size="xs"
        w={220}
        label="Fermi energy (eV) — from the SCF/NSCF output"
        value={ef}
        onChange={(v) => setEf(typeof v === 'number' ? v : '')}
        decimalScale={4}
      />
      <DosPlot dos={dos} />
    </Stack>
  );
}

function GnuBandsView({ data }: { data: any }) {
  const [ef, setEf] = useState<number | ''>('');
  const bands: BandsResult = {
    x: data.x,
    ticks: [],
    breaks: [],
    bands: [transpose(data.bands)],
    reference_ev: typeof ef === 'number' ? ef : null,
    reference_kind: 'fermi',
    source: 'bands.dat.gnu',
  };
  return (
    <Stack gap="xs">
      <NumberInput
        size="xs"
        w={220}
        label="Fermi energy / VBM (eV)"
        value={ef}
        onChange={(v) => setEf(typeof v === 'number' ? v : '')}
        decimalScale={4}
      />
      <BandsPlot key={String(ef)} bands={bands} />
      <Text size="xs" c="dimmed">
        bands.x .gnu files carry no high-symmetry labels; upload the band run's XML for gap detection.
      </Text>
    </Stack>
  );
}

function XmlView({ data }: { data: any }) {
  const b = data.bands;
  const ref = b ? (b.fermi_energy_ev ?? b.homo_ev ?? null) : null;
  const nk = b?.kpoints_2pi_alat?.length ?? 0;
  const bands: BandsResult | null =
    b && data.path && nk > 1
      ? {
          x: data.path.x,
          ticks: data.path.ticks ?? [],
          breaks: data.path.breaks ?? [],
          bands: b.eigenvalues_ev,
          reference_ev: ref,
          reference_kind: b.fermi_energy_ev != null ? 'fermi' : 'vbm',
          gap: data.gap,
          lsda: b.lsda,
          source: 'XML',
        }
      : null;
  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        {data.total_energy_ev ? (
          <div>
            <Text size="xs" c="dimmed">
              Total energy
            </Text>
            <Text size="sm" className="qes-mono">
              {fmt(data.total_energy_ev, 6)} eV
            </Text>
          </div>
        ) : null}
        {b?.fermi_energy_ev != null && (
          <div>
            <Text size="xs" c="dimmed">
              Fermi energy
            </Text>
            <Text size="sm" className="qes-mono">
              {fmt(b.fermi_energy_ev, 4)} eV
            </Text>
          </div>
        )}
        {b?.homo_ev != null && (
          <div>
            <Text size="xs" c="dimmed">
              HOMO / LUMO
            </Text>
            <Text size="sm" className="qes-mono">
              {fmt(b.homo_ev, 4)} / {fmt(b.lumo_ev ?? null, 4)} eV
            </Text>
          </div>
        )}
        {data.gap && (
          <div>
            <Text size="xs" c="dimmed">
              Gap (sampled k)
            </Text>
            <Text size="sm" className="qes-mono">
              {data.gap.metal ? 'metallic' : `${fmt(data.gap.gap_ev, 3)} eV ${data.gap.direct ? 'direct' : 'indirect'}`}
            </Text>
          </div>
        )}
        {data.total_magnetization != null && (
          <div>
            <Text size="xs" c="dimmed">
              Magnetization
            </Text>
            <Text size="sm" className="qes-mono">
              {fmt(data.total_magnetization, 3)} μB
            </Text>
          </div>
        )}
        {data.pressure_kbar != null && (
          <div>
            <Text size="xs" c="dimmed">
              Pressure
            </Text>
            <Text size="sm" className="qes-mono">
              {fmt(data.pressure_kbar, 2)} kbar
            </Text>
          </div>
        )}
        {data.calculation && (
          <div>
            <Text size="xs" c="dimmed">
              Calculation
            </Text>
            <Text size="sm">
              {data.calculation}
              {data.creator ? ` · ${data.creator}` : ''}
            </Text>
          </div>
        )}
        <div>
          <Text size="xs" c="dimmed">
            k-points
          </Text>
          <Text size="sm">{nk}</Text>
        </div>
      </SimpleGrid>
      {bands && <BandsPlot bands={bands} title="Eigenvalues along the k-point list" />}
    </Stack>
  );
}

function GenericView({ data }: { data: any }) {
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Badge color={data.status === 'done' ? 'teal' : data.status === 'error' ? 'red' : 'yellow'}>
          {data.status}
        </Badge>
        {data.version && <Badge variant="outline">v{data.version}</Badge>}
        {data.wall_time_s != null && <Text size="sm">wall {fmtDuration(data.wall_time_s)}</Text>}
        {data.q_points != null && <Text size="sm">{data.q_points} q-points</Text>}
      </Group>
      {data.errors?.length > 0 && (
        <Alert color="red">
          <List size="sm">
            {data.errors.map((e: string, i: number) => (
              <List.Item key={i}>{e}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {data.warnings?.length > 0 && (
        <Alert color="yellow">
          <List size="xs">
            {data.warnings.map((e: string, i: number) => (
              <List.Item key={i}>{e}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {data.gamma_frequencies_cm1?.length > 0 && (
        <Text size="sm" className="qes-mono">
          Frequencies (cm⁻¹): {data.gamma_frequencies_cm1.map((f: number) => f.toFixed(2)).join(', ')}
        </Text>
      )}
    </Stack>
  );
}

function ItemView({ item }: { item: Item }) {
  const d = item.data;
  switch (d?.type) {
    case 'pw': {
      const pw: PwResult = {
        summary: d.summary,
        scf: (d.scf ?? []) as IonicStep[],
        trajectory: d.trajectory ?? undefined,
      };
      return (
        <Stack gap="md">
          <PwSummary pw={pw} />
          {(pw.trajectory?.length ?? 0) > 1 && <RelaxView pw={pw} name={item.name.replace(/\.[^.]+$/, '')} />}
          <ScfPlot steps={pw.scf} />
        </Stack>
      );
    }
    case 'xml':
      return <XmlView data={d} />;
    case 'dos':
      return <DosPlot dos={{ dos: d, fermi_energy_ev: d.fermi_energy_ev }} />;
    case 'pdos':
      return <PdosView data={d} />;
    case 'phonon_freq': {
      const ph: PhononResult = {
        dispersion: { x: d.x, ticks: [], breaks: [], freq_cm1: d.freq_cm1, min_freq_cm1: d.min_freq_cm1 },
        imaginary_modes: d.min_freq_cm1 < -5,
      };
      return <PhononPlot phonon={ph} />;
    }
    case 'phdos':
      return <PhononPlot phonon={{ dos: d }} />;
    case 'bands_gnu':
      return <GnuBandsView data={d} />;
    case 'cube':
      return (
        <Stack gap="xs">
          <Table withTableBorder fz="sm" className="qes-mono" w={420}>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td>grid</Table.Td>
                <Table.Td>{d.shape.join(' × ')}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>min / max</Table.Td>
                <Table.Td>
                  {fmt(d.stats.min, 6)} / {fmt(d.stats.max, 6)}
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>mean</Table.Td>
                <Table.Td>{fmt(d.stats.mean, 6)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>∫ over cell</Table.Td>
                <Table.Td>{fmt(d.stats.integral, 4)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>suggested isovalues</Table.Td>
                <Table.Td>{d.levels.map((l: number) => l.toExponential(2)).join(', ')}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
          <Text size="xs" c="dimmed">
            3D isosurfaces are available for cube files produced by a “Charge density” workflow job (Jobs → Results).
          </Text>
        </Stack>
      );
    default:
      return <GenericView data={d ?? {}} />;
  }
}

/** Analyse QE output files uploaded from disk (no job needed). */
export default function Analysis() {
  const [items, setItems] = useState<Item[]>([]);

  const onDrop = (files: File[]) => {
    for (const f of files) {
      const id = `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`;
      setItems((it) => [{ id, name: f.name, size: f.size, status: 'loading' }, ...it]);
      const fd = new FormData();
      fd.append('file', f);
      const tailP =
        f.size < 200e6
          ? f
              .slice(Math.max(0, f.size - 60_000))
              .text()
              .catch(() => '')
          : Promise.resolve('');
      apiUpload<any>('/api/analysis/parse', fd)
        .then(async (data) => {
          const tail = await tailP;
          setItems((it) => it.map((x) => (x.id === id ? { ...x, status: 'ok', data, tail } : x)));
        })
        .catch((e) => setItems((it) => it.map((x) => (x.id === id ? { ...x, status: 'error', error: errMsg(e) } : x))));
    }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={3}>Analyze outputs</Title>
        {items.length > 0 && (
          <Tooltip label="Clear all">
            <ActionIcon variant="default" onClick={() => setItems([])}>
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      <Dropzone onDrop={onDrop} maxSize={500 * 1024 * 1024} multiple>
        <Group justify="center" gap="xl" mih={120} style={{ pointerEvents: 'none' }}>
          <Dropzone.Accept>
            <IconUpload size={42} stroke={1.5} />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX size={42} stroke={1.5} />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconFileAnalytics size={42} stroke={1.5} />
          </Dropzone.Idle>
          <div>
            <Text size="lg">Drop QE output files here or click to select</Text>
            <Text size="sm" c="dimmed" mt={6}>
              pw.x output (.out), prefix.xml / data-file-schema.xml, dos.x .dos, projwfc.x .pdos_* files, matdyn .freq /
              phonon DOS, bands.x .gnu, pp.x .cube, ph.x / other program outputs. Files are parsed by the local backend.
            </Text>
          </div>
        </Group>
      </Dropzone>
      {items.length === 0 && (
        <Card>
          <EmptyState title="Nothing analysed yet">
            Results of jobs run from QE Studio are analysed automatically on each job's Results tab; use this page for
            files from elsewhere.
          </EmptyState>
        </Card>
      )}
      {items.map((it) => (
        <Card key={it.id}>
          <Group justify="space-between" mb="sm">
            <Group gap="xs">
              <Text fw={600} className="qes-mono">
                {it.name}
              </Text>
              {it.data?.type && <Badge>{TYPE_LABEL[it.data.type] ?? it.data.type}</Badge>}
              <Text size="xs" c="dimmed">
                {(it.size / 1024).toFixed(1)} kB
              </Text>
            </Group>
            <Group gap="xs">
              {it.status === 'ok' && (
                <AskAIButton
                  context={() => [
                    { kind: 'analysis', title: `parsed ${it.name}`, content: compactJson(it.data) },
                    ...(it.tail ? [{ kind: 'output' as const, title: `${it.name} (tail)`, content: it.tail }] : []),
                  ]}
                  prompt="Interpret this output. Is the calculation converged and are the results physically reasonable?"
                />
              )}
              <ActionIcon
                variant="subtle"
                onClick={() => setItems((x) => x.filter((y) => y.id !== it.id))}
                aria-label="Remove"
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
          </Group>
          {it.status === 'loading' && (
            <Group gap="xs">
              <Loader size="sm" />
              <Text size="sm">Parsing…</Text>
            </Group>
          )}
          {it.status === 'error' && (
            <Alert color="red" title="Could not parse">
              {it.error}
            </Alert>
          )}
          {it.status === 'ok' && <ItemView item={it} />}
        </Card>
      ))}
    </Stack>
  );
}
