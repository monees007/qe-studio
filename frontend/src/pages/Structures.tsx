import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  Menu,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconAtom,
  IconDeviceFloppy,
  IconDownload,
  IconFileCode,
  IconFileImport,
  IconHammer,
  IconPlus,
} from '@tabler/icons-react';
import { apiDownload, apiPost, apiPut, errMsg } from '../api/client';
import { notifyError, notifyOk, qk } from '../api/hooks';
import type { Structure, StructureRecord } from '../api/types';
import { AskAIButton, EmptyState } from '../components/common';
import { CrystalViewer } from '../components/CrystalViewer';
import { AtomsTable } from '../components/structure/AtomsTable';
import { BuildModal } from '../components/structure/BuildModal';
import { GenerateInputModal } from '../components/structure/GenerateInputModal';
import { formulaOf, structureText } from '../components/structure/geometry';
import { ImportModal } from '../components/structure/ImportModal';
import { LatticePanel } from '../components/structure/LatticePanel';
import { LibraryPanel } from '../components/structure/LibraryPanel';
import { SpeciesPanel } from '../components/structure/SpeciesPanel';
import { SymmetryPanel } from '../components/structure/SymmetryPanel';
import { useAnalysis } from '../components/structure/useAnalysis';
import { TransformPanel } from '../components/structure/TransformPanel';
import { useWorkbench } from '../store/app';

// Undo/redo history survives navigation between pages (module scope).
const history = { undo: [] as Structure[], redo: [] as Structure[], saved: '' };
const MAX_HISTORY = 100;

const EXPORTS = [
  { fmt: 'cif', label: 'CIF (.cif)' },
  { fmt: 'poscar', label: 'VASP POSCAR (.vasp)' },
  { fmt: 'xyz', label: 'Extended XYZ (.xyz)' },
  { fmt: 'xsf', label: 'XCrySDen (.xsf)' },
  { fmt: 'pdb', label: 'PDB (.pdb)' },
  { fmt: 'json', label: 'ASE JSON (.json)' },
  { fmt: 'pw-in', label: 'pw.x input skeleton (.pwi)' },
  { fmt: 'qes-json', label: 'QE Studio JSON (species info kept)' },
];

const QUICK = [
  { label: 'Si (diamond)', params: { formula: 'Si', crystalstructure: 'diamond', a: 5.43 } },
  { label: 'Al (fcc)', params: { formula: 'Al', crystalstructure: 'fcc', a: 4.05 } },
  { label: 'Fe (bcc)', params: { formula: 'Fe', crystalstructure: 'bcc', a: 2.87 } },
  { label: 'MgO (rocksalt)', params: { formula: 'MgO', crystalstructure: 'rocksalt', a: 4.21 } },
  { label: 'GaAs (zincblende)', params: { formula: 'GaAs', crystalstructure: 'zincblende', a: 5.65 } },
];

export default function Structures() {
  const { structure, structureId, structureName, setStructure } = useWorkbench();
  const qc = useQueryClient();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [symprec, setSymprec] = useState(1e-3);
  const [tab, setTab] = useState<string | null>('atoms');
  const analysis = useAnalysis(structure, symprec);

  const natoms = structure?.sites.length ?? 0;
  useEffect(() => {
    setSelected((sel) => sel.filter((i) => i < natoms));
  }, [natoms]);

  const load = useCallback(
    (s: Structure, id: string | null, name: string) => {
      history.undo = [];
      history.redo = [];
      history.saved = JSON.stringify({ s, name });
      setSelected([]);
      setStructure(s, id, name);
      rerender();
    },
    [setStructure],
  );

  const commit = useCallback(
    (s: Structure) => {
      if (structure) {
        history.undo.push(structure);
        if (history.undo.length > MAX_HISTORY) history.undo.shift();
      }
      history.redo = [];
      setStructure({ ...s, name: structureName }, undefined, structureName);
      rerender();
    },
    [structure, structureName, setStructure],
  );

  const undo = useCallback(() => {
    const prev = history.undo.pop();
    if (!prev || !structure) return;
    history.redo.push(structure);
    setStructure(prev, undefined, structureName);
    rerender();
  }, [structure, structureName, setStructure]);

  const redo = useCallback(() => {
    const next = history.redo.pop();
    if (!next || !structure) return;
    history.undo.push(structure);
    setStructure(next, undefined, structureName);
    rerender();
  }, [structure, structureName, setStructure]);

  const transform = useCallback(
    async (op: string, params: Record<string, unknown> = {}) => {
      if (!structure) return;
      setBusy(true);
      try {
        const r = await apiPost<{ structure: Structure }>('/api/structures/transform', { structure, op, params });
        if (!['fix', 'set_cell', 'strain', 'scale_volume', 'rattle', 'wrap', 'center', 'vacuum'].includes(op))
          setSelected([]);
        commit(r.structure);
      } catch (e) {
        notifyError(e, `${op} failed`);
      } finally {
        setBusy(false);
      }
    },
    [structure, commit],
  );

  const save = async (asNew: boolean) => {
    if (!structure) return;
    setSaving(true);
    try {
      const body = { name: structureName || formulaOf(structure), structure, source: 'editor' };
      const rec =
        asNew || !structureId
          ? await apiPost<StructureRecord>('/api/structures', body)
          : await apiPut<StructureRecord>(`/api/structures/${structureId}`, body);
      history.saved = JSON.stringify({ s: structure, name: structureName });
      setStructure(structure, rec.id, rec.name);
      qc.invalidateQueries({ queryKey: qk.structures });
      notifyOk(`Saved “${rec.name}”`);
      rerender();
    } catch (e) {
      notifyError(e, 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const quickBuild = async (params: Record<string, unknown>, label: string) => {
    setBusy(true);
    try {
      const r = await apiPost<{ structure: Structure }>('/api/structures/build', { kind: 'bulk', params });
      load(r.structure, null, label);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const exportAs = async (fmt: string) => {
    if (!structure) return;
    try {
      await apiDownload(
        '/api/structures/export',
        { structure: { ...structure, name: structureName }, format: fmt },
        `${structureName}.${fmt}`,
      );
    } catch (e) {
      notifyError(e, `Export failed: ${errMsg(e)}`);
    }
  };

  const deleteSelected = () => {
    if (!structure || !selected.length) return;
    const drop = new Set(selected);
    const s = { ...structure, sites: structure.sites.filter((_, i) => !drop.has(i)) };
    const used = new Set(s.sites.map((x) => x.species));
    s.species = Object.fromEntries(Object.entries(structure.species).filter(([k]) => used.has(k)));
    setSelected([]);
    commit(s);
  };

  useHotkeys([
    ['mod+z', undo],
    ['mod+shift+z', redo],
    ['mod+y', redo],
    ['Delete', deleteSelected],
    ['Escape', () => setSelected([])],
  ]);

  const dirty = structure ? JSON.stringify({ s: structure, name: structureName }) !== history.saved : false;
  const sg = analysis.data?.symmetry?.international;
  const aiContext = useMemo(
    () =>
      structure
        ? [
            {
              kind: 'structure' as const,
              title: structureName,
              content: structureText(structure, structureName, sg),
            },
          ]
        : [],
    [structure, structureName, sg],
  );

  const viewerHeight = 470;

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group gap="xs">
          <IconAtom size={22} />
          <Title order={3}>Structures</Title>
        </Group>
        <Group gap="xs">
          <Button
            size="xs"
            variant="light"
            leftSection={<IconFileImport size={14} />}
            onClick={() => setImportOpen(true)}
          >
            Import
          </Button>
          <Button size="xs" variant="light" leftSection={<IconHammer size={14} />} onClick={() => setBuildOpen(true)}>
            Build
          </Button>
        </Group>
      </Group>

      <Grid gutter="sm">
        <Grid.Col span={{ base: 12, md: 3 }}>
          <Card p="xs">
            <Text size="sm" fw={600} mb={6}>
              Library
            </Text>
            <LibraryPanel
              currentId={structureId}
              height={viewerHeight + 40}
              onOpen={(rec) => rec.structure && load(rec.structure, rec.id, rec.name)}
            />
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 9 }}>
          {!structure ? (
            <Card>
              <EmptyState
                title="No structure open"
                action={
                  <Stack align="center" gap="xs">
                    <Group>
                      <Button leftSection={<IconFileImport size={16} />} onClick={() => setImportOpen(true)}>
                        Import file
                      </Button>
                      <Button variant="light" leftSection={<IconHammer size={16} />} onClick={() => setBuildOpen(true)}>
                        Build
                      </Button>
                    </Group>
                    <Text size="xs" c="dimmed">
                      or start from an example:
                    </Text>
                    <Group gap={6}>
                      {QUICK.map((qb) => (
                        <Button
                          key={qb.label}
                          size="xs"
                          variant="default"
                          loading={busy}
                          onClick={() => quickBuild(qb.params, qb.label)}
                        >
                          {qb.label}
                        </Button>
                      ))}
                    </Group>
                  </Stack>
                }
              >
                Open a structure from the library, import CIF/POSCAR/XYZ/pw.x files, fetch from COD, or build one.
              </EmptyState>
            </Card>
          ) : (
            <Stack gap="xs">
              <Card p="xs">
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <Group gap="xs" wrap="wrap">
                    <TextInput
                      size="xs"
                      w={220}
                      value={structureName}
                      aria-label="Structure name"
                      onChange={(e) => setStructure(structure, undefined, e.currentTarget.value)}
                    />
                    <Badge variant="light" tt="none">
                      {formulaOf(structure)}
                    </Badge>
                    <Badge variant="outline" color="gray" tt="none">
                      {natoms} atoms
                    </Badge>
                    {analysis.loading ? (
                      <Loader size={12} />
                    ) : (
                      sg && (
                        <Badge variant="outline" tt="none">
                          {sg} (#{analysis.data?.symmetry?.number})
                        </Badge>
                      )
                    )}
                    {dirty && (
                      <Badge color="yellow" variant="dot" tt="none">
                        unsaved
                      </Badge>
                    )}
                  </Group>
                  <Group gap={4}>
                    <Tooltip label="Undo (Ctrl+Z)">
                      <ActionIcon variant="default" disabled={!history.undo.length} onClick={undo} aria-label="Undo">
                        <IconArrowBackUp size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Redo (Ctrl+Shift+Z)">
                      <ActionIcon variant="default" disabled={!history.redo.length} onClick={redo} aria-label="Redo">
                        <IconArrowForwardUp size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Button.Group>
                      <Button
                        size="xs"
                        leftSection={<IconDeviceFloppy size={14} />}
                        loading={saving}
                        onClick={() => save(false)}
                      >
                        {structureId ? 'Save' : 'Save to library'}
                      </Button>
                      {structureId && (
                        <Button
                          size="xs"
                          variant="default"
                          leftSection={<IconPlus size={14} />}
                          loading={saving}
                          onClick={() => save(true)}
                        >
                          Save as new
                        </Button>
                      )}
                    </Button.Group>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <Button size="xs" variant="default" leftSection={<IconDownload size={14} />}>
                          Export
                        </Button>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {EXPORTS.map((e) => (
                          <Menu.Item key={e.fmt} onClick={() => exportAs(e.fmt)}>
                            {e.label}
                          </Menu.Item>
                        ))}
                      </Menu.Dropdown>
                    </Menu>
                    <Button
                      size="xs"
                      color="teal"
                      leftSection={<IconFileCode size={14} />}
                      onClick={() => setGenOpen(true)}
                    >
                      Create QE input
                    </Button>
                    <AskAIButton
                      context={aiContext}
                      prompt="Check this structure for problems (overlapping atoms, symmetry, magnetic configuration) and suggest sensible Quantum ESPRESSO settings for it."
                    />
                  </Group>
                </Group>
              </Card>

              <CrystalViewer
                structure={structure}
                height={viewerHeight}
                toolbar
                selected={selected}
                onSelect={(idx) => setSelected(idx)}
              />

              <Card p="xs">
                <Tabs value={tab} onChange={setTab} keepMounted={false}>
                  <Tabs.List mb="xs">
                    <Tabs.Tab value="atoms">Atoms ({natoms})</Tabs.Tab>
                    <Tabs.Tab value="species">Species ({Object.keys(structure.species).length})</Tabs.Tab>
                    <Tabs.Tab value="lattice">Lattice</Tabs.Tab>
                    <Tabs.Tab value="transform">
                      Transform{selected.length ? ` (${selected.length} sel.)` : ''}
                    </Tabs.Tab>
                    <Tabs.Tab value="symmetry">Symmetry & k-path</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="atoms">
                    <AtomsTable structure={structure} onChange={commit} selected={selected} onSelect={setSelected} />
                  </Tabs.Panel>
                  <Tabs.Panel value="species">
                    <SpeciesPanel structure={structure} onChange={commit} />
                  </Tabs.Panel>
                  <Tabs.Panel value="lattice">
                    <LatticePanel structure={structure} onTransform={transform} onChange={commit} busy={busy} />
                  </Tabs.Panel>
                  <Tabs.Panel value="transform">
                    <TransformPanel structure={structure} selected={selected} run={transform} busy={busy} />
                  </Tabs.Panel>
                  <Tabs.Panel value="symmetry">
                    <SymmetryPanel
                      structure={structure}
                      symprec={symprec}
                      setSymprec={setSymprec}
                      analysis={analysis}
                    />
                  </Tabs.Panel>
                </Tabs>
              </Card>
            </Stack>
          )}
        </Grid.Col>
      </Grid>

      <ImportModal
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={(s, name) => load(s, null, name)}
      />
      <BuildModal opened={buildOpen} onClose={() => setBuildOpen(false)} onBuilt={(s, name) => load(s, null, name)} />
      {structure && (
        <GenerateInputModal
          opened={genOpen}
          onClose={() => setGenOpen(false)}
          structure={structure}
          name={structureName}
        />
      )}
    </Stack>
  );
}
