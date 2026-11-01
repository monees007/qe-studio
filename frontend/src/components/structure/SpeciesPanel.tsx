import { Alert, Badge, Group, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { usePseudos } from '../../api/hooks';
import type { Structure } from '../../api/types';
import { MASSES, Z, labelToElement } from '../../lib/elements';
import { NumField } from './NumField';
import { clone, speciesOrder } from './geometry';

export function SpeciesPanel({ structure, onChange }: { structure: Structure; onChange: (s: Structure) => void }) {
  const { data: lib } = usePseudos();
  const order = speciesOrder(structure);
  const counts = new Map<string, number>();
  structure.sites.forEach((s) => counts.set(s.species, (counts.get(s.species) ?? 0) + 1));

  const set = (label: string, key: 'mass' | 'magnetization' | 'hubbard_u' | 'pseudo', v: number | string | null) => {
    const s = clone(structure);
    s.species[label] = { ...s.species[label], [key]: v };
    onChange(s);
  };

  const rename = (oldL: string, newL: string) => {
    const t = newL.trim();
    if (!t || t === oldL) return;
    if (structure.species[t]) return; // would merge species; use the atoms table for that
    if (labelToElement(t) === 'X') return;
    const s = clone(structure);
    const info = s.species[oldL];
    delete s.species[oldL];
    s.species[t] = { ...info, element: labelToElement(t) };
    s.sites.forEach((site) => {
      if (site.species === oldL) site.species = t;
    });
    onChange(s);
  };

  const missingPseudo = order.filter((l) => {
    const sp = structure.species[l];
    if (sp?.pseudo) return false;
    return !(lib?.pseudos ?? []).some((p) => p.element === sp?.element);
  });

  return (
    <Stack gap="xs">
      <Table.ScrollContainer minWidth={720}>
        <Table withTableBorder verticalSpacing={4} fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Label</Table.Th>
              <Table.Th>Element</Table.Th>
              <Table.Th>Atoms</Table.Th>
              <Table.Th>Mass (amu)</Table.Th>
              <Table.Th>
                <Tooltip label="QE starting_magnetization(i): fraction of valence charge, -1 … 1. Non-zero enables a spin-polarized run.">
                  <span>Start. magnetization</span>
                </Tooltip>
              </Table.Th>
              <Table.Th>
                <Tooltip label="Hubbard U (eV) written to the HUBBARD card (QE ≥ 7.1)">
                  <span>Hubbard U (eV)</span>
                </Tooltip>
              </Table.Th>
              <Table.Th miw={220}>Pseudopotential</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {order.map((label) => {
              const sp = structure.species[label] ?? { element: labelToElement(label) };
              const options = (lib?.pseudos ?? [])
                .filter((p) => p.element === sp.element)
                .map((p) => ({
                  value: p.filename,
                  label: `${p.filename}${p.type ? ` (${p.type})` : ''}${p.is_default ? ' ★' : ''}`,
                }));
              if (sp.pseudo && !options.some((o) => o.value === sp.pseudo))
                options.unshift({ value: sp.pseudo, label: `${sp.pseudo} (not in library)` });
              return (
                <Table.Tr key={label}>
                  <Table.Td>
                    <Tooltip label="Rename the species label (e.g. Fe → Fe1 to create a distinct magnetic sublattice)">
                      <TextInput
                        size="xs"
                        w={80}
                        defaultValue={label}
                        key={label}
                        onBlur={(e) => rename(label, e.currentTarget.value)}
                        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
                      />
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="outline" size="sm" tt="none">
                      {sp.element}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{counts.get(label) ?? 0}</Table.Td>
                  <Table.Td w={110}>
                    <NumField
                      size="xs"
                      digits={4}
                      value={sp.mass ?? MASSES[Z[sp.element] ?? 0]}
                      onCommit={(v) => set(label, 'mass', v)}
                      allowEmpty
                    />
                  </Table.Td>
                  <Table.Td w={120}>
                    <NumField
                      size="xs"
                      digits={3}
                      value={sp.magnetization ?? null}
                      placeholder="0"
                      allowEmpty
                      onCommit={(v) => set(label, 'magnetization', v === null ? null : Math.max(-1, Math.min(1, v)))}
                    />
                  </Table.Td>
                  <Table.Td w={110}>
                    <NumField
                      size="xs"
                      digits={3}
                      value={sp.hubbard_u ?? null}
                      placeholder="—"
                      allowEmpty
                      onCommit={(v) => set(label, 'hubbard_u', v)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Select
                      size="xs"
                      data={options}
                      value={sp.pseudo ?? null}
                      clearable
                      placeholder={options.length ? 'library default' : 'none in library'}
                      onChange={(v) => set(label, 'pseudo', v)}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {missingPseudo.length > 0 && (
        <Alert color="yellow" p="xs">
          <Text size="xs">
            No pseudopotential in your library for: {missingPseudo.map((l) => structure.species[l]?.element).join(', ')}
            . Upload one on the Pseudopotentials page before running.
          </Text>
        </Alert>
      )}
      <Group gap={6}>
        <Text size="xs" c="dimmed">
          Empty pseudopotential = use the library default for the element when generating inputs.
        </Text>
      </Group>
    </Stack>
  );
}
