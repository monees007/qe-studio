import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Group,
  Loader,
  Menu,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useQueryClient } from '@tanstack/react-query';
import { IconCopy, IconDots, IconSearch, IconTrash } from '@tabler/icons-react';
import { apiGet, apiPost } from '../../api/client';
import { notifyError, qk, useDeleteStructure, useStructures } from '../../api/hooks';
import type { StructureRecord } from '../../api/types';

export function LibraryPanel({
  currentId,
  onOpen,
  height,
}: {
  currentId: string | null;
  onOpen: (rec: StructureRecord) => void;
  height: number | string;
}) {
  const { data, isLoading } = useStructures();
  const del = useDeleteStructure();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [opening, setOpening] = useState<string | null>(null);

  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data ?? []).filter(
      (r) =>
        !t ||
        r.name.toLowerCase().includes(t) ||
        r.formula.toLowerCase().includes(t) ||
        (r.spacegroup ?? '').toLowerCase().includes(t),
    );
  }, [data, q]);

  const open = async (id: string) => {
    setOpening(id);
    try {
      onOpen(await apiGet<StructureRecord>(`/api/structures/${id}`));
    } catch (e) {
      notifyError(e, 'Could not open structure');
    } finally {
      setOpening(null);
    }
  };

  const duplicate = async (id: string) => {
    try {
      const rec = await apiGet<StructureRecord>(`/api/structures/${id}`);
      await apiPost('/api/structures', { name: `${rec.name} (copy)`, structure: rec.structure, source: rec.source });
      qc.invalidateQueries({ queryKey: qk.structures });
    } catch (e) {
      notifyError(e, 'Duplicate failed');
    }
  };

  const confirmDelete = (r: StructureRecord) =>
    modals.openConfirmModal({
      title: 'Delete structure',
      children: <Text size="sm">Delete “{r.name}” from the library? This cannot be undone.</Text>,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => del.mutate(r.id),
    });

  return (
    <Stack gap="xs" h={height}>
      <TextInput
        size="xs"
        placeholder="Search name, formula, space group"
        leftSection={<IconSearch size={14} />}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      {isLoading && <Loader size="sm" />}
      <ScrollArea style={{ flex: 1 }} offsetScrollbars>
        <Stack gap={4}>
          {items.map((r) => (
            <Group
              key={r.id}
              gap={4}
              wrap="nowrap"
              p={6}
              style={{
                borderRadius: 6,
                border: '1px solid var(--mantine-color-default-border)',
                background: r.id === currentId ? 'var(--mantine-color-blue-light)' : undefined,
              }}
            >
              <UnstyledButton style={{ flex: 1, minWidth: 0 }} onClick={() => open(r.id)}>
                <Text size="sm" fw={500} truncate>
                  {r.name}
                </Text>
                <Group gap={4}>
                  <Text size="xs" c="dimmed">
                    {r.formula} · {r.natoms} at.
                  </Text>
                  {r.spacegroup && (
                    <Badge size="xs" variant="outline" tt="none">
                      {r.spacegroup}
                    </Badge>
                  )}
                  {opening === r.id && <Loader size={10} />}
                </Group>
              </UnstyledButton>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="subtle" size="sm" aria-label="Structure actions">
                    <IconDots size={14} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => duplicate(r.id)}>
                    Duplicate
                  </Menu.Item>
                  <Menu.Item leftSection={<IconTrash size={14} />} color="red" onClick={() => confirmDelete(r)}>
                    Delete
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          ))}
          {!isLoading && items.length === 0 && (
            <Text size="xs" c="dimmed" ta="center" py="md">
              {data?.length ? 'No match' : 'Library is empty'}
            </Text>
          )}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
