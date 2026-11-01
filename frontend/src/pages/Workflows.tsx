// Workflow builder: base SCF input -> multi-step job (bands, DOS, phonons, density, convergence, EOS).
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconActivity, IconAtom, IconRefresh } from '@tabler/icons-react';
import { apiGet, apiPost, errMsg } from '../api/client';
import { notifyError } from '../api/hooks';
import type { WorkflowSpec } from '../api/types';
import { AskAIButton } from '../components/common';
import { useDocuments, type DocFull } from '../components/editor/useDocuments';
import { GenerateModal } from '../components/editor/GenerateModal';
import { ValidationBadges } from '../components/editor/IssuesList';
import { issuesAsText, useValidation } from '../components/editor/useValidation';
import { QEEditor } from '../components/QEEditor';
import { SubmitJobModal, type SubmitSpec } from '../components/SubmitJobModal';
import { useWorkbench } from '../store/app';
import { DEFAULTS, KINDS, buildParams, buildParamsSafe, type Kind, type Params } from '../components/workflows/catalog';
import { ParamsForm } from '../components/workflows/ParamsForm';
import { StepItem } from '../components/workflows/StepItem';

export default function Workflows() {
  const location = useLocation();
  const { inputText, structure: wbStructure, structureName: wbName, structureId } = useWorkbench();
  const stateText = (location.state as { scfText?: string } | null)?.scfText;
  const [source, setSource] = useState<'editor' | 'document' | 'structure'>(
    stateText || inputText.trim() ? 'editor' : wbStructure ? 'structure' : 'document',
  );
  const [base, setBase] = useState<string>(stateText ?? inputText ?? '');
  const [baseFromStructure, setBaseFromStructure] = useState(false);
  const [docId, setDocId] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('bands');
  const [params, setParams] = useState<Record<Kind, Params>>(() => JSON.parse(JSON.stringify(DEFAULTS)));
  const [wf, setWf] = useState<WorkflowSpec | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submit, setSubmit] = useState<SubmitSpec | null>(null);
  const { data: docs } = useDocuments(true);
  const { result: baseValidation, loading: baseValidating } = useValidation(base, 'pw');

  useEffect(() => {
    if (stateText) {
      setBase(stateText);
      setSource('editor');
    }
  }, [stateText]);

  useEffect(() => {
    if (wf) setStale(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, kind, params]);

  const setParam = (k: string, v: unknown) => setParams((p) => ({ ...p, [kind]: { ...p[kind], [k]: v } }));

  const pickSource = (s: string) => {
    setSource(s as typeof source);
    if (s === 'editor') {
      setBase(inputText);
      setBaseFromStructure(false);
    }
    if (s === 'structure') setGenOpen(true);
  };

  const loadDoc = async (id: string | null) => {
    setDocId(id);
    if (!id) return;
    try {
      const d = await apiGet<DocFull>(`/api/documents/${id}`);
      if (d.program !== 'pw')
        notifyError(`“${d.name}” is a ${d.program}.x input; workflows start from a pw.x SCF input`);
      setBase(d.content);
      setBaseFromStructure(false);
    } catch (e) {
      notifyError(e, 'Cannot open document');
    }
  };

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const params_ = buildParams(kind, params[kind]);
      const r = await apiPost<WorkflowSpec>('/api/qe/workflow', { kind, scf_text: base, params: params_ });
      setWf(r);
      setStale(false);
    } catch (e) {
      setError(errMsg(e));
      setWf(null);
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => {
    if (!wf) return null;
    let e = 0,
      w = 0;
    for (const s of wf.steps) {
      for (const i of s.validation?.issues ?? []) {
        if (i.severity === 'error') e++;
        else if (i.severity === 'warning') w++;
      }
    }
    return { e, w };
  }, [wf]);

  const kindMeta = KINDS.find((k) => k.kind === kind)!;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <div>
          <Title order={3}>Workflows &amp; run</Title>
          <Text size="sm" c="dimmed">
            Build a multi-step job from an SCF input. Every step runs in the same job directory on the chosen
            connection.
          </Text>
        </div>
        <AskAIButton
          label="Review plan"
          context={() => [
            { kind: 'input', title: 'Base SCF input', content: base },
            { kind: 'text', title: 'Base input validation', content: issuesAsText(baseValidation) },
            {
              kind: 'text',
              title: 'Workflow',
              content: `Workflow: ${kind}\nParameters: ${JSON.stringify(buildParamsSafe(kind, params[kind]), null, 1)}`,
            },
            ...(wf
              ? wf.steps.map((s, i) => ({
                  kind: 'input' as const,
                  title: `Step ${i + 1}: ${s.label}`,
                  content: s.input,
                }))
              : []),
          ]}
          prompt="Is this workflow and its parameters appropriate for this system? What would you change?"
        />
      </Group>

      <Card>
        <Group justify="space-between" mb="xs">
          <Text fw={600}>1 · Base SCF input</Text>
          <Group gap="xs">
            <ValidationBadges result={baseValidation} loading={baseValidating} />
            <SegmentedControl
              size="xs"
              value={source}
              onChange={pickSource}
              data={[
                { value: 'editor', label: 'From editor' },
                { value: 'document', label: 'Saved input' },
                { value: 'structure', label: 'Generate from structure' },
              ]}
            />
          </Group>
        </Group>
        {source === 'document' && (
          <Select
            mb="xs"
            placeholder="choose a saved pw.x input"
            searchable
            value={docId}
            onChange={loadDoc}
            data={(docs ?? []).map((d) => ({ value: d.id, label: `${d.name} (${d.program})` }))}
          />
        )}
        {source === 'structure' && (
          <Group mb="xs" gap="xs">
            <Button size="xs" variant="light" leftSection={<IconAtom size={14} />} onClick={() => setGenOpen(true)}>
              {wbStructure ? `Generate from “${wbName}”…` : 'Choose structure and generate…'}
            </Button>
          </Group>
        )}
        {source === 'editor' && !base.trim() && (
          <Alert color="yellow" p="xs" mb="xs">
            The input editor is empty. Pick a saved input or generate one from a structure.
          </Alert>
        )}
        <QEEditor value={base} onChange={setBase} program="pw" height={260} issues={baseValidation?.issues} />
        {baseValidation && baseValidation.program !== 'pw' && (
          <Alert color="red" p="xs" mt="xs">
            This looks like a {baseValidation.program}.x input — workflows need a pw.x SCF input.
          </Alert>
        )}
      </Card>

      <Card>
        <Text fw={600} mb="xs">
          2 · Workflow
        </Text>
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="xs">
          {KINDS.map((k) => (
            <Paper
              key={k.kind}
              withBorder
              p="sm"
              onClick={() => setKind(k.kind)}
              style={{
                cursor: 'pointer',
                borderColor: kind === k.kind ? `var(--mantine-color-${k.color}-6)` : undefined,
                background: kind === k.kind ? `var(--mantine-color-${k.color}-light)` : undefined,
              }}
            >
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <ThemeIcon variant="light" color={k.color} size="md">
                  <k.icon size={16} />
                </ThemeIcon>
                <div>
                  <Text size="sm" fw={600}>
                    {k.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {k.desc}
                  </Text>
                </div>
              </Group>
            </Paper>
          ))}
        </SimpleGrid>
      </Card>

      <Card>
        <Group justify="space-between" mb="xs">
          <Group gap="xs">
            <ThemeIcon variant="light" color={kindMeta.color}>
              <kindMeta.icon size={16} />
            </ThemeIcon>
            <Text fw={600}>3 · {kindMeta.title} parameters</Text>
          </Group>
          <Button
            size="xs"
            variant="subtle"
            onClick={() => setParams((p) => ({ ...p, [kind]: { ...DEFAULTS[kind] } }))}
          >
            Reset
          </Button>
        </Group>
        <ParamsForm kind={kind} p={params[kind]} set={setParam} baseText={base} />
        <Group mt="md">
          <Button
            leftSection={<IconRefresh size={14} />}
            onClick={generate}
            loading={busy}
            disabled={!base.trim() || (baseValidation?.program && baseValidation.program !== 'pw') || false}
          >
            {wf ? 'Regenerate steps' : 'Generate steps'}
          </Button>
          {wf && stale && (
            <Badge color="orange" variant="dot">
              inputs or parameters changed — regenerate
            </Badge>
          )}
        </Group>
        {error && (
          <Alert color="red" mt="sm" title="Cannot build the workflow">
            {error}
          </Alert>
        )}
      </Card>

      {wf && (
        <Card>
          <Group justify="space-between" mb="xs">
            <Group gap="xs">
              <Text fw={600}>4 · Review steps</Text>
              <Badge variant="outline">{wf.steps.length} steps</Badge>
              {totals && totals.e > 0 && <Badge color="red">{totals.e} errors</Badge>}
              {totals && totals.w > 0 && <Badge color="yellow">{totals.w} warnings</Badge>}
            </Group>
            <Tooltip label="Choose where to run and with how many cores">
              <Button
                leftSection={<IconActivity size={16} />}
                onClick={() =>
                  setSubmit({
                    name: wf.name,
                    kind: wf.kind,
                    steps: wf.steps,
                    workflow: wf.workflow,
                    structure_id: baseFromStructure ? structureId : null,
                  })
                }
              >
                Submit…
              </Button>
            </Tooltip>
          </Group>
          {wf.kind === 'convergence' || wf.kind === 'eos' ? (
            <Table mb="xs" withRowBorders={false} verticalSpacing={2}>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      Each point runs in its own directory (c01…, v01…); results are compared automatically after the
                      job.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          ) : null}
          <Accordion multiple variant="separated" chevronPosition="left" defaultValue={[]}>
            {wf.steps.map((s, i) => (
              <StepItem
                key={`${wf.kind}-${i}`}
                step={s}
                index={i}
                onChange={(ns) =>
                  setWf((cur) => (cur ? { ...cur, steps: cur.steps.map((x, j) => (j === i ? ns : x)) } : cur))
                }
              />
            ))}
          </Accordion>
        </Card>
      )}

      <GenerateModal
        opened={genOpen}
        onClose={() => setGenOpen(false)}
        structure={wbStructure}
        structureName={wbName}
        onGenerated={(r) => {
          setBase(r.text);
          setBaseFromStructure(!!wbStructure);
          setSource('structure');
        }}
      />
      <SubmitJobModal opened={!!submit} onClose={() => setSubmit(null)} spec={submit} />
    </Stack>
  );
}
