// Parameter forms for each workflow kind (and the k-path helper).
import { useState } from 'react';
import {
  Button,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { apiPost } from '../../api/client';
import { notifyError } from '../../api/hooks';
import type { KPath, Structure } from '../../api/types';
import { PLOT_NUMS, num, parseValues, type Kind, type Params } from './catalog';

function PathHelper({ baseText, npoints, onPath }: { baseText: string; npoints: number; onPath: (p: string) => void }) {
  const [kp, setKp] = useState<KPath | null>(null);
  const [busy, setBusy] = useState(false);
  const suggest = async () => {
    setBusy(true);
    try {
      const parsed = await apiPost<{ structure?: Structure; structure_error?: string }>('/api/qe/parse', {
        text: baseText,
        program: 'pw',
      });
      if (!parsed.structure) throw new Error(parsed.structure_error ?? 'no structure in the base input');
      const r = await apiPost<KPath>('/api/structures/kpath', { structure: parsed.structure, npoints });
      setKp(r);
      onPath(r.path);
    } catch (e) {
      notifyError(e, 'k-path');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap={4}>
      <Button size="xs" variant="light" onClick={suggest} loading={busy} w="fit-content" disabled={!baseText.trim()}>
        Suggest path (Setyawan–Curtarolo)
      </Button>
      {kp && (
        <Text size="xs" c="dimmed">
          {Object.entries(kp.special_points)
            .map(([k, v]) => `${k === 'G' ? 'Γ' : k}=(${v.map((x) => +x.toFixed(4)).join(', ')})`)
            .join('  ')}
        </Text>
      )}
    </Stack>
  );
}

export function ParamsForm({
  kind,
  p,
  set,
  baseText,
}: {
  kind: Kind;
  p: Params;
  set: (k: string, v: unknown) => void;
  baseText: string;
}) {
  switch (kind) {
    case 'single':
      return (
        <Text size="sm" c="dimmed">
          The base input is submitted unchanged; its <code>calculation</code> decides the analysis shown afterwards.
        </Text>
      );
    case 'bands':
      return (
        <Stack gap="xs">
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <NumberInput
              label="Points along the path"
              min={10}
              max={2000}
              value={p.npoints}
              onChange={(v) => set('npoints', v)}
            />
            <NumberInput
              label="nbnd"
              placeholder="auto (occupied × 1.3)"
              min={1}
              value={p.nbnd}
              onChange={(v) => set('nbnd', v)}
            />
            <Switch
              label="Fat bands (projwfc.x)"
              mt={28}
              checked={p.projwfc}
              onChange={(e) => set('projwfc', e.currentTarget.checked)}
            />
          </SimpleGrid>
          <TextInput
            label="Path"
            placeholder="auto, e.g. GXWKGLUWLK,UX (comma = discontinuity)"
            value={p.path}
            onChange={(e) => set('path', e.currentTarget.value)}
            classNames={{ input: 'qes-mono' }}
          />
          <PathHelper baseText={baseText} npoints={num(p.npoints) ?? 120} onPath={(x) => set('path', x)} />
        </Stack>
      );
    case 'dos':
      return (
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput
            label="NSCF k-mesh factor"
            description="× SCF mesh"
            min={1}
            max={8}
            step={0.5}
            decimalScale={2}
            value={p.kmesh_factor}
            onChange={(v) => set('kmesh_factor', v)}
          />
          <Select
            label="NSCF occupations"
            value={p.occupations}
            onChange={(v) => v && set('occupations', v)}
            allowDeselect={false}
            data={[
              { value: 'tetrahedra_opt', label: 'tetrahedra_opt (recommended)' },
              { value: 'tetrahedra', label: 'tetrahedra (Blöchl)' },
              { value: 'smearing', label: 'smearing (as SCF)' },
            ]}
          />
          <NumberInput label="nbnd" placeholder="auto" min={1} value={p.nbnd} onChange={(v) => set('nbnd', v)} />
          <NumberInput label="Emin (eV)" placeholder="auto" value={p.emin} onChange={(v) => set('emin', v)} />
          <NumberInput label="Emax (eV)" placeholder="auto" value={p.emax} onChange={(v) => set('emax', v)} />
          <NumberInput
            label="ΔE (eV)"
            min={0.001}
            max={0.5}
            step={0.005}
            decimalScale={4}
            value={p.delta_e}
            onChange={(v) => set('delta_e', v)}
          />
          <Switch
            label="Projected DOS (projwfc.x)"
            checked={p.pdos}
            onChange={(e) => set('pdos', e.currentTarget.checked)}
          />
        </SimpleGrid>
      );
    case 'phonon':
      return (
        <Stack gap="xs">
          <Group gap="xs" align="flex-end">
            <Text size="sm" fw={500} w={120}>
              q-grid
            </Text>
            {(['nq1', 'nq2', 'nq3'] as const).map((k) => (
              <NumberInput
                key={k}
                w={80}
                placeholder="auto"
                min={1}
                max={16}
                value={p[k]}
                onChange={(v) => set(k, v)}
                allowDecimal={false}
                aria-label={k}
              />
            ))}
            <Text size="xs" c="dimmed">
              empty = automatic (~0.5 Å⁻¹ spacing)
            </Text>
          </Group>
          <Group gap="xs" align="flex-end">
            <Text size="sm" fw={500} w={120}>
              DOS q-mesh
            </Text>
            {(['d1', 'd2', 'd3'] as const).map((k) => (
              <NumberInput
                key={k}
                w={80}
                placeholder="auto"
                min={1}
                max={64}
                value={p[k]}
                onChange={(v) => set(k, v)}
                allowDecimal={false}
                aria-label={k}
              />
            ))}
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <NumberInput
              label="Points along the path"
              min={10}
              max={2000}
              value={p.npoints}
              onChange={(v) => set('npoints', v)}
            />
            <TextInput
              label="tr2_ph"
              value={p.tr2_ph}
              onChange={(e) => set('tr2_ph', e.currentTarget.value)}
              classNames={{ input: 'qes-mono' }}
            />
            <Select
              label="Acoustic sum rule"
              value={p.asr}
              onChange={(v) => v && set('asr', v)}
              allowDeselect={false}
              data={['crystal', 'simple', 'one-dim', 'zero-dim', 'no']}
            />
          </SimpleGrid>
          <TextInput
            label="Path"
            placeholder="auto"
            value={p.path}
            onChange={(e) => set('path', e.currentTarget.value)}
            classNames={{ input: 'qes-mono' }}
          />
          <PathHelper baseText={baseText} npoints={num(p.npoints) ?? 100} onPath={(x) => set('path', x)} />
          <Switch
            label="Dielectric tensor and Born charges (epsil, insulators only — gives LO-TO splitting)"
            checked={p.epsil}
            onChange={(e) => set('epsil', e.currentTarget.checked)}
          />
          <Text size="xs" c="dimmed">
            The SCF conv_thr is tightened to 1e-12 Ry if looser. Phonons are expensive: the cost grows with the number
            of irreducible q-points.
          </Text>
        </Stack>
      );
    case 'density':
      return (
        <Stack gap="xs">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label="Quantity (plot_num)"
              data={PLOT_NUMS}
              value={p.plot_num}
              onChange={(v) => v && set('plot_num', v)}
              allowDeselect={false}
            />
            <Select
              label="Output format"
              value={p.output_format}
              onChange={(v) => v && set('output_format', v)}
              allowDeselect={false}
              data={[
                { value: '6', label: 'Gaussian cube (3D, shown in QE Studio)' },
                { value: '5', label: 'XCrySDen XSF (3D, download only)' },
              ]}
            />
          </SimpleGrid>
          <Textarea
            label="Extra &INPUTPP parameters (JSON)"
            placeholder={'{"spin_component": 1}'}
            autosize
            minRows={1}
            value={p.extra}
            onChange={(e) => set('extra', e.currentTarget.value)}
            classNames={{ input: 'qes-mono' }}
            error={(() => {
              if (!p.extra?.trim()) return null;
              try {
                JSON.parse(p.extra);
                return null;
              } catch {
                return 'invalid JSON';
              }
            })()}
          />
        </Stack>
      );
    case 'convergence': {
      const fill = () => {
        const a = num(p.start),
          b = num(p.stop),
          s = num(p.step);
        if (a === undefined || b === undefined || !s || s <= 0 || b < a) return;
        const vals: number[] = [];
        for (let x = a; x <= b + 1e-9 && vals.length < 60; x += s) vals.push(+x.toFixed(6));
        set('values', vals.join(', '));
      };
      return (
        <Stack gap="xs">
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Select
              label="Parameter"
              value={p.parameter}
              allowDeselect={false}
              onChange={(v) => {
                if (!v) return;
                set('parameter', v);
                set(
                  'values',
                  {
                    ecutwfc: '25, 30, 35, 40, 45, 50, 60',
                    ecutrho: '160, 200, 240, 280, 320',
                    kpoints: '2, 4, 6, 8, 10, 12',
                    kspacing: '0.5, 0.4, 0.3, 0.25, 0.2, 0.15',
                    degauss: '0.04, 0.03, 0.02, 0.01, 0.005',
                  }[v] ?? '',
                );
              }}
              data={[
                { value: 'ecutwfc', label: 'ecutwfc (Ry)' },
                { value: 'ecutrho', label: 'ecutrho (Ry)' },
                { value: 'kpoints', label: 'k-mesh (n or n1xn2xn3)' },
                { value: 'kspacing', label: 'k-spacing (Å⁻¹)' },
                { value: 'degauss', label: 'degauss (Ry)' },
              ]}
            />
            {p.parameter === 'ecutwfc' && (
              <NumberInput
                label="ecutrho / ecutwfc"
                placeholder="keep input ratio"
                min={2}
                max={16}
                value={p.dual}
                onChange={(v) => set('dual', v)}
              />
            )}
          </SimpleGrid>
          <TextInput
            label="Values"
            description="comma-separated; order from coarse to fine (the last value is the reference)"
            value={p.values}
            onChange={(e) => set('values', e.currentTarget.value)}
            classNames={{ input: 'qes-mono' }}
          />
          {p.parameter !== 'kpoints' && (
            <Group gap="xs" align="flex-end">
              <NumberInput w={100} size="xs" label="from" value={p.start} onChange={(v) => set('start', v)} />
              <NumberInput w={100} size="xs" label="to" value={p.stop} onChange={(v) => set('stop', v)} />
              <NumberInput w={100} size="xs" label="step" value={p.step} onChange={(v) => set('step', v)} />
              <Button size="xs" variant="light" onClick={fill}>
                Fill range
              </Button>
            </Group>
          )}
          <Text size="xs" c="dimmed">
            {parseValues(p.parameter, p.values).length} calculations, each in its own sub-directory.
          </Text>
        </Stack>
      );
    }
    case 'eos':
      return (
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput
            label="Number of volumes"
            min={5}
            max={25}
            value={p.npoints}
            onChange={(v) => set('npoints', v)}
            allowDecimal={false}
          />
          <NumberInput
            label="Max volume strain (±)"
            description="0.06 = ±6 %"
            min={0.01}
            max={0.3}
            step={0.01}
            decimalScale={3}
            value={p.max_strain}
            onChange={(v) => set('max_strain', v)}
          />
          <Switch
            label="Relax ions at each volume"
            mt={28}
            checked={p.relax_ions}
            onChange={(e) => set('relax_ions', e.currentTarget.checked)}
          />
        </SimpleGrid>
      );
  }
}
