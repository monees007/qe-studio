import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Autocomplete,
  Button,
  Checkbox,
  Group,
  Pagination,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { Structure, Vec3 } from '../../api/types';
import { SYMBOLS } from '../../lib/elements';
import { NumField } from './NumField';
import { clone, ensureSpecies, toCart, toFrac, type Mat3 } from './geometry';

const PAGE = 50;

export function AtomsTable({
  structure,
  onChange,
  selected,
  onSelect,
}: {
  structure: Structure;
  onChange: (s: Structure) => void;
  selected: number[];
  onSelect: (sel: number[]) => void;
}) {
  const [mode, setMode] = useState<'frac' | 'cart'>('frac');
  const [page, setPage] = useState(1);
  const [newLabel, setNewLabel] = useState('');
  const cell = structure.cell as Mat3;
  const n = structure.sites.length;
  const pages = Math.max(1, Math.ceil(n / PAGE));
  const curPage = Math.min(page, pages);
  const selSet = useMemo(() => new Set(selected), [selected]);
  const labels = useMemo(() => {
    const own = Object.keys(structure.species);
    return [...own, ...SYMBOLS.slice(1).filter((s) => !own.includes(s))];
  }, [structure.species]);

  const coords = (i: number): Vec3 => (mode === 'frac' ? toFrac(structure.sites[i].xyz, cell) : structure.sites[i].xyz);

  const setCoord = (i: number, ax: number, v: number) => {
    const s = clone(structure);
    const c = coords(i);
    c[ax] = v;
    s.sites[i].xyz = mode === 'frac' ? toCart(c, cell) : c;
    onChange(s);
  };

  const setSpecies = (i: number, label: string) => {
    const t = label.trim();
    if (!t || t === structure.sites[i].species) return;
    const s = clone(structure);
    s.sites[i].species = t;
    onChange(ensureSpecies(s));
  };

  const setFixed = (i: number, ax: number, v: boolean) => {
    const s = clone(structure);
    const f = [...(s.sites[i].fixed ?? [false, false, false])] as [boolean, boolean, boolean];
    f[ax] = v;
    s.sites[i].fixed = f;
    onChange(s);
  };

  const remove = (idx: number[]) => {
    const drop = new Set(idx);
    const s = clone(structure);
    s.sites = s.sites.filter((_, i) => !drop.has(i));
    onSelect([]);
    onChange(ensureSpecies(s));
  };

  const addAtom = () => {
    const label = newLabel.trim() || Object.keys(structure.species)[0] || 'H';
    const s = clone(structure);
    s.sites.push({ species: label, xyz: toCart([0.5, 0.5, 0.5], cell), fixed: [false, false, false] });
    onChange(ensureSpecies(s));
    setPage(Math.ceil(s.sites.length / PAGE));
    onSelect([s.sites.length - 1]);
  };

  const toggle = (i: number) => onSelect(selSet.has(i) ? selected.filter((x) => x !== i) : [...selected, i]);
  const start = (curPage - 1) * PAGE;
  const rows = structure.sites.slice(start, start + PAGE);
  const allOnPage = rows.length > 0 && rows.every((_, k) => selSet.has(start + k));

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="wrap">
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(v) => setMode(v as 'frac' | 'cart')}
          data={[
            { value: 'frac', label: 'Fractional' },
            { value: 'cart', label: 'Cartesian (Å)' },
          ]}
        />
        <Group gap={6}>
          <Autocomplete
            size="xs"
            w={90}
            placeholder="label"
            data={labels.slice(0, 120)}
            value={newLabel}
            onChange={setNewLabel}
            limit={20}
          />
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={addAtom}>
            Add atom
          </Button>
          <Button
            size="xs"
            variant="light"
            color="red"
            leftSection={<IconTrash size={14} />}
            disabled={!selected.length}
            onClick={() => remove(selected)}
          >
            Delete {selected.length || ''}
          </Button>
        </Group>
      </Group>
      <Table.ScrollContainer minWidth={620}>
        <Table striped highlightOnHover withTableBorder verticalSpacing={2} horizontalSpacing={6} fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={28}>
                <Checkbox
                  size="xs"
                  checked={allOnPage}
                  aria-label="Select page"
                  onChange={() =>
                    onSelect(
                      allOnPage
                        ? selected.filter((x) => x < start || x >= start + rows.length)
                        : [...new Set([...selected, ...rows.map((_, k) => start + k)])],
                    )
                  }
                />
              </Table.Th>
              <Table.Th w={40}>#</Table.Th>
              <Table.Th w={90}>Species</Table.Th>
              <Table.Th>{mode === 'frac' ? 'a' : 'x'}</Table.Th>
              <Table.Th>{mode === 'frac' ? 'b' : 'y'}</Table.Th>
              <Table.Th>{mode === 'frac' ? 'c' : 'z'}</Table.Th>
              <Table.Th w={84}>
                <Tooltip label="Fixed coordinates in relaxations (if_pos = 0)">
                  <span>Fixed x y z</span>
                </Tooltip>
              </Table.Th>
              <Table.Th w={30} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((site, k) => {
              const i = start + k;
              const c = coords(i);
              return (
                <Table.Tr key={i} bg={selSet.has(i) ? 'var(--mantine-color-yellow-light)' : undefined}>
                  <Table.Td>
                    <Checkbox
                      size="xs"
                      checked={selSet.has(i)}
                      onChange={() => toggle(i)}
                      aria-label={`select ${i + 1}`}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {i + 1}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Autocomplete
                      size="xs"
                      data={labels.slice(0, 120)}
                      defaultValue={site.species}
                      key={`${i}-${site.species}`}
                      limit={20}
                      onBlur={(e) => setSpecies(i, e.currentTarget.value)}
                      onOptionSubmit={(v) => setSpecies(i, v)}
                    />
                  </Table.Td>
                  {[0, 1, 2].map((ax) => (
                    <Table.Td key={ax}>
                      <NumField
                        size="xs"
                        value={c[ax]}
                        digits={mode === 'frac' ? 6 : 5}
                        onCommit={(v) => v !== null && setCoord(i, ax, v)}
                      />
                    </Table.Td>
                  ))}
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      {[0, 1, 2].map((ax) => (
                        <Checkbox
                          key={ax}
                          size="xs"
                          checked={!!site.fixed?.[ax]}
                          onChange={(e) => setFixed(i, ax, e.currentTarget.checked)}
                          aria-label={`fix ${'xyz'[ax]}`}
                        />
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      onClick={() => remove([i])}
                      aria-label="Delete atom"
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {pages > 1 && (
        <Group justify="center">
          <Pagination size="sm" total={pages} value={curPage} onChange={setPage} />
        </Group>
      )}
      <Text size="xs" c="dimmed">
        {n} atoms · click atoms in the viewer (Shift = add to selection) to select rows.
      </Text>
    </Stack>
  );
}
