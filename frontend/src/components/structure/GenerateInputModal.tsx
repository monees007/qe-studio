import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Group,
  List,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { apiPost, errMsg } from '../../api/client';
import type { Structure, ValidationResult } from '../../api/types';
import { useWorkbench } from '../../store/app';
import { reducedFormula } from './geometry';

interface GenerateResponse {
  text: string;
  pseudos: Record<string, string>;
  cutoffs: { ecutwfc: number | null; ecutrho: number | null; dual: number; types: string[]; missing: string[] };
  notes: string[];
  validation: ValidationResult;
}

const PRESET_K: Record<string, number> = { fast: 0.3, standard: 0.2, precise: 0.15 };

export function GenerateInputModal({
  opened,
  onClose,
  structure,
  name,
}: {
  opened: boolean;
  onClose: () => void;
  structure: Structure;
  name: string;
}) {
  const navigate = useNavigate();
  const setInput = useWorkbench((s) => s.setInput);
  const [calc, setCalc] = useState('scf');
  const [preset, setPreset] = useState('standard');
  const [prefix, setPrefix] = useState('pwscf');
  const [ecut, setEcut] = useState<number | ''>('');
  const [kspacing, setKspacing] = useState<number>(0.2);
  const [mesh, setMesh] = useState<number[] | null>(null);
  const [occ, setOcc] = useState('smearing');
  const [smearing, setSmearing] = useState('cold');
  const [degauss, setDegauss] = useState<number | ''>('');
  const [spin, setSpin] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);

  useEffect(() => {
    if (opened) {
      setPrefix(
        reducedFormula(structure)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '') || 'pwscf',
      );
      setResult(null);
      setErr(null);
    }
  }, [opened, structure]);

  useEffect(() => setKspacing(PRESET_K[preset] ?? 0.2), [preset]);

  useEffect(() => {
    if (!opened) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      apiPost<{ mesh: number[] }>('/api/structures/kmesh', { structure, kspacing }, ctrl.signal)
        .then((r) => setMesh(r.mesh))
        .catch(() => setMesh(null));
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [opened, structure, kspacing]);

  const generate = async (open: boolean) => {
    setBusy(true);
    setErr(null);
    const options: Record<string, unknown> = { preset, prefix, kspacing, occupations: occ, spin };
    if (ecut !== '') options.ecutwfc = ecut;
    if (occ === 'smearing') {
      options.smearing = smearing;
      if (degauss !== '') options.degauss = degauss;
    }
    try {
      const r = await apiPost<GenerateResponse>('/api/qe/generate', { structure, calculation: calc, options });
      setResult(r);
      if (open) {
        setInput(r.text, 'pw', null, `${prefix}.${calc}.in`);
        onClose();
        navigate('/editor');
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const nErr = result?.validation.issues.filter((i) => i.severity === 'error').length ?? 0;

  return (
    <Modal opened={opened} onClose={onClose} title={`Create pw.x input for ${name}`} size="lg">
      <Stack gap="sm">
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
          <Select
            label="Calculation"
            value={calc}
            onChange={(v) => setCalc(v ?? 'scf')}
            allowDeselect={false}
            data={['scf', 'relax', 'vc-relax', 'nscf', 'bands', 'md', 'vc-md']}
          />
          <Select
            label="Accuracy preset"
            value={preset}
            onChange={(v) => setPreset(v ?? 'standard')}
            allowDeselect={false}
            data={[
              { value: 'fast', label: 'Fast (testing)' },
              { value: 'standard', label: 'Standard' },
              { value: 'precise', label: 'Precise' },
            ]}
          />
          <TextInput
            label="prefix"
            value={prefix}
            onChange={(e) => setPrefix(e.currentTarget.value.replace(/[^A-Za-z0-9_.-]/g, ''))}
          />
          <Tooltip label="Empty = largest recommended cutoff of the selected pseudopotentials (SSSP metadata / UPF header), else 45 Ry">
            <NumberInput
              label="ecutwfc (Ry)"
              placeholder="auto"
              value={ecut}
              min={5}
              max={500}
              onChange={(v) => setEcut(v === '' ? '' : Number(v))}
            />
          </Tooltip>
          <NumberInput
            label="k-spacing (Å⁻¹, incl. 2π)"
            value={kspacing}
            step={0.01}
            min={0.02}
            max={2}
            decimalScale={3}
            onChange={(v) => setKspacing(Number(v) || 0.2)}
            description={mesh ? `mesh ${mesh.join('×')}` : ' '}
          />
          <Select
            label="Occupations"
            value={occ}
            onChange={(v) => setOcc(v ?? 'smearing')}
            allowDeselect={false}
            data={[
              { value: 'smearing', label: 'smearing (metals, safe default)' },
              { value: 'fixed', label: 'fixed (insulators)' },
              { value: 'tetrahedra_opt', label: 'tetrahedra_opt' },
            ]}
          />
          {occ === 'smearing' && (
            <>
              <Select
                label="Smearing"
                value={smearing}
                onChange={(v) => setSmearing(v ?? 'cold')}
                allowDeselect={false}
                data={[
                  { value: 'cold', label: 'Marzari–Vanderbilt (cold)' },
                  { value: 'gaussian', label: 'Gaussian' },
                  { value: 'methfessel-paxton', label: 'Methfessel–Paxton' },
                  { value: 'fermi-dirac', label: 'Fermi–Dirac' },
                ]}
              />
              <NumberInput
                label="degauss (Ry)"
                placeholder="preset"
                value={degauss}
                step={0.005}
                min={0.0005}
                max={0.2}
                decimalScale={4}
                onChange={(v) => setDegauss(v === '' ? '' : Number(v))}
              />
            </>
          )}
          <Select
            label="Spin"
            value={spin}
            onChange={(v) => setSpin(v ?? 'auto')}
            allowDeselect={false}
            data={[
              { value: 'auto', label: 'auto (from species magnetization)' },
              { value: 'none', label: 'non-polarized' },
              { value: 'collinear', label: 'collinear (nspin=2)' },
              { value: 'noncollinear', label: 'non-collinear' },
            ]}
          />
        </SimpleGrid>
        <Text size="xs" c="dimmed">
          Defaults are starting points, not converged values: run an ecutwfc and k-point convergence test (Workflows
          page) before production runs.
        </Text>
        {result && (
          <Alert color={nErr ? 'red' : result.notes.length ? 'yellow' : 'teal'} p="xs" title="Generated">
            <Stack gap={2}>
              <Text size="xs">
                Pseudopotentials:{' '}
                {Object.entries(result.pseudos)
                  .map(([k, v]) => `${k} → ${v}`)
                  .join(', ')}
              </Text>
              {result.cutoffs.ecutwfc && (
                <Text size="xs">
                  Recommended cutoffs: ecutwfc {result.cutoffs.ecutwfc} Ry, ecutrho {result.cutoffs.ecutrho} Ry
                </Text>
              )}
              {result.notes.length > 0 && (
                <List size="xs">
                  {result.notes.map((n) => (
                    <List.Item key={n}>{n}</List.Item>
                  ))}
                </List>
              )}
              {result.validation.issues
                .filter((i) => i.severity !== 'info')
                .map((i, k) => (
                  <Text key={k} size="xs" c={i.severity === 'error' ? 'red' : 'yellow.8'}>
                    {i.severity}: {i.message}
                  </Text>
                ))}
            </Stack>
          </Alert>
        )}
        {err && (
          <Alert color="red" p="xs">
            {err}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="light" loading={busy} onClick={() => generate(false)}>
            Check
          </Button>
          <Button loading={busy} onClick={() => generate(true)}>
            Open in input editor
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
