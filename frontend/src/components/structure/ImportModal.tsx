import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  Radio,
  ScrollArea,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconFileImport, IconUpload, IconWorldDownload } from '@tabler/icons-react';
import { apiPost, apiUpload, errMsg } from '../../api/client';
import type { Structure } from '../../api/types';
import { formulaOf } from './geometry';

interface ParseResult {
  structures: Structure[];
  count?: number;
  source?: string;
}

const FORMATS = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'cif', label: 'CIF' },
  { value: 'vasp', label: 'POSCAR / CONTCAR' },
  { value: 'extxyz', label: 'XYZ / extended XYZ' },
  { value: 'xsf', label: 'XSF' },
  { value: 'pw-in', label: 'pw.x input' },
  { value: 'espresso-out', label: 'pw.x output (trajectory)' },
  { value: 'proteindatabank', label: 'PDB' },
];

/** Guess the format of pasted text (the backend needs a format or a meaningful file name). */
function sniff(text: string): string {
  const t = text.trim();
  if (/^\s*&system/im.test(t) && /ATOMIC_POSITIONS/i.test(t)) return 'pw-in';
  if (/Program PWSCF/.test(t)) return 'espresso-out';
  if (/^data_/m.test(t) || /_cell_length_a/.test(t)) return 'cif';
  if (/^\s*(PRIMVEC|CRYSTAL|SLAB|MOLECULE)\b/m.test(t)) return 'xsf';
  if (/^(CRYST1|ATOM {2}|HETATM)/m.test(t)) return 'proteindatabank';
  const lines = t.split(/\r?\n/);
  if (/^\d+\s*$/.test(lines[0] ?? '')) return 'extxyz';
  const isNums = (l: string | undefined, n: number) =>
    !!l &&
    l.trim().split(/\s+/).length >= n &&
    l
      .trim()
      .split(/\s+/)
      .slice(0, n)
      .every((x) => Number.isFinite(Number(x)));
  if (lines.length >= 8 && isNums(lines[1], 1) && isNums(lines[2], 3) && isNums(lines[3], 3) && isNums(lines[4], 3))
    return 'vasp';
  return 'cif';
}

const EXT: Record<string, string> = {
  cif: 'pasted.cif',
  vasp: 'POSCAR',
  extxyz: 'pasted.xyz',
  xsf: 'pasted.xsf',
  'pw-in': 'pasted.pwi',
  'espresso-out': 'pasted.out',
  proteindatabank: 'pasted.pdb',
};

export function ImportModal({
  opened,
  onClose,
  onImport,
}: {
  opened: boolean;
  onClose: () => void;
  onImport: (s: Structure, name: string, source: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [frames, setFrames] = useState<Structure[] | null>(null);
  const [pick, setPick] = useState('0');
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const [fmt, setFmt] = useState('auto');
  const [cod, setCod] = useState('');
  const [progress, setProgress] = useState<number | null>(null);

  const reset = () => {
    setFrames(null);
    setErr(null);
    setPick('0');
    setProgress(null);
  };

  const accept = (r: ParseResult, src: string) => {
    if (!r.structures.length) {
      setErr('No structure found');
      return;
    }
    if (r.structures.length === 1) {
      onImport(r.structures[0], r.structures[0].name ?? src, src);
      reset();
      onClose();
      return;
    }
    setSource(src);
    setFrames(r.structures);
    setPick(String(r.structures.length - 1));
  };

  const run = async (fn: () => Promise<ParseResult>, src: string) => {
    setBusy(true);
    setErr(null);
    try {
      accept(await fn(), src);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const onFiles = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    const form = new FormData();
    form.append('file', f, f.name);
    run(() => apiUpload<ParseResult>('/api/structures/parse', form, setProgress), f.name);
  };

  const onPaste = () => {
    const f = fmt === 'auto' ? sniff(text) : fmt;
    const form = new FormData();
    form.append('text', text);
    form.append('filename', EXT[f] ?? 'pasted.cif');
    form.append('fmt', f === 'pw-in' ? 'auto' : f);
    run(() => apiUpload<ParseResult>('/api/structures/parse', form), 'pasted text');
  };

  const onCod = () =>
    run(() => apiPost<ParseResult>('/api/structures/fetch', { source: 'cod', id: cod.trim() }), `COD ${cod.trim()}`);

  return (
    <Modal
      opened={opened}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import structure"
      size="lg"
    >
      {frames ? (
        <Stack>
          <Text size="sm">
            The file contains {frames.length} structures (e.g. a relaxation trajectory). Choose one:
          </Text>
          <ScrollArea h={300}>
            <Radio.Group value={pick} onChange={setPick}>
              <Table fz="xs" verticalSpacing={2} withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th />
                    <Table.Th>#</Table.Th>
                    <Table.Th>Formula</Table.Th>
                    <Table.Th>Atoms</Table.Th>
                    <Table.Th>Name</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {frames.map((s, i) => (
                    <Table.Tr key={i} onClick={() => setPick(String(i))} style={{ cursor: 'pointer' }}>
                      <Table.Td>
                        <Radio value={String(i)} size="xs" aria-label={`frame ${i + 1}`} />
                      </Table.Td>
                      <Table.Td>
                        {i + 1}
                        {i === frames.length - 1 ? ' (last)' : ''}
                      </Table.Td>
                      <Table.Td>{formulaOf(s)}</Table.Td>
                      <Table.Td>{s.sites.length}</Table.Td>
                      <Table.Td>{s.name}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Radio.Group>
          </ScrollArea>
          <Group justify="flex-end">
            <Button variant="default" onClick={reset}>
              Back
            </Button>
            <Button
              onClick={() => {
                const s = frames[Number(pick)];
                onImport(s, s.name ?? source, source);
                reset();
                onClose();
              }}
            >
              Open frame {Number(pick) + 1}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Tabs defaultValue="file">
          <Tabs.List mb="sm">
            <Tabs.Tab value="file" leftSection={<IconUpload size={14} />}>
              File
            </Tabs.Tab>
            <Tabs.Tab value="paste" leftSection={<IconFileImport size={14} />}>
              Paste text
            </Tabs.Tab>
            <Tabs.Tab value="cod" leftSection={<IconWorldDownload size={14} />}>
              COD
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="file">
            <Dropzone onDrop={onFiles} loading={busy} multiple={false} maxSize={200 * 1024 * 1024}>
              <Stack align="center" gap={4} py="lg" style={{ pointerEvents: 'none' }}>
                <IconUpload size={36} stroke={1.4} />
                <Text fw={500}>Drop a structure file here or click to browse</Text>
                <Text size="xs" c="dimmed" ta="center">
                  CIF, POSCAR/CONTCAR (.vasp), XYZ/extXYZ, XSF, PDB, ASE JSON/traj, pw.x input (.in/.pwi) or pw.x output
                  (.out, multi-frame)
                </Text>
                {progress !== null && <Text size="xs">Uploading {(progress * 100).toFixed(0)}%</Text>}
              </Stack>
            </Dropzone>
          </Tabs.Panel>
          <Tabs.Panel value="paste">
            <Stack gap="xs">
              <Select
                size="xs"
                w={220}
                label="Format"
                data={FORMATS}
                value={fmt}
                onChange={(v) => setFmt(v ?? 'auto')}
              />
              <Textarea
                autosize
                minRows={8}
                maxRows={16}
                placeholder="Paste CIF / POSCAR / XYZ / pw.x input…"
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
              />
              <Group justify="flex-end">
                <Button onClick={onPaste} loading={busy} disabled={!text.trim()}>
                  Parse
                </Button>
              </Group>
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="cod">
            <Stack gap="xs">
              <Text size="sm">
                Download a CIF from the Crystallography Open Database by its 7-digit id (requires internet access from
                the backend).
              </Text>
              <Group align="flex-end">
                <TextInput
                  label="COD id"
                  placeholder="9008565"
                  value={cod}
                  onChange={(e) => setCod(e.currentTarget.value)}
                  w={160}
                  error={cod && !/^\d{7}$/.test(cod.trim()) ? '7 digits' : undefined}
                />
                <Button onClick={onCod} loading={busy} disabled={!/^\d{7}$/.test(cod.trim())}>
                  Fetch
                </Button>
              </Group>
              <Text size="xs" c="dimmed">
                CIFs with partial occupancies or disorder must be ordered before use in QE.
              </Text>
            </Stack>
          </Tabs.Panel>
        </Tabs>
      )}
      {err && (
        <Alert color="red" mt="sm" p="xs">
          {err}
        </Alert>
      )}
    </Modal>
  );
}
