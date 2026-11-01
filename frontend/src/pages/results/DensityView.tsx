import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Card,
  Grid,
  Group,
  Loader,
  NumberInput,
  Slider,
  Stack,
  Switch,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { apiPost, errMsg } from '../../api/client';
import type { DensityResult, Isosurface } from '../../api/types';
import { CrystalViewer, type ViewerMesh } from '../../components/CrystalViewer';
import { fmt } from '../../lib/format';
import { structureFromCube } from './util';

interface IsoResponse {
  positive: Isosurface;
  negative?: Isosurface;
  cell: number[][];
  origin: number[];
  atoms: { z: number; xyz: number[] }[];
  stats: DensityResult['stats'];
}

const PLOT_NUM: Record<number, string> = {
  0: 'electron (pseudo-)charge density',
  1: 'total potential',
  2: 'local ionic potential',
  4: 'local DOS',
  5: 'STM image',
  6: 'spin polarization (ρ↑ − ρ↓)',
  7: '|ψ|² of selected states',
  8: 'electron localization function',
  9: 'charge density minus superposition of atomic densities',
  10: 'integrated local DOS',
  11: 'bare + Hartree potential',
  17: 'all-electron valence density (PAW)',
  21: 'all-electron charge density (PAW)',
};

/** Isosurfaces of a pp.x cube file rendered over the structure. */
export function DensityView({ density, jobId }: { density: DensityResult; jobId: string }) {
  const st = density.stats;
  const signed = st.min < 0 && Math.abs(st.min) > 1e-3 * Math.abs(st.max);
  const vmax = Math.max(Math.abs(st.max), Math.abs(st.min)) || 1;
  const vmin = vmax * 1e-3;
  const [level, setLevel] = useState<number>(density.levels[1] ?? density.levels[0] ?? vmax / 4);
  const [both, setBoth] = useState<boolean>(signed);
  const [iso, setIso] = useState<IsoResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // slider works in log10 space between vmin and vmax
  const logV = Math.log10(Math.max(Math.abs(level), vmin));
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setBusy(true);
      setErr(null);
      apiPost<IsoResponse>(
        '/api/analysis/isosurface',
        { job_id: jobId, file: density.file, level: Math.abs(level), both_signs: both },
        ctrl.signal,
      )
        .then(setIso)
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') setErr(errMsg(e));
        })
        .finally(() => setBusy(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [jobId, density.file, level, both]);

  const structure = useMemo(
    () => structureFromCube(iso?.atoms ?? density.atoms, iso?.cell ?? density.cell),
    [iso, density],
  );
  const meshes = useMemo<ViewerMesh[]>(() => {
    const m: ViewerMesh[] = [];
    if (iso?.positive?.faces.length) m.push({ ...iso.positive, color: '#f59f00', opacity: 0.55 });
    if (iso?.negative?.faces.length) m.push({ ...iso.negative, color: '#1c7ed6', opacity: 0.55 });
    return m;
  }, [iso]);

  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Title order={5}>Volumetric data</Title>
        <Text size="xs" c="dimmed">
          {density.file} · grid {density.shape.join('×')}
          {density.stride > 1 ? ` (downsampled ×${density.stride})` : ''}
        </Text>
      </Group>
      <Grid>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <div style={{ position: 'relative' }}>
            <CrystalViewer structure={structure} meshes={meshes} height={440} toolbar showBonds />
            {busy && <Loader size="sm" style={{ position: 'absolute', top: 10, right: 10 }} />}
          </div>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="sm">
            {density.plot_num != null && (
              <Text size="sm">
                plot_num = {density.plot_num}: {PLOT_NUM[density.plot_num] ?? 'see pp.x documentation'}
              </Text>
            )}
            <div>
              <Text size="sm" fw={500}>
                Isovalue
              </Text>
              <Slider
                min={Math.log10(vmin)}
                max={Math.log10(vmax)}
                step={0.01}
                value={logV}
                label={(v) => (10 ** v).toExponential(2)}
                onChange={(v) => setLevel(10 ** v)}
                mt={6}
              />
              <NumberInput
                size="xs"
                mt={6}
                value={level}
                decimalScale={6}
                step={level / 10}
                min={0}
                onChange={(v) => typeof v === 'number' && v > 0 && setLevel(v)}
              />
              <Group gap={6} mt={4}>
                {density.levels.map((l, i) => (
                  <Text key={i} size="xs" c="blue" style={{ cursor: 'pointer' }} onClick={() => setLevel(l)}>
                    {['50%', '75%', '90%', '97%'][i] ?? ''} {l.toExponential(2)}
                  </Text>
                ))}
              </Group>
            </div>
            <Switch
              label="Show ± isosurfaces (signed data, e.g. spin density)"
              checked={both}
              onChange={(e) => setBoth(e.currentTarget.checked)}
            />
            {err && <Alert color="red">{err}</Alert>}
            {iso && iso.positive.faces.length === 0 && !iso.negative?.faces.length && (
              <Alert color="yellow">No surface at this isovalue (outside the data range).</Alert>
            )}
            <Table withTableBorder fz="xs" className="qes-mono">
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td>min</Table.Td>
                  <Table.Td>{fmt(st.min, 6)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>max</Table.Td>
                  <Table.Td>{fmt(st.max, 6)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>mean</Table.Td>
                  <Table.Td>{fmt(st.mean, 6)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>∫ over cell</Table.Td>
                  <Table.Td>
                    {fmt(st.integral, 4)}
                    {density.plot_num === 0 ? ' electrons' : ''}
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
            <Text size="xs" c="dimmed">
              Cube values are in atomic units (e/bohr³ for densities). Surfaces are computed with marching cubes on the
              periodic grid.
            </Text>
          </Stack>
        </Grid.Col>
      </Grid>
    </Card>
  );
}
