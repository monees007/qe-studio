import { useEffect, useState } from 'react';
import { Button, Checkbox, Group, SimpleGrid, Stack, Switch, Table, Text, Tooltip } from '@mantine/core';
import type { Structure, Vec3 } from '../../api/types';
import { NumField } from './NumField';
import { cellFromParams, det, latticeParams, type Mat3 } from './geometry';

export function LatticePanel({
  structure,
  onTransform,
  onChange,
  busy,
}: {
  structure: Structure;
  onTransform: (op: string, params: Record<string, unknown>) => void;
  onChange: (s: Structure) => void;
  busy: boolean;
}) {
  const [cell, setCell] = useState<Mat3>(structure.cell as Mat3);
  const [scaleAtoms, setScaleAtoms] = useState(true);
  useEffect(() => setCell(structure.cell as Mat3), [structure.cell]);
  const lp = latticeParams(structure.cell as Mat3);
  const [params, setParams] = useState(lp);
  useEffect(() => setParams(latticeParams(structure.cell as Mat3)), [structure.cell]);

  const dirty = JSON.stringify(cell) !== JSON.stringify(structure.cell);
  const valid = Math.abs(det(cell)) > 1e-6;
  const setEl = (i: number, j: number, v: number | null) => {
    if (v === null) return;
    const c = cell.map((r) => [...r]) as Mat3;
    (c[i] as Vec3)[j] = v;
    setCell(c);
  };

  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 3, md: 7 }} spacing={6}>
        {(['a', 'b', 'c', 'alpha', 'beta', 'gamma'] as const).map((k) => (
          <NumField
            key={k}
            size="xs"
            label={k.length > 1 ? `${k} (°)` : `${k} (Å)`}
            value={params[k]}
            digits={5}
            onCommit={(v) => v !== null && setParams((p) => ({ ...p, [k]: v }))}
          />
        ))}
        <div>
          <Text size="xs" fw={500}>
            Volume
          </Text>
          <Text size="sm" ff="monospace" mt={6}>
            {lp.volume.toFixed(3)} Å³
          </Text>
        </div>
      </SimpleGrid>
      <Group gap="xs">
        <Tooltip label="Rebuild the cell from a,b,c,α,β,γ in the standard orientation (a ∥ x, b in the xy plane)">
          <Button
            size="xs"
            variant="light"
            loading={busy}
            disabled={JSON.stringify(params) === JSON.stringify(lp)}
            onClick={() => onTransform('set_cell', { cell: cellFromParams(params), scale_atoms: scaleAtoms })}
          >
            Apply lattice parameters
          </Button>
        </Tooltip>
        <Switch
          size="xs"
          label="Scale atoms with cell"
          checked={scaleAtoms}
          onChange={(e) => setScaleAtoms(e.currentTarget.checked)}
        />
      </Group>
      <Text size="sm" fw={600} mt="xs">
        Lattice vectors (Å, rows)
      </Text>
      <Table withTableBorder verticalSpacing={2} fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={30} />
            <Table.Th>x</Table.Th>
            <Table.Th>y</Table.Th>
            <Table.Th>z</Table.Th>
            <Table.Th w={70}>|v|</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {cell.map((row, i) => (
            <Table.Tr key={i}>
              <Table.Td fw={600}>{'abc'[i]}</Table.Td>
              {row.map((v, j) => (
                <Table.Td key={j}>
                  <NumField size="xs" value={v} digits={6} onCommit={(x) => setEl(i, j, x)} />
                </Table.Td>
              ))}
              <Table.Td>
                <Text size="xs" ff="monospace">
                  {Math.hypot(...row).toFixed(4)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group gap="xs">
        <Button
          size="xs"
          disabled={!dirty || !valid}
          loading={busy}
          onClick={() => onTransform('set_cell', { cell, scale_atoms: scaleAtoms })}
        >
          Apply vectors
        </Button>
        <Button size="xs" variant="default" disabled={!dirty} onClick={() => setCell(structure.cell as Mat3)}>
          Revert
        </Button>
        {!valid && (
          <Text size="xs" c="red">
            Cell is singular
          </Text>
        )}
      </Group>
      <Text size="sm" fw={600} mt="xs">
        Periodicity
      </Text>
      <Group gap="md">
        {[0, 1, 2].map((ax) => (
          <Checkbox
            key={ax}
            size="xs"
            label={`periodic along ${'abc'[ax]}`}
            checked={structure.pbc[ax]}
            onChange={(e) => {
              const pbc = [...structure.pbc] as [boolean, boolean, boolean];
              pbc[ax] = e.currentTarget.checked;
              onChange({ ...structure, pbc });
            }}
          />
        ))}
      </Group>
      <Text size="xs" c="dimmed">
        QE always uses 3D periodic boundary conditions; non-periodic axes only affect display, k-meshes (1 point) and 2D
        settings (assume_isolated='2D' for slabs periodic in a,b).
      </Text>
    </Stack>
  );
}
