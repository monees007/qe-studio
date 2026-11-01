// Browse / open / delete saved input documents.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActionIcon, Badge, Group, Loader, Modal, ScrollArea, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { IconSearch, IconTrash } from '@tabler/icons-react';
import { apiDelete, apiGet, errMsg } from '../../api/client';
import { useDocuments, type DocFull } from './useDocuments';
import { notifyError, qk } from '../../api/hooks';
import { fmtBytes, fmtDate } from '../../lib/format';

export type { DocFull, DocMeta } from './useDocuments';

export function DocumentsModal({
  opened,
  onClose,
  onOpen,
}: {
  opened: boolean;
  onClose: () => void;
  onOpen: (d: DocFull) => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useDocuments(opened);
  const [q, setQ] = useState('');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const rows = (data ?? []).filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));

  const open = async (id: string) => {
    setLoadingId(id);
    try {
      const d = await apiGet<DocFull>(`/api/documents/${id}`);
      onOpen(d);
      onClose();
    } catch (e) {
      notifyError(e, 'Cannot open document');
    } finally {
      setLoadingId(null);
    }
  };

  const del = async (id: string, name: string) => {
    if (!window.confirm(`Delete “${name}”?`)) return;
    try {
      await apiDelete(`/api/documents/${id}`);
      qc.invalidateQueries({ queryKey: qk.documents });
    } catch (e) {
      notifyError(errMsg(e));
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={600}>Saved inputs</Text>} size="lg">
      <TextInput
        leftSection={<IconSearch size={14} />}
        placeholder="Filter by name"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        mb="sm"
      />
      {isLoading ? (
        <Loader size="sm" />
      ) : rows.length === 0 ? (
        <Text c="dimmed" size="sm">
          No saved inputs yet. Use “Save” in the editor.
        </Text>
      ) : (
        <ScrollArea.Autosize mah={420}>
          <Table highlightOnHover verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Program</Table.Th>
                <Table.Th>Updated</Table.Th>
                <Table.Th>Size</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((d) => (
                <Table.Tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => open(d.id)}>
                  <Table.Td>
                    <Group gap={6}>
                      {loadingId === d.id && <Loader size="xs" />}
                      <Text size="sm" ff="monospace">
                        {d.name}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="outline">
                      {d.program}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{fmtDate(d.updated_at)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{fmtBytes(d.size)}</Text>
                  </Table.Td>
                  <Table.Td onClick={(e) => e.stopPropagation()}>
                    <Tooltip label="Delete">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        onClick={() => del(d.id, d.name)}
                        aria-label="delete document"
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      )}
    </Modal>
  );
}
