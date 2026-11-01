import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  CopyButton,
  Group,
  Loader,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { apiPost, errMsg } from '../../api/client';
import type { KPath, Structure, StructureAnalysis } from '../../api/types';

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={500}>
        {value}
      </Text>
    </div>
  );
}

export function SymmetryPanel({
  structure,
  symprec,
  setSymprec,
  analysis,
}: {
  structure: Structure;
  symprec: number;
  setSymprec: (v: number) => void;
  analysis: { data: StructureAnalysis | null; error: string | null; loading: boolean };
}) {
  const { data, error, loading } = analysis;
  const sym = data?.symmetry;
  const groups = useMemo(() => {
    if (!sym) return [];
    const m = new Map<number, number[]>();
    sym.equivalent_atoms.forEach((rep, i) => m.set(rep, [...(m.get(rep) ?? []), i]));
    return [...m.entries()].map(([rep, idx]) => ({
      rep,
      idx,
      wy: sym.wyckoffs[rep],
      label: structure.sites[rep]?.species,
    }));
  }, [sym, structure.sites]);

  return (
    <Stack gap="sm">
      <Group gap="xs" align="flex-end">
        <Select
          size="xs"
          w={140}
          label="Symmetry tolerance (Å)"
          value={String(symprec)}
          onChange={(v) => setSymprec(Number(v ?? 0.001))}
          data={['0.00001', '0.0001', '0.001', '0.01', '0.05', '0.1'].map((x) => ({
            value: String(Number(x)),
            label: x,
          }))}
        />
        {loading && <Loader size="xs" />}
      </Group>
      {error && (
        <Alert color="red" p="xs">
          {error}
        </Alert>
      )}
      {data && (
        <>
          <SimpleGrid cols={{ base: 2, md: 4 }} spacing="xs">
            <Stat label="Formula" value={`${data.formula} (${data.natoms} atoms)`} />
            <Stat
              label="Space group"
              value={
                sym ? (
                  <>
                    {sym.international}{' '}
                    <Badge size="xs" ml={4} tt="none">
                      #{sym.number}
                    </Badge>
                  </>
                ) : structure.pbc.every(Boolean) ? (
                  'not found'
                ) : (
                  'n/a (non-periodic)'
                )
              }
            />
            <Stat label="Crystal system" value={sym?.crystal_system ?? '—'} />
            <Stat label="Point group" value={sym?.pointgroup ?? '—'} />
            <Stat label="Hall symbol" value={sym?.hall ?? '—'} />
            <Stat label="Symmetry operations" value={sym?.n_operations ?? '—'} />
            <Stat label="Density" value={data.density != null ? `${data.density.toFixed(4)} g/cm³` : '—'} />
            <Stat
              label="Shortest distance"
              value={data.min_distance != null ? `${data.min_distance.toFixed(4)} Å` : '—'}
            />
          </SimpleGrid>
          {data.min_distance != null && data.min_distance < 0.7 && (
            <Alert color="red" p="xs">
              Atoms closer than 0.7 Å — probably overlapping or duplicated sites.
            </Alert>
          )}
          {groups.length > 0 && (
            <Table withTableBorder fz="xs" verticalSpacing={2}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Species</Table.Th>
                  <Table.Th>Wyckoff</Table.Th>
                  <Table.Th>Sites in this cell</Table.Th>
                  <Table.Th>Atoms</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {groups.map((g) => (
                  <Table.Tr key={g.rep}>
                    <Table.Td>{g.label}</Table.Td>
                    <Table.Td>{g.wy}</Table.Td>
                    <Table.Td>{g.idx.length}</Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace" lineClamp={1}>
                        {g.idx.map((i) => i + 1).join(', ')}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </>
      )}
      <KPathPreview structure={structure} />
    </Stack>
  );
}

function KPathPreview({ structure }: { structure: Structure }) {
  const [npoints, setNpoints] = useState(120);
  const [path, setPath] = useState('');
  const [kp, setKp] = useState<KPath | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const compute = async () => {
    setBusy(true);
    try {
      setKp(await apiPost<KPath>('/api/structures/kpath', { structure, npoints, path: path.trim() || null }));
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
      setKp(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs" mt="sm">
      <Text size="sm" fw={600}>
        Band-structure k-path (Setyawan–Curtarolo, via ASE)
      </Text>
      <Group gap="xs" align="flex-end">
        <NumberInput
          size="xs"
          w={110}
          label="Points (total)"
          min={10}
          max={2000}
          value={npoints}
          onChange={(v) => setNpoints(Number(v) || 120)}
        />
        <TextInput
          size="xs"
          w={200}
          label="Custom path (optional)"
          placeholder="e.g. GXWKGL,UX"
          value={path}
          onChange={(e) => setPath(e.currentTarget.value)}
        />
        <Button size="xs" variant="light" loading={busy} onClick={compute}>
          Compute path
        </Button>
      </Group>
      {err && (
        <Alert color="red" p="xs">
          {err}
        </Alert>
      )}
      {kp && (
        <>
          <Group gap="xs">
            <Text size="sm">Path:</Text>
            <Badge size="lg" variant="outline" ff="monospace" tt="none">
              {kp.path.replace(/G/g, 'Γ')}
            </Badge>
          </Group>
          <Table withTableBorder fz="xs" verticalSpacing={2}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Point</Table.Th>
                <Table.Th>k₁</Table.Th>
                <Table.Th>k₂</Table.Th>
                <Table.Th>k₃</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {Object.entries(kp.special_points).map(([k, v]) => (
                <Table.Tr key={k}>
                  <Table.Td fw={600}>{k === 'G' ? 'Γ' : k}</Table.Td>
                  {v.map((x, i) => (
                    <Table.Td key={i} ff="monospace">
                      {x.toFixed(5)}
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group gap={4}>
            <Text size="xs" c="dimmed">
              K_POINTS card (crystal coordinates of this cell):
            </Text>
            <CopyButton value={kp.card}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied' : 'Copy card'}>
                  <ActionIcon size="sm" variant="subtle" onClick={copy}>
                    {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
          <pre className="qes-log" style={{ maxHeight: 180, margin: 0 }}>
            {kp.card}
          </pre>
        </>
      )}
    </Stack>
  );
}
