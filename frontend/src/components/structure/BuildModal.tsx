import { useState } from 'react';
import {
  Alert,
  Autocomplete,
  Button,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { apiPost, errMsg } from '../../api/client';
import type { Structure } from '../../api/types';

type Kind = 'bulk' | 'spacegroup' | 'graphene' | 'mx2' | 'nanotube' | 'molecule';

const CRYSTALS = [
  'sc',
  'fcc',
  'bcc',
  'hcp',
  'diamond',
  'zincblende',
  'rocksalt',
  'cesiumchloride',
  'fluorite',
  'wurtzite',
];
const MOLECULES = [
  'H2O',
  'CH4',
  'CO2',
  'NH3',
  'N2',
  'O2',
  'H2',
  'CO',
  'C6H6',
  'C2H4',
  'C2H6',
  'CH3OH',
  'HCl',
  'SiH4',
  'H2O2',
  'NO2',
  'SO2',
  'HCN',
];
const num = (v: string | number) => (v === '' ? null : Number(v));

export function BuildModal({
  opened,
  onClose,
  onBuilt,
}: {
  opened: boolean;
  onClose: () => void;
  onBuilt: (s: Structure, name: string) => void;
}) {
  const [kind, setKind] = useState<Kind>('bulk');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // bulk
  const [formula, setFormula] = useState('Si');
  const [cs, setCs] = useState<string | null>('diamond');
  const [a, setA] = useState<number | null>(5.43);
  const [c, setC] = useState<number | null>(null);
  const [cubic, setCubic] = useState(false);
  const [ortho, setOrtho] = useState(false);
  // spacegroup
  const [sg, setSg] = useState(225);
  const [sgSymbols, setSgSymbols] = useState('Na, Cl');
  const [sgBasis, setSgBasis] = useState('0 0 0\n0.5 0.5 0.5');
  const [cellpar, setCellpar] = useState<number[]>([5.64, 5.64, 5.64, 90, 90, 90]);
  // 2D / tubes / molecules
  const [g2Formula, setG2Formula] = useState('C2');
  const [g2a, setG2a] = useState(2.46);
  const [vac, setVac] = useState(15);
  const [mx2Formula, setMx2Formula] = useState('MoS2');
  const [mx2Kind, setMx2Kind] = useState('2H');
  const [mx2a, setMx2a] = useState(3.18);
  const [mx2t, setMx2t] = useState(3.19);
  const [tn, setTn] = useState(6);
  const [tm, setTm] = useState(0);
  const [tl, setTl] = useState(1);
  const [tbond, setTbond] = useState(1.42);
  const [tsym, setTsym] = useState('C');
  const [mol, setMol] = useState('H2O');

  const params = (): Record<string, unknown> => {
    switch (kind) {
      case 'bulk':
        return { formula: formula.trim(), crystalstructure: cs, a, c, cubic, orthorhombic: ortho };
      case 'spacegroup': {
        const symbols = sgSymbols
          .split(/[,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean);
        const basis = sgBasis
          .split('\n')
          .map((l) =>
            l
              .trim()
              .split(/[\s,]+/)
              .map(Number),
          )
          .filter((r) => r.length === 3 && r.every(Number.isFinite));
        return { symbols, basis, spacegroup: sg, cellpar };
      }
      case 'graphene':
        return { formula: g2Formula, a: g2a, vacuum: vac };
      case 'mx2':
        return { formula: mx2Formula, kind: mx2Kind, a: mx2a, thickness: mx2t, vacuum: vac };
      case 'nanotube':
        return { n: tn, m: tm, length: tl, bond: tbond, symbol: tsym, vacuum: vac };
      default:
        return { name: mol, vacuum: vac / 2 };
    }
  };

  const build = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost<{ structure: Structure }>('/api/structures/build', { kind, params: params() });
      onBuilt(r.structure, r.structure.name ?? kind);
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Build structure" size="lg">
      <Stack gap="sm">
        <SegmentedControl
          size="xs"
          value={kind}
          onChange={(v) => setKind(v as Kind)}
          fullWidth
          data={[
            { value: 'bulk', label: 'Bulk' },
            { value: 'spacegroup', label: 'Space group' },
            { value: 'graphene', label: 'Graphene-like' },
            { value: 'mx2', label: 'MX₂' },
            { value: 'nanotube', label: 'Nanotube' },
            { value: 'molecule', label: 'Molecule' },
          ]}
        />
        {kind === 'bulk' && (
          <SimpleGrid cols={2} spacing="xs">
            <TextInput
              label="Formula / element"
              description="e.g. Si, Cu, NaCl, GaAs, ZnO"
              value={formula}
              onChange={(e) => setFormula(e.currentTarget.value)}
            />
            <Select
              label="Crystal structure"
              description="empty = ASE reference structure"
              data={CRYSTALS}
              value={cs}
              onChange={setCs}
              clearable
            />
            <NumberInput
              label="a (Å)"
              description="empty = ASE reference value"
              value={a ?? ''}
              decimalScale={5}
              min={0.5}
              onChange={(v) => setA(num(v))}
            />
            <NumberInput
              label="c (Å)"
              description="hcp / wurtzite only"
              value={c ?? ''}
              decimalScale={5}
              min={0.5}
              onChange={(v) => setC(num(v))}
            />
            <Switch
              label="Cubic (conventional) cell"
              checked={cubic}
              onChange={(e) => setCubic(e.currentTarget.checked)}
            />
            <Switch label="Orthorhombic cell" checked={ortho} onChange={(e) => setOrtho(e.currentTarget.checked)} />
          </SimpleGrid>
        )}
        {kind === 'spacegroup' && (
          <Stack gap="xs">
            <Group grow>
              <NumberInput
                label="Space group (1–230)"
                min={1}
                max={230}
                value={sg}
                onChange={(v) => setSg(Number(v) || 1)}
              />
              <TextInput
                label="Symbols (one per basis line)"
                value={sgSymbols}
                onChange={(e) => setSgSymbols(e.currentTarget.value)}
              />
            </Group>
            <Textarea
              label="Asymmetric-unit basis (fractional x y z per line)"
              autosize
              minRows={3}
              value={sgBasis}
              onChange={(e) => setSgBasis(e.currentTarget.value)}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />
            <SimpleGrid cols={6} spacing={4}>
              {['a', 'b', 'c', 'α', 'β', 'γ'].map((l, i) => (
                <NumberInput
                  key={l}
                  size="xs"
                  label={l}
                  value={cellpar[i]}
                  decimalScale={4}
                  onChange={(v) => setCellpar((p) => p.map((x, j) => (j === i ? Number(v) || 0 : x)))}
                />
              ))}
            </SimpleGrid>
            <Text size="xs" c="dimmed">
              Standard setting (setting 1) of the International Tables, generated with ase.spacegroup.crystal.
            </Text>
          </Stack>
        )}
        {kind === 'graphene' && (
          <SimpleGrid cols={3} spacing="xs">
            <TextInput
              label="Formula"
              description="C2, BN, …"
              value={g2Formula}
              onChange={(e) => setG2Formula(e.currentTarget.value)}
            />
            <NumberInput label="a (Å)" value={g2a} decimalScale={4} onChange={(v) => setG2a(Number(v) || 2.46)} />
            <NumberInput label="Vacuum (Å)" value={vac} decimalScale={2} onChange={(v) => setVac(Number(v) || 0)} />
          </SimpleGrid>
        )}
        {kind === 'mx2' && (
          <SimpleGrid cols={3} spacing="xs">
            <TextInput label="Formula" value={mx2Formula} onChange={(e) => setMx2Formula(e.currentTarget.value)} />
            <Select label="Polytype" data={['2H', '1T']} value={mx2Kind} onChange={(v) => setMx2Kind(v ?? '2H')} />
            <NumberInput label="a (Å)" value={mx2a} decimalScale={4} onChange={(v) => setMx2a(Number(v) || 3.18)} />
            <NumberInput
              label="X–X thickness (Å)"
              value={mx2t}
              decimalScale={4}
              onChange={(v) => setMx2t(Number(v) || 3.19)}
            />
            <NumberInput label="Vacuum (Å)" value={vac} decimalScale={2} onChange={(v) => setVac(Number(v) || 0)} />
          </SimpleGrid>
        )}
        {kind === 'nanotube' && (
          <SimpleGrid cols={3} spacing="xs">
            <NumberInput label="n" min={1} value={tn} onChange={(v) => setTn(Number(v) || 1)} />
            <NumberInput label="m" min={0} value={tm} onChange={(v) => setTm(Number(v) || 0)} />
            <NumberInput label="Length (unit cells)" min={1} value={tl} onChange={(v) => setTl(Number(v) || 1)} />
            <NumberInput
              label="Bond length (Å)"
              value={tbond}
              decimalScale={3}
              onChange={(v) => setTbond(Number(v) || 1.42)}
            />
            <TextInput label="Element" value={tsym} onChange={(e) => setTsym(e.currentTarget.value)} />
            <NumberInput label="Vacuum (Å)" value={vac} decimalScale={2} onChange={(v) => setVac(Number(v) || 0)} />
          </SimpleGrid>
        )}
        {kind === 'molecule' && (
          <Group grow>
            <Autocomplete label="Molecule (ASE g2 set name)" data={MOLECULES} value={mol} onChange={setMol} />
            <NumberInput
              label="Box padding (Å)"
              description="vacuum around the molecule"
              value={vac}
              decimalScale={2}
              onChange={(v) => setVac(Number(v) || 0)}
            />
          </Group>
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
          <Button onClick={build} loading={busy}>
            Build
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
