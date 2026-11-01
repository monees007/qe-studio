// Input editor: Monaco text view and schema form view kept in sync, validation, documents, run.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  FileButton,
  Grid,
  Group,
  Menu,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowsShuffle,
  IconAtom,
  IconChevronDown,
  IconDeviceFloppy,
  IconDownload,
  IconFilePlus,
  IconFolderOpen,
  IconPlayerPlay,
  IconStack2,
  IconUpload,
  IconWand,
} from '@tabler/icons-react';
import { apiPost, apiPut, errMsg, saveText } from '../api/client';
import { notifyError, notifyOk, qk } from '../api/hooks';
import type { QEDoc, Structure } from '../api/types';
import { AskAIButton } from '../components/common';
import { CrystalViewer } from '../components/CrystalViewer';
import { DocumentsModal, type DocFull } from '../components/editor/DocumentsModal';
import { GenerateModal } from '../components/editor/GenerateModal';
import { PROGRAM_EXE, safeFileName } from '../components/editor/helpers';
import { IssuesList, ValidationBadges } from '../components/editor/IssuesList';
import { issuesAsText, useValidation } from '../components/editor/useValidation';
import { ParamForm } from '../components/ParamForm';
import { QEEditor } from '../components/QEEditor';
import { SubmitJobModal, type SubmitSpec } from '../components/SubmitJobModal';
import { useWorkbench } from '../store/app';

const PROGRAMS = [
  { value: 'pw', label: 'pw.x' },
  { value: 'ph', label: 'ph.x' },
  { value: 'pp', label: 'pp.x' },
  { value: 'dos', label: 'dos.x' },
  { value: 'projwfc', label: 'projwfc.x' },
  { value: 'bands', label: 'bands.x' },
  { value: 'q2r', label: 'q2r.x' },
  { value: 'matdyn', label: 'matdyn.x' },
  { value: 'hp', label: 'hp.x' },
];

const PW_SKELETON = `&CONTROL
  calculation = 'scf'
  prefix      = 'pwscf'
  outdir      = './tmp/'
  pseudo_dir  = './pseudo/'
/
&SYSTEM
  ibrav   = 0
  nat     = 1
  ntyp    = 1
  ecutwfc = 40.0
/
&ELECTRONS
  conv_thr = 1e-08
/
ATOMIC_SPECIES
  X  1.0  X.upf
ATOMIC_POSITIONS {crystal}
  X  0.0  0.0  0.0
K_POINTS {automatic}
  4 4 4 0 0 0
CELL_PARAMETERS {angstrom}
  5.0  0.0  0.0
  0.0  5.0  0.0
  0.0  0.0  5.0
`;

type View = 'text' | 'form' | 'split';

interface ParseResp {
  doc: QEDoc;
  program: string;
  executable: string | null;
  structure?: Structure;
  structure_error?: string;
}

export default function InputEditor() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const {
    inputText: text,
    inputProgram: program,
    inputName,
    inputDocId,
    setInput,
    structure: wbStructure,
    structureName: wbName,
    setStructure,
  } = useWorkbench();
  const [view, setView] = useState<View>('split');
  const [doc, setDoc] = useState<QEDoc | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Structure | null>(null);
  const [structErr, setStructErr] = useState<string | null>(null);
  const [savedText, setSavedText] = useState<string | null>(() => (inputDocId ? text : null));
  const [reveal, setReveal] = useState<number | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [submitSpec, setSubmitSpec] = useState<SubmitSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const lastRendered = useRef<string | null>(null);
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { result: validation, loading: validating } = useValidation(text, program);
  const dirty = savedText === null ? text.trim().length > 0 : text !== savedText;

  // text -> doc
  useEffect(() => {
    if (text === lastRendered.current) return;
    if (!text.trim()) {
      setDoc(null);
      setParsed(null);
      setParseError(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      apiPost<ParseResp>('/api/qe/parse', { text, program }, ctrl.signal)
        .then((r) => {
          setDoc(r.doc);
          setParseError(null);
          setParsed(r.structure ?? null);
          setStructErr(r.structure_error ?? null);
        })
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') setParseError(errMsg(e));
        });
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, program]);

  // doc -> text (form edits)
  const onFormChange = useCallback(
    (d: QEDoc) => {
      setDoc(d);
      if (renderTimer.current) clearTimeout(renderTimer.current);
      renderTimer.current = setTimeout(() => {
        apiPost<{ text: string }>('/api/qe/render', { doc: { ...d, program } })
          .then((r) => {
            lastRendered.current = r.text;
            setInput(r.text);
            // refresh the structure preview without replacing the form state
            apiPost<ParseResp>('/api/qe/parse', { text: r.text, program })
              .then((p) => {
                setParsed(p.structure ?? null);
                setStructErr(p.structure_error ?? null);
              })
              .catch(() => undefined);
          })
          .catch((e) => notifyError(e, 'Cannot render input'));
      }, 250);
    },
    [program, setInput],
  );

  useEffect(
    () => () => {
      if (renderTimer.current) clearTimeout(renderTimer.current);
    },
    [],
  );

  const jump = (line: number) => {
    if (view === 'form') setView('split');
    setReveal(null);
    requestAnimationFrame(() => setReveal(line));
  };

  const confirmDiscard = () => !dirty || window.confirm('Discard unsaved changes in the editor?');

  const loadText = (t: string, prog: string, name: string, docId: string | null, saved: string | null) => {
    lastRendered.current = null;
    setInput(t, prog, docId, name);
    setSavedText(saved);
  };

  const newFromTemplate = async (prog: string) => {
    if (!confirmDiscard()) return;
    if (prog === 'pw') {
      loadText(PW_SKELETON, 'pw', 'pw.scf.in', null, null);
      return;
    }
    const prefix =
      typeof doc?.namelists?.CONTROL?.prefix === 'string' ? (doc.namelists.CONTROL.prefix as string) : 'pwscf';
    try {
      const r = await apiPost<{ text: string }>('/api/qe/template', { program: prog, prefix, outdir: './tmp/' });
      loadText(r.text, prog, `${prefix}.${prog}.in`, null, null);
    } catch (e) {
      notifyError(e, 'Template failed');
    }
  };

  const detect = async (t = text) => {
    try {
      const r = await apiPost<{ program: string }>('/api/qe/detect', { text: t });
      return r.program;
    } catch {
      return program;
    }
  };

  const importFile = async (f: File | null) => {
    if (!f || !confirmDiscard()) return;
    if (f.size > 20 * 1024 * 1024) {
      notifyError('File larger than 20 MB — is this really an input file?');
      return;
    }
    const t = await f.text();
    const prog = await detect(t);
    loadText(t, prog, safeFileName(f.name), null, null);
  };

  const save = async (asName?: string) => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      if (inputDocId && !asName) {
        await apiPut(`/api/documents/${inputDocId}`, { name: inputName, program, content: text });
        notifyOk(`Saved ${inputName}`);
      } else {
        const name = safeFileName(asName ?? inputName);
        const d = await apiPost<DocFull>('/api/documents', { name, program, content: text });
        setInput(text, program, d.id, d.name);
        notifyOk(`Saved as ${d.name}`);
      }
      setSavedText(text);
      qc.invalidateQueries({ queryKey: qk.documents });
    } catch (e) {
      notifyError(e, 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const applyWorkbenchStructure = async () => {
    if (!wbStructure) return;
    try {
      const r = await apiPost<{ text: string }>('/api/qe/apply-structure', { text, structure: wbStructure });
      lastRendered.current = null;
      setInput(r.text);
      notifyOk(`Structure “${wbName}” applied (ibrav=0, crystal coordinates)`);
    } catch (e) {
      notifyError(e, 'Cannot apply structure');
    }
  };

  const runSpec = (): SubmitSpec => {
    const exe = PROGRAM_EXE[program] ?? 'pw.x';
    const inputNameSafe = safeFileName(inputName, `${program}.in`);
    const stem = inputNameSafe.replace(/\.[^.]+$/, '');
    const ctrl = doc?.namelists?.CONTROL ?? {};
    const calc = program === 'pw' ? String(ctrl.calculation ?? 'scf') : 'custom';
    const prefix = String(ctrl.prefix ?? 'pwscf');
    return {
      name: stem,
      kind: calc,
      steps: [
        {
          label: program === 'pw' ? calc : exe,
          program: exe,
          input_name: inputNameSafe,
          input: text,
          output_name: `${stem}.out`,
          cwd: '.',
          np: null,
          args: '',
          save_xml: program === 'pw' ? `./tmp/${prefix}.xml` : null,
          validation: validation ?? null,
        },
      ],
      workflow: { kind: calc },
    };
  };

  const summary = useMemo(() => {
    if (!doc || program !== 'pw') return null;
    const sys = doc.namelists.SYSTEM ?? {};
    const ctrl = doc.namelists.CONTROL ?? {};
    const kp = doc.cards.find((c) => c.name === 'K_POINTS');
    return [
      ['calculation', String(ctrl.calculation ?? 'scf')],
      ['prefix', String(ctrl.prefix ?? 'pwscf')],
      [
        'ecutwfc / ecutrho',
        `${sys.ecutwfc ?? '—'} / ${sys.ecutrho ?? `${typeof sys.ecutwfc === 'number' ? 4 * (sys.ecutwfc as number) : '—'} (default)`} Ry`,
      ],
      [
        'occupations',
        `${sys.occupations ?? 'fixed'}${sys.smearing ? ` · ${sys.smearing}` : ''}${sys.degauss ? ` · ${sys.degauss} Ry` : ''}`,
      ],
      ['spin', sys.noncolin ? 'non-collinear' : sys.nspin === 2 ? 'collinear (nspin=2)' : 'none'],
      [
        'k-points',
        kp ? `${kp.option ?? 'tpiba'}${kp.option === 'automatic' ? `: ${kp.lines[0] ?? ''}` : ''}` : 'Γ only',
      ],
    ];
  }, [doc, program]);

  const editor = (
    <QEEditor
      value={text}
      onChange={(v) => setInput(v)}
      program={program}
      issues={validation?.issues}
      onSave={() => save()}
      revealLine={reveal}
      height={view === 'split' ? 'calc(100vh - 330px)' : 'calc(100vh - 330px)'}
    />
  );
  const form = parseError ? (
    <Alert color="red" title="Cannot show the form">
      Fix the syntax error first (Text view): {parseError}
    </Alert>
  ) : doc ? (
    <Paper withBorder p="xs" style={{ height: 'calc(100vh - 330px)', overflow: 'hidden' }}>
      <ParamForm doc={doc} program={program} onChange={onFormChange} height="calc(100vh - 350px)" />
    </Paper>
  ) : (
    <Text c="dimmed" size="sm">
      Empty input — start from a template or generate one from a structure.
    </Text>
  );

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs">
          <Title order={3}>Input editor</Title>
          <TextInput
            size="xs"
            w={220}
            value={inputName}
            classNames={{ input: 'qes-mono' }}
            onChange={(e) => setInput(text, program, inputDocId, e.currentTarget.value)}
            aria-label="file name"
          />
          {dirty && (
            <Badge color="orange" variant="dot">
              unsaved
            </Badge>
          )}
          <Select
            size="xs"
            w={120}
            data={PROGRAMS}
            value={program}
            allowDeselect={false}
            aria-label="program"
            onChange={(v) => v && setInput(text, v)}
          />
          <Tooltip label="Detect program from the namelists">
            <Button
              size="xs"
              variant="subtle"
              leftSection={<IconWand size={14} />}
              onClick={async () => setInput(text, await detect())}
            >
              Detect
            </Button>
          </Tooltip>
          <ValidationBadges result={validation} loading={validating} />
        </Group>
        <Group gap="xs">
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                size="xs"
                variant="default"
                leftSection={<IconFilePlus size={14} />}
                rightSection={<IconChevronDown size={12} />}
              >
                New
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconAtom size={14} />} onClick={() => confirmDiscard() && setGenOpen(true)}>
                pw.x input from a structure…
              </Menu.Item>
              <Menu.Divider />
              <Menu.Label>Templates</Menu.Label>
              {PROGRAMS.filter((p) => p.value !== 'hp').map((p) => (
                <Menu.Item key={p.value} ff="monospace" onClick={() => newFromTemplate(p.value)}>
                  {p.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconFolderOpen size={14} />}
            onClick={() => setDocsOpen(true)}
          >
            Open
          </Button>
          <FileButton onChange={importFile} accept=".in,.pwi,.txt,.inp,*">
            {(props) => (
              <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} {...props}>
                Import
              </Button>
            )}
          </FileButton>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconDeviceFloppy size={14} />}
            loading={saving}
            onClick={() => (inputDocId ? save() : (setSaveAsName(inputName), setSaveAsOpen(true)))}
            disabled={!text.trim()}
          >
            Save
          </Button>
          <Button
            size="xs"
            variant="subtle"
            onClick={() => {
              setSaveAsName(inputName);
              setSaveAsOpen(true);
            }}
            disabled={!text.trim()}
          >
            Save as…
          </Button>
          <Tooltip label="Download the input file">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconDownload size={14} />}
              disabled={!text.trim()}
              onClick={() => saveText(text, safeFileName(inputName))}
            >
              Download
            </Button>
          </Tooltip>
          <AskAIButton
            label="Review"
            context={() => [
              { kind: 'input', title: inputName, content: text },
              { kind: 'text', title: 'QE Studio validation', content: issuesAsText(validation) },
            ]}
            prompt="Review this input for mistakes, unphysical settings and convergence issues."
          />
          <Button
            size="xs"
            variant="light"
            leftSection={<IconStack2 size={14} />}
            disabled={program !== 'pw' || !text.trim()}
            onClick={() => navigate('/run', { state: { scfText: text } })}
          >
            Workflow…
          </Button>
          <Button
            size="xs"
            leftSection={<IconPlayerPlay size={14} />}
            disabled={!text.trim()}
            onClick={() => setSubmitSpec(runSpec())}
          >
            Run
          </Button>
        </Group>
      </Group>

      <Grid gutter="sm">
        <Grid.Col span={{ base: 12, lg: program === 'pw' ? 8 : 12 }}>
          <Stack gap="xs">
            <SegmentedControl
              size="xs"
              w={260}
              value={view}
              onChange={(v) => setView(v as View)}
              data={[
                { value: 'text', label: 'Text' },
                { value: 'split', label: 'Split' },
                { value: 'form', label: 'Form' },
              ]}
            />
            {view === 'text' && editor}
            {view === 'form' && form}
            {view === 'split' && (
              <Grid gutter="xs">
                <Grid.Col span={{ base: 12, md: 6 }}>{editor}</Grid.Col>
                <Grid.Col span={{ base: 12, md: 6 }}>{form}</Grid.Col>
              </Grid>
            )}
            <Paper withBorder p="xs">
              <Group justify="space-between" mb={4}>
                <Text size="sm" fw={600}>
                  Checks
                </Text>
                {parseError && <Badge color="red">syntax error</Badge>}
              </Group>
              <IssuesList result={validation} onJump={jump} maxHeight={150} />
            </Paper>
          </Stack>
        </Grid.Col>

        {program === 'pw' && (
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Stack gap="sm">
              <Paper withBorder p="sm">
                <Group justify="space-between" mb="xs">
                  <Text fw={600} size="sm">
                    Structure in this input
                  </Text>
                  {parsed && <Badge variant="outline">{parsed.sites.length} atoms</Badge>}
                </Group>
                {structErr && !parsed && (
                  <Alert color="yellow" p="xs" mb="xs">
                    {structErr}
                  </Alert>
                )}
                <CrystalViewer structure={parsed} height={300} showBonds showCell toolbar />
                <Group gap="xs" mt="xs">
                  <Tooltip
                    label={
                      wbStructure
                        ? `Replace cell, positions and species with “${wbName}” (other parameters are kept)`
                        : 'Open a structure on the Structures page first'
                    }
                  >
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconArrowsShuffle size={14} />}
                      disabled={!wbStructure || !text.trim()}
                      onClick={applyWorkbenchStructure}
                    >
                      Apply workbench structure
                    </Button>
                  </Tooltip>
                  <Button
                    size="xs"
                    variant="subtle"
                    leftSection={<IconAtom size={14} />}
                    disabled={!parsed}
                    onClick={() => {
                      if (!parsed) return;
                      setStructure(parsed, null, inputName.replace(/\.[^.]+$/, ''));
                      navigate('/structures');
                    }}
                  >
                    Open in structure editor
                  </Button>
                </Group>
              </Paper>
              {summary && (
                <Paper withBorder p="sm">
                  <Text fw={600} size="sm" mb={4}>
                    Summary
                  </Text>
                  <Table withRowBorders={false} verticalSpacing={2}>
                    <Table.Tbody>
                      {summary.map(([k, v]) => (
                        <Table.Tr key={k}>
                          <Table.Td>
                            <Text size="xs" c="dimmed">
                              {k}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" ff="monospace">
                              {v}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Paper>
              )}
            </Stack>
          </Grid.Col>
        )}
      </Grid>

      <DocumentsModal
        opened={docsOpen}
        onClose={() => setDocsOpen(false)}
        onOpen={(d) => {
          if (!confirmDiscard()) return;
          loadText(d.content, d.program, d.name, d.id, d.content);
        }}
      />
      <GenerateModal
        opened={genOpen}
        onClose={() => setGenOpen(false)}
        structure={wbStructure}
        structureName={wbName}
        onGenerated={(r, name) => {
          loadText(r.text, 'pw', name, null, null);
          for (const n of r.notes) notifyOk(n, 'Note');
        }}
      />
      <Modal opened={saveAsOpen} onClose={() => setSaveAsOpen(false)} title="Save input as" size="sm">
        <Stack>
          <TextInput
            label="File name"
            value={saveAsName}
            onChange={(e) => setSaveAsName(e.currentTarget.value)}
            data-autofocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && saveAsName.trim()) {
                setSaveAsOpen(false);
                save(saveAsName);
              }
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSaveAsOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!saveAsName.trim()}
              onClick={() => {
                setSaveAsOpen(false);
                save(saveAsName);
              }}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
      <SubmitJobModal opened={!!submitSpec} onClose={() => setSubmitSpec(null)} spec={submitSpec} />
    </Stack>
  );
}
