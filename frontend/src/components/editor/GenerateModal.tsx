// Generate a pw.x input from a structure (POST /api/qe/generate).
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { apiGet, apiPost, errMsg } from '../../api/client';
import { useStructures } from '../../api/hooks';
import type { Structure, StructureRecord, ValidationResult } from '../../api/types';

export interface GenerateResult {
  text: string;
  pseudos: Record<string, string>;
  cutoffs: { ecutwfc: number | null; ecutrho: number | null; dual: number; types: string[]; missing: string[] };
  notes: string[];
  validation: ValidationResult;
}

const PRESETS = [
  { value: 'fast', label: 'Fast (k-spacing 0.30 Å⁻¹, loose thresholds)' },
  { value: 'standard', label: 'Standard (0.20 Å⁻¹)' },
  { value: 'precise', label: 'Precise (0.15 Å⁻¹, tight thresholds)' },
];

export function GenerateModal({
  opened,
  onClose,
  structure,
  structureName,
  onGenerated,
}: {
  opened: boolean;
  onClose: () => void;
  structure: Structure | null;
  structureName?: string;
  onGenerated: (r: GenerateResult, name: string) => void;
}) {
  const { data: lib } = useStructures();
  const [libId, setLibId] = useState<string | null>(null);
  const [libStructure, setLibStructure] = useState<Structure | null>(null);
  const [calc, setCalc] = useState('scf');
  const [preset, setPreset] = useState('standard');
  const [prefix, setPrefix] = useState('pwscf');
  const [ecutwfc, setEcutwfc] = useState<number | string>('');
  const [kspacing, setKspacing] = useState<number | string>('');
  const [occupations, setOccupations] = useState('smearing');
  const [smearing, setSmearing] = useState('cold');
  const [degauss, setDegauss] = useState<number | string>('');
  const [spin, setSpin] = useState('auto');
  const [spinorbit, setSpinorbit] = useState(false);
  const [vdw, setVdw] = useState<string | null>(null);
  const [charge, setCharge] = useState<number | string>('');
  const [press, setPress] = useState<number | string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const src = structure ?? libStructure;

  useEffect(() => {
    if (!opened) return;
    setError(null);
    const base = (structureName || structure?.name || 'pwscf')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    setPrefix(base.slice(0, 24) || 'pwscf');
  }, [opened, structure, structureName]);

  useEffect(() => {
    if (!libId) {
      setLibStructure(null);
      return;
    }
    apiGet<StructureRecord>(`/api/structures/${libId}`)
      .then((r) => {
        setLibStructure(r.structure ?? null);
        const base = r.name
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .replace(/^_+|_+$/g, '');
        setPrefix(base.slice(0, 24) || 'pwscf');
      })
      .catch((e) => setError(errMsg(e)));
  }, [libId]);

  const run = async () => {
    if (!src) return;
    setBusy(true);
    setError(null);
    const options: Record<string, unknown> = { preset, prefix: prefix.trim() || 'pwscf', occupations, spin };
    if (ecutwfc !== '') options.ecutwfc = Number(ecutwfc);
    if (kspacing !== '') options.kspacing = Number(kspacing);
    if (occupations === 'smearing') {
      options.smearing = smearing;
      if (degauss !== '') options.degauss = Number(degauss);
    }
    if (spin === 'noncollinear' && spinorbit) options.spinorbit = true;
    if (vdw) options.vdw_corr = vdw;
    if (charge !== '' && Number(charge) !== 0) options.tot_charge = Number(charge);
    if (calc === 'vc-relax' && press !== '') options.press = Number(press);
    try {
      const r = await apiPost<GenerateResult>('/api/qe/generate', { structure: src, calculation: calc, options });
      onGenerated(r, `${options.prefix}.${calc}.in`);
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={<Text fw={600}>Generate pw.x input from a structure</Text>}
      size="lg"
    >
      <Stack gap="sm">
        {structure ? (
          <Alert p="xs" color="blue">
            Using the workbench structure <b>{structureName || structure.name || 'untitled'}</b> (
            {structure.sites.length} atoms).
          </Alert>
        ) : (
          <Select
            label="Structure from library"
            placeholder={lib?.length ? 'choose a structure' : 'library is empty — build one on the Structures page'}
            data={(lib ?? []).map((s) => ({
              value: s.id,
              label: `${s.name} · ${s.formula}${s.spacegroup ? ` · ${s.spacegroup}` : ''}`,
            }))}
            value={libId}
            onChange={setLibId}
            searchable
          />
        )}
        <SimpleGrid cols={2}>
          <Select
            label="Calculation"
            value={calc}
            onChange={(v) => v && setCalc(v)}
            allowDeselect={false}
            data={['scf', 'relax', 'vc-relax', 'nscf', 'bands', 'md']}
          />
          <Select
            label="Accuracy preset"
            value={preset}
            onChange={(v) => v && setPreset(v)}
            data={PRESETS}
            allowDeselect={false}
          />
          <TextInput label="prefix" value={prefix} onChange={(e) => setPrefix(e.currentTarget.value)} />
          <NumberInput
            label="ecutwfc (Ry)"
            placeholder="auto (from pseudopotentials)"
            min={5}
            value={ecutwfc}
            onChange={setEcutwfc}
          />
          <NumberInput
            label="k-spacing (Å⁻¹, incl. 2π)"
            placeholder="from preset"
            min={0.02}
            max={2}
            step={0.05}
            decimalScale={3}
            value={kspacing}
            onChange={setKspacing}
          />
          <Select
            label="Occupations"
            value={occupations}
            onChange={(v) => v && setOccupations(v)}
            allowDeselect={false}
            data={[
              { value: 'smearing', label: 'smearing (metals / unknown)' },
              { value: 'fixed', label: 'fixed (insulators)' },
              { value: 'tetrahedra_opt', label: 'tetrahedra_opt' },
            ]}
          />
          {occupations === 'smearing' && (
            <>
              <Select
                label="Smearing"
                value={smearing}
                onChange={(v) => v && setSmearing(v)}
                allowDeselect={false}
                data={[
                  { value: 'cold', label: 'Marzari-Vanderbilt (cold)' },
                  { value: 'gaussian', label: 'Gaussian' },
                  { value: 'methfessel-paxton', label: 'Methfessel-Paxton' },
                  { value: 'fermi-dirac', label: 'Fermi-Dirac' },
                ]}
              />
              <NumberInput
                label="degauss (Ry)"
                placeholder="from preset"
                min={0.0005}
                max={0.1}
                step={0.005}
                decimalScale={4}
                value={degauss}
                onChange={setDegauss}
              />
            </>
          )}
          <Select
            label="Spin"
            value={spin}
            onChange={(v) => v && setSpin(v)}
            allowDeselect={false}
            data={[
              { value: 'auto', label: 'auto (from species magnetization)' },
              { value: 'none', label: 'non-polarized' },
              { value: 'collinear', label: 'collinear (nspin=2)' },
              { value: 'noncollinear', label: 'non-collinear' },
            ]}
          />
          <Select
            label="van der Waals correction"
            clearable
            placeholder="none"
            value={vdw}
            onChange={setVdw}
            data={[
              { value: 'grimme-d2', label: 'Grimme D2' },
              { value: 'grimme-d3', label: 'Grimme D3' },
              { value: 'ts', label: 'Tkatchenko-Scheffler' },
              { value: 'xdm', label: 'XDM' },
            ]}
          />
          <NumberInput label="Total charge (e)" placeholder="0" value={charge} onChange={setCharge} />
          {calc === 'vc-relax' && (
            <NumberInput label="Target pressure (kbar)" placeholder="0" value={press} onChange={setPress} />
          )}
        </SimpleGrid>
        {spin === 'noncollinear' && (
          <Switch
            label="Spin-orbit coupling (needs fully-relativistic pseudopotentials)"
            checked={spinorbit}
            onChange={(e) => setSpinorbit(e.currentTarget.checked)}
          />
        )}
        <Text size="xs" c="dimmed">
          Pseudopotentials are taken from your library defaults; cutoffs from their recommended values (SSSP metadata or
          UPF headers) when available. Always check convergence for production results.
        </Text>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} loading={busy} disabled={!src}>
            Generate
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
