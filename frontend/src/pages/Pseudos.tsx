import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  Radio,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { modals } from '@mantine/modals';
import { IconCloudDownload, IconDownload, IconStar, IconStarFilled, IconTrash, IconUpload } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiDownload, apiPost, apiPut, apiUpload } from '../api/client';
import { notifyError, notifyOk, qk, usePseudos } from '../api/hooks';
import type { PseudoInfo } from '../api/types';
import { EmptyState, TaskProgress } from '../components/common';
import { PT_LAYOUT, elementColor } from '../lib/elements';
import { fmtBytes } from '../lib/format';

function PeriodicTable({
  counts,
  defaults,
  selected,
  onSelect,
}: {
  counts: Record<string, number>;
  defaults: Record<string, string>;
  selected: string | null;
  onSelect: (el: string) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(18, minmax(0, 1fr))', gap: 3 }}>
      {PT_LAYOUT.map(([el, row, col]) => {
        const n = counts[el] ?? 0;
        const isSel = selected === el;
        return (
          <Tooltip
            key={el}
            label={n ? `${el}: ${n} file(s)${defaults[el] ? ` · default ${defaults[el]}` : ''}` : `${el}: none`}
            openDelay={150}
          >
            <UnstyledButton
              onClick={() => onSelect(el)}
              style={{
                gridRow: row > 7 ? row + 0 : row,
                gridColumn: col,
                aspectRatio: '1 / 1',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                marginTop: row > 7 ? 8 : 0,
                border: isSel
                  ? '2px solid var(--mantine-color-blue-6)'
                  : '1px solid var(--mantine-color-default-border)',
                background: n
                  ? `color-mix(in srgb, ${elementColor(el)} 45%, var(--mantine-color-body))`
                  : 'var(--mantine-color-default)',
                opacity: n ? 1 : 0.55,
              }}
            >
              {el}
              {defaults[el] && (
                <span
                  style={{
                    position: 'absolute',
                    top: 1,
                    right: 2,
                    fontSize: 8,
                    color: 'var(--mantine-color-yellow-6)',
                  }}
                >
                  ★
                </span>
              )}
            </UnstyledButton>
          </Tooltip>
        );
      })}
    </div>
  );
}

function cutoffText(p: PseudoInfo): string {
  const w = p.recommended_ecutwfc ?? p.suggested_ecutwfc;
  const r = p.recommended_ecutrho ?? p.suggested_ecutrho;
  if (!w && !r) return '—';
  return `${w ?? '?'} / ${r ?? '?'} Ry${p.recommended_ecutwfc ? '' : ' (UPF)'}`;
}

export default function Pseudos() {
  const qc = useQueryClient();
  const { data, isLoading } = usePseudos();
  const [el, setEl] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [family, setFamily] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [famOpen, setFamOpen] = useState(false);
  const [famChoice, setFamChoice] = useState<string>('SSSP-1.3.0-PBE-efficiency');
  const [url, setUrl] = useState('');

  const pseudos = useMemo(() => data?.pseudos ?? [], [data]);
  const defaults = data?.defaults ?? {};
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of pseudos) if (p.element) c[p.element] = (c[p.element] ?? 0) + 1;
    return c;
  }, [pseudos]);
  const shown = pseudos.filter(
    (p) =>
      (!el || p.element === el) &&
      (!filter || `${p.filename} ${p.family ?? ''} ${p.functional ?? ''}`.toLowerCase().includes(filter.toLowerCase())),
  );
  const refresh = () => qc.invalidateQueries({ queryKey: qk.pseudos });

  const upload = async (files: File[]) => {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    if (family.trim()) fd.append('family', family.trim());
    fd.append('make_default', String(makeDefault));
    setUploadPct(0);
    try {
      const r = await apiUpload<{ added: string[]; errors: string[] }>('/api/pseudos/upload', fd, setUploadPct);
      notifyOk(`Added ${r.added.length} file(s)`);
      if (r.errors.length) notifyError(r.errors.slice(0, 5).join('\n'), 'Some files were skipped');
      refresh();
    } catch (e) {
      notifyError(e, 'Upload failed');
    } finally {
      setUploadPct(null);
    }
  };

  const setDefault = async (p: PseudoInfo) => {
    if (!p.element) return;
    try {
      await apiPut('/api/pseudos/defaults', { element: p.element, filename: p.is_default ? null : p.filename });
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  const remove = (p: PseudoInfo) =>
    modals.openConfirmModal({
      title: `Delete ${p.filename}?`,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      children: <Text size="sm">The file is removed from your library. Jobs that already ran keep their copy.</Text>,
      onConfirm: async () => {
        try {
          await apiDelete(`/api/pseudos/${encodeURIComponent(p.filename)}`);
          refresh();
        } catch (e) {
          notifyError(e);
        }
      },
    });

  const install = async (body: { family?: string; url?: string }) => {
    try {
      const r = await apiPost<{ task_id: string }>('/api/pseudos/install', { ...body, make_default: makeDefault });
      setTaskId(r.task_id);
      setFamOpen(false);
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={2}>Pseudopotentials</Title>
          <Text c="dimmed" size="sm">
            Your UPF library. The ★ file of each element is used when generating inputs. Recommended cutoffs come from
            SSSP metadata or UPF headers.
          </Text>
        </div>
        <Button leftSection={<IconCloudDownload size={16} />} onClick={() => setFamOpen(true)}>
          Install a library
        </Button>
      </Group>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Card>
          <Group justify="space-between" mb="xs">
            <Text fw={600}>Periodic table</Text>
            {el && (
              <Button size="compact-xs" variant="subtle" onClick={() => setEl(null)}>
                show all
              </Button>
            )}
          </Group>
          <PeriodicTable
            counts={counts}
            defaults={defaults}
            selected={el}
            onSelect={(e) => setEl(e === el ? null : e)}
          />
        </Card>
        <Card>
          <Text fw={600} mb="xs">
            Upload
          </Text>
          <Dropzone onDrop={upload} multiple maxSize={1024 ** 3}>
            <Stack align="center" gap={4} mih={110} justify="center" style={{ pointerEvents: 'none' }}>
              <IconUpload size={28} />
              <Text size="sm">Drop .UPF files, archives (.tar.gz, .zip) or an SSSP .json</Text>
              <Text size="xs" c="dimmed">
                Archives are scanned for UPF files; SSSP JSON adds recommended cutoffs
              </Text>
            </Stack>
          </Dropzone>
          <Group mt="xs" grow>
            <TextInput
              size="xs"
              label="Family label (optional)"
              placeholder="e.g. SSSP-1.3 efficiency"
              value={family}
              onChange={(e) => setFamily(e.currentTarget.value)}
            />
            <Checkbox
              mt="lg"
              label="Make new files the element default"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.currentTarget.checked)}
            />
          </Group>
          {uploadPct !== null && (
            <Text size="sm" mt="xs">
              Uploading… {(uploadPct * 100).toFixed(0)}%
            </Text>
          )}
          {taskId && (
            <Stack mt="sm">
              <TaskProgress
                taskId={taskId}
                onDone={(ok) => {
                  refresh();
                  if (ok) notifyOk('Library installed');
                }}
              />
            </Stack>
          )}
        </Card>
      </SimpleGrid>

      <Card>
        <Group justify="space-between" mb="xs">
          <Text fw={600}>{el ? `${el} pseudopotentials` : `All files (${pseudos.length})`}</Text>
          <TextInput
            size="xs"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            w={220}
          />
        </Group>
        {!isLoading && !shown.length ? (
          <EmptyState title={el ? `No pseudopotential for ${el}` : 'The library is empty'}>
            Upload UPF files or install SSSP (Prandini et al., npj Comput. Mater. 4, 72 (2018)) from the Materials Cloud
            archive.
          </EmptyState>
        ) : (
          <Table.ScrollContainer minWidth={900}>
            <Table striped highlightOnHover verticalSpacing={4} fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={36} />
                  <Table.Th>File</Table.Th>
                  <Table.Th>El.</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Functional</Table.Th>
                  <Table.Th>
                    Z<sub>val</sub>
                  </Table.Th>
                  <Table.Th>Cutoffs wfc / rho</Table.Th>
                  <Table.Th>Family</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th w={80} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shown.map((p) => (
                  <Table.Tr key={p.filename}>
                    <Table.Td>
                      <Tooltip
                        label={
                          p.is_default ? 'Default for this element (click to unset)' : 'Make default for this element'
                        }
                      >
                        <ActionIcon variant="subtle" color="yellow" onClick={() => setDefault(p)} disabled={!p.element}>
                          {p.is_default ? <IconStarFilled size={16} /> : <IconStar size={16} />}
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td className="qes-mono">
                      {p.filename}
                      {p.error && (
                        <Text c="red" size="xs">
                          {p.error}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge color="gray" variant="outline">
                        {p.element ?? '?'}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {p.type && (
                        <Badge color={p.type === 'NC' ? 'blue' : p.type === 'US' ? 'orange' : 'grape'}>{p.type}</Badge>
                      )}
                      {p.has_so && (
                        <Badge ml={4} color="pink">
                          SO
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>{p.functional ?? '—'}</Table.Td>
                    <Table.Td>{p.z_valence ?? '—'}</Table.Td>
                    <Table.Td>{cutoffText(p)}</Table.Td>
                    <Table.Td>
                      <Text size="xs">{p.family ?? ''}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{fmtBytes(p.size)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={2} wrap="nowrap">
                        <Tooltip label="Download">
                          <ActionIcon
                            variant="subtle"
                            onClick={() =>
                              apiDownload(
                                `/api/pseudos/${encodeURIComponent(p.filename)}/download`,
                                undefined,
                                p.filename,
                              )
                            }
                          >
                            <IconDownload size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Delete">
                          <ActionIcon variant="subtle" color="red" onClick={() => remove(p)}>
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <Modal opened={famOpen} onClose={() => setFamOpen(false)} title="Install a pseudopotential library" size="lg">
        <Stack>
          <Text size="sm">
            Downloads from the{' '}
            <Anchor href="https://archive.materialscloud.org/record/2023.65" target="_blank">
              Materials Cloud Archive (SSSP 1.3.0)
            </Anchor>{' '}
            to this computer (needs internet access). Please cite SSSP and the original pseudopotential libraries;
            individual files keep their own licenses.
          </Text>
          <Radio.Group value={famChoice} onChange={setFamChoice}>
            <Stack gap={6}>
              {(data?.families ?? []).map((f) => (
                <Radio key={f.id} value={f.id} label={f.title} />
              ))}
            </Stack>
          </Radio.Group>
          <Group justify="flex-end">
            <Button onClick={() => install({ family: famChoice })} leftSection={<IconCloudDownload size={16} />}>
              Download & install
            </Button>
          </Group>
          <Alert color="gray" title="Or from any URL">
            <Group align="flex-end">
              <TextInput
                style={{ flex: 1 }}
                placeholder="https://…/library.tar.gz or …/Fe.upf"
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
              <Button variant="light" disabled={!url.startsWith('https://')} onClick={() => install({ url })}>
                Install
              </Button>
            </Group>
          </Alert>
        </Stack>
      </Modal>
    </Stack>
  );
}
