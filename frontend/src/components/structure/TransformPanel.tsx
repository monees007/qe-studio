import { useState } from 'react';
import {
  Accordion,
  Autocomplete,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import type { Structure } from '../../api/types';
import { SYMBOLS } from '../../lib/elements';

type Run = (op: string, params?: Record<string, unknown>) => void;

const num = (v: string | number, d = 0) => (typeof v === 'number' ? v : Number(v) || d);

export function TransformPanel({
  structure,
  selected,
  run,
  busy,
}: {
  structure: Structure;
  selected: number[];
  run: Run;
  busy: boolean;
}) {
  const [rep, setRep] = useState<[number, number, number]>([2, 2, 2]);
  const [useMatrix, setUseMatrix] = useState(false);
  const [mat, setMat] = useState<number[][]>([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  const [symprec, setSymprec] = useState('0.001');
  const [hkl, setHkl] = useState<[number, number, number]>([1, 1, 1]);
  const [layers, setLayers] = useState(4);
  const [vac, setVac] = useState(15);
  const [strainMode, setStrainMode] = useState<'iso' | 'voigt'>('iso');
  const [iso, setIso] = useState(1);
  const [voigt, setVoigt] = useState<number[]>([0, 0, 0, 0, 0, 0]);
  const [vfac, setVfac] = useState(1.0);
  const [vacAxis, setVacAxis] = useState('2');
  const [vacAmt, setVacAmt] = useState(15);
  const [stdev, setStdev] = useState(0.02);
  const [seed, setSeed] = useState(42);
  const [sub, setSub] = useState('');
  const [mask, setMask] = useState<[boolean, boolean, boolean]>([true, true, true]);

  const natoms = structure.sites.length;
  const newCount = useMatrix
    ? Math.round(
        Math.abs(
          mat[0][0] * (mat[1][1] * mat[2][2] - mat[1][2] * mat[2][1]) -
            mat[0][1] * (mat[1][0] * mat[2][2] - mat[1][2] * mat[2][0]) +
            mat[0][2] * (mat[1][0] * mat[2][1] - mat[1][1] * mat[2][0]),
        ),
      ) * natoms
    : rep[0] * rep[1] * rep[2] * natoms;
  const labels = [...Object.keys(structure.species), ...SYMBOLS.slice(1)].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <Accordion multiple defaultValue={['supercell', 'selection']} variant="separated" chevronPosition="left">
      <Accordion.Item value="supercell">
        <Accordion.Control>Supercell</Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            <Switch
              size="xs"
              label="General transformation matrix"
              checked={useMatrix}
              onChange={(e) => setUseMatrix(e.currentTarget.checked)}
            />
            {useMatrix ? (
              <SimpleGrid cols={3} spacing={4} maw={260}>
                {mat.flatMap((row, i) =>
                  row.map((v, j) => (
                    <NumberInput
                      key={`${i}${j}`}
                      size="xs"
                      value={v}
                      allowDecimal={false}
                      onChange={(x) =>
                        setMat((m) => m.map((r, a) => r.map((y, b) => (a === i && b === j ? num(x) : y))))
                      }
                    />
                  )),
                )}
              </SimpleGrid>
            ) : (
              <Group gap={6}>
                {[0, 1, 2].map((ax) => (
                  <NumberInput
                    key={ax}
                    size="xs"
                    w={70}
                    min={1}
                    max={20}
                    label={'abc'[ax]}
                    value={rep[ax]}
                    onChange={(v) =>
                      setRep((r) => {
                        const c = [...r] as [number, number, number];
                        c[ax] = Math.max(1, num(v, 1));
                        return c;
                      })
                    }
                  />
                ))}
              </Group>
            )}
            <Group gap="xs">
              <Button
                size="xs"
                loading={busy}
                disabled={newCount < 1 || newCount > 20000}
                onClick={() => run('supercell', useMatrix ? { matrix: mat } : { repeat: rep })}
              >
                Build supercell
              </Button>
              <Text size="xs" c={newCount > 20000 ? 'red' : 'dimmed'}>
                → {newCount} atoms
              </Text>
            </Group>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="cell">
        <Accordion.Control>Standardize cell (spglib)</Accordion.Control>
        <Accordion.Panel>
          <Group gap="xs" align="flex-end">
            <Select
              size="xs"
              w={120}
              label="Tolerance (Å)"
              value={symprec}
              onChange={(v) => setSymprec(v ?? '0.001')}
              data={['0.00001', '0.0001', '0.001', '0.01', '0.05', '0.1']}
            />
            <Button
              size="xs"
              variant="light"
              loading={busy}
              onClick={() => run('primitive', { symprec: Number(symprec) })}
            >
              Primitive
            </Button>
            <Button
              size="xs"
              variant="light"
              loading={busy}
              onClick={() => run('conventional', { symprec: Number(symprec) })}
            >
              Conventional
            </Button>
            <Button
              size="xs"
              variant="light"
              loading={busy}
              onClick={() => run('niggli', { symprec: Number(symprec) })}
            >
              Niggli reduce
            </Button>
          </Group>
          <Text size="xs" c="dimmed" mt={6}>
            Distinct species labels (e.g. Fe1/Fe2) are kept as different atom types, so magnetic orderings are
            preserved.
          </Text>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="slab">
        <Accordion.Control>Surface slab</Accordion.Control>
        <Accordion.Panel>
          <Group gap={6} align="flex-end">
            {[0, 1, 2].map((ax) => (
              <NumberInput
                key={ax}
                size="xs"
                w={60}
                label={'hkl'[ax]}
                value={hkl[ax]}
                allowDecimal={false}
                onChange={(v) =>
                  setHkl((r) => {
                    const c = [...r] as [number, number, number];
                    c[ax] = num(v);
                    return c;
                  })
                }
              />
            ))}
            <NumberInput
              size="xs"
              w={80}
              label="Layers"
              min={1}
              max={50}
              value={layers}
              onChange={(v) => setLayers(Math.max(1, num(v, 1)))}
            />
            <NumberInput
              size="xs"
              w={100}
              label="Vacuum (Å)"
              min={0}
              value={vac}
              decimalScale={2}
              onChange={(v) => setVac(num(v))}
            />
            <Button
              size="xs"
              loading={busy}
              disabled={hkl.every((x) => x === 0)}
              onClick={() => run('slab', { miller: hkl, layers, vacuum: vac })}
            >
              Cut slab
            </Button>
          </Group>
          <Text size="xs" c="dimmed" mt={6}>
            Miller indices refer to the current cell (use the conventional cell for cubic indices). Vacuum is the total
            gap along c.
          </Text>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="strain">
        <Accordion.Control>Strain / volume</Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            <Group gap="xs">
              <Select
                size="xs"
                w={170}
                value={strainMode}
                onChange={(v) => setStrainMode((v as 'iso' | 'voigt') ?? 'iso')}
                data={[
                  { value: 'iso', label: 'Isotropic strain (%)' },
                  { value: 'voigt', label: 'Voigt tensor (%)' },
                ]}
              />
              {strainMode === 'iso' ? (
                <NumberInput size="xs" w={90} value={iso} decimalScale={4} onChange={(v) => setIso(num(v))} />
              ) : (
                voigt.map((v, i) => (
                  <Tooltip key={i} label={['εxx', 'εyy', 'εzz', 'γyz', 'γxz', 'γxy'][i]}>
                    <NumberInput
                      size="xs"
                      w={64}
                      value={v}
                      decimalScale={4}
                      onChange={(x) => setVoigt((a) => a.map((y, j) => (j === i ? num(x) : y)))}
                    />
                  </Tooltip>
                ))
              )}
              <Button
                size="xs"
                loading={busy}
                onClick={() =>
                  run('strain', {
                    strain:
                      strainMode === 'iso' ? [iso / 100, iso / 100, iso / 100, 0, 0, 0] : voigt.map((x) => x / 100),
                  })
                }
              >
                Apply strain
              </Button>
            </Group>
            <Group gap="xs">
              <NumberInput
                size="xs"
                w={110}
                label="Volume factor"
                value={vfac}
                decimalScale={5}
                step={0.01}
                min={0.1}
                onChange={(v) => setVfac(num(v, 1))}
              />
              <Button
                size="xs"
                mt={18}
                variant="light"
                loading={busy}
                disabled={vfac <= 0 || vfac === 1}
                onClick={() => run('scale_volume', { factor: vfac })}
              >
                Scale volume
              </Button>
            </Group>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="misc">
        <Accordion.Control>Vacuum, wrap, perturb, sort</Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            <Group gap="xs" align="flex-end">
              <Select
                size="xs"
                w={90}
                label="Axis"
                value={vacAxis}
                onChange={(v) => setVacAxis(v ?? '2')}
                data={[
                  { value: '0', label: 'a' },
                  { value: '1', label: 'b' },
                  { value: '2', label: 'c' },
                ]}
              />
              <NumberInput
                size="xs"
                w={110}
                label="Vacuum (Å)"
                value={vacAmt}
                min={0}
                decimalScale={2}
                onChange={(v) => setVacAmt(num(v))}
              />
              <Button
                size="xs"
                variant="light"
                loading={busy}
                onClick={() => run('vacuum', { axis: Number(vacAxis), vacuum: vacAmt })}
              >
                Set vacuum
              </Button>
            </Group>
            <Group gap="xs">
              <Button size="xs" variant="light" loading={busy} onClick={() => run('wrap')}>
                Wrap into cell
              </Button>
              <Button size="xs" variant="light" loading={busy} onClick={() => run('center')}>
                Center in cell
              </Button>
              <Button size="xs" variant="light" loading={busy} onClick={() => run('sort')}>
                Sort by element
              </Button>
            </Group>
            <Group gap="xs" align="flex-end">
              <NumberInput
                size="xs"
                w={110}
                label="Rattle σ (Å)"
                value={stdev}
                min={0}
                max={1}
                step={0.01}
                decimalScale={4}
                onChange={(v) => setStdev(num(v))}
              />
              <NumberInput
                size="xs"
                w={80}
                label="Seed"
                value={seed}
                allowDecimal={false}
                onChange={(v) => setSeed(num(v))}
              />
              <Button size="xs" variant="light" loading={busy} onClick={() => run('rattle', { stdev, seed })}>
                Rattle positions
              </Button>
            </Group>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item value="selection">
        <Accordion.Control>Selected atoms ({selected.length})</Accordion.Control>
        <Accordion.Panel>
          {selected.length === 0 ? (
            <Text size="xs" c="dimmed">
              Select atoms in the viewer or the Atoms table.
            </Text>
          ) : (
            <Stack gap="xs">
              <Group gap="xs" align="flex-end">
                <Autocomplete
                  size="xs"
                  w={110}
                  label="New species"
                  placeholder="e.g. Ge, Fe2"
                  data={labels.slice(0, 150)}
                  value={sub}
                  onChange={setSub}
                  limit={20}
                />
                <Button
                  size="xs"
                  loading={busy}
                  disabled={!sub.trim()}
                  onClick={() => run('substitute', { indices: selected, species: sub.trim() })}
                >
                  Substitute
                </Button>
                <Button
                  size="xs"
                  color="red"
                  variant="light"
                  loading={busy}
                  onClick={() => run('delete', { indices: selected })}
                >
                  Delete
                </Button>
              </Group>
              <Group gap="xs" align="center">
                {[0, 1, 2].map((ax) => (
                  <Checkbox
                    key={ax}
                    size="xs"
                    label={'xyz'[ax]}
                    checked={mask[ax]}
                    onChange={(e) =>
                      setMask((m) => {
                        const c = [...m] as [boolean, boolean, boolean];
                        c[ax] = e.currentTarget.checked;
                        return c;
                      })
                    }
                  />
                ))}
                <Button
                  size="xs"
                  variant="light"
                  loading={busy}
                  onClick={() => run('fix', { indices: selected, mask })}
                >
                  Fix selected
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  loading={busy}
                  onClick={() => run('fix', { indices: selected, mask: [false, false, false] })}
                >
                  Unfix
                </Button>
              </Group>
            </Stack>
          )}
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
