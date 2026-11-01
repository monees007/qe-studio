import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Button, Card, Code, Grid, Group, Slider, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconPlayerPause, IconPlayerPlay, IconAtom } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import type { PwResult } from '../../api/types';
import { CrystalViewer } from '../../components/CrystalViewer';
import { Plot } from '../../components/Plot';
import { fmt, RY_EV } from '../../lib/format';
import { useWorkbench } from '../../store/app';

/** Geometry optimization / MD: energy & force history, trajectory player, final coordinates. */
export function RelaxView({ pw, kind, name = 'relaxed' }: { pw: PwResult; kind?: string; name?: string }) {
  const traj = pw.trajectory ?? [];
  const steps = useMemo(() => pw.scf ?? [], [pw.scf]);
  const [frame, setFrame] = useState(Math.max(0, traj.length - 1));
  const [playing, setPlaying] = useState(false);
  const setStructure = useWorkbench((s) => s.setStructure);
  const navigate = useNavigate();
  const nat: number = pw.summary?.nat ?? traj[0]?.structure.sites.length ?? 1;
  const finalCoordsText: string = pw.summary?.relax?.final_coordinates ?? '';
  const effKind = kind ?? (finalCoordsText.includes('CELL_PARAMETERS') ? 'vc-relax' : 'relax');
  const variableCell = effKind === 'vc-relax' || effKind === 'vc-md';

  useEffect(() => setFrame(Math.max(0, traj.length - 1)), [traj.length]);
  useEffect(() => {
    if (!playing || traj.length < 2) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % traj.length), 450);
    return () => clearInterval(t);
  }, [playing, traj.length]);

  const energies = steps.map((s) => s.energy_ev);
  const eFinal = [...energies].reverse().find((e) => e !== null) ?? null;
  const pressures = steps.map((s) => s.pressure_kbar);
  const hasP = variableCell && pressures.some((p) => p !== null && p !== undefined);
  const data = useMemo(() => {
    const x = steps.map((_, i) => i + 1);
    const d: any[] = [
      {
        type: 'scatter',
        mode: 'lines+markers',
        name: 'ΔE (meV/atom)',
        x,
        y: energies.map((e) => (e !== null && eFinal !== null ? ((e - eFinal) * 1000) / nat : null)),
        line: { color: '#1c7ed6' },
        hovertemplate: 'step %{x}<br>ΔE %{y:.3f} meV/atom<extra></extra>',
      },
      {
        type: 'scatter',
        mode: 'lines+markers',
        name: 'max force (Ry/bohr)',
        x,
        y: steps.map((s) => s.max_force),
        yaxis: 'y2',
        line: { color: '#e8590c', dash: 'dot' },
        hovertemplate: 'step %{x}<br>F_max %{y:.2e} Ry/bohr<extra></extra>',
      },
    ];
    if (hasP) {
      d.push({
        type: 'scatter',
        mode: 'lines+markers',
        name: 'pressure (kbar)',
        x,
        y: pressures,
        yaxis: 'y3',
        line: { color: '#2b8a3e', dash: 'dash' },
        hovertemplate: 'step %{x}<br>P %{y:.2f} kbar<extra></extra>',
      });
    }
    return d;
  }, [steps, energies, eFinal, nat, hasP, pressures]);
  const layout = useMemo(() => {
    const l: any = {
      xaxis: { title: { text: 'ionic step' }, domain: [0, hasP ? 0.8 : 1] },
      yaxis: { title: { text: 'E − E_final (meV/atom)' } },
      yaxis2: {
        title: { text: 'max force (Ry/bohr)' },
        overlaying: 'y',
        side: 'right',
        type: 'log',
        showgrid: false,
        exponentformat: 'power',
      },
      legend: { orientation: 'h', y: -0.25 },
      margin: { l: 70, r: hasP ? 60 : 70, t: 20, b: 80 },
    };
    if (hasP)
      l.yaxis3 = {
        title: { text: 'P (kbar)' },
        overlaying: 'y',
        side: 'right',
        anchor: 'free',
        position: 0.94,
        showgrid: false,
      };
    return l;
  }, [hasP]);

  // Pulay-stress check for variable-cell runs: the final SCF (new G-vectors) vs last BFGS energy
  const relaxEnergies: number[] = pw.summary?.relax?.energies_ev ?? [];
  let pulay: number | null = null;
  if (variableCell && relaxEnergies.length >= 2) {
    pulay = (Math.abs(relaxEnergies[relaxEnergies.length - 1] - relaxEnergies[relaxEnergies.length - 2]) * 1000) / nat;
  }
  const cur = traj[Math.min(frame, traj.length - 1)];
  const finalCoords = finalCoordsText || undefined;
  const finalRy: number | undefined = pw.summary?.relax?.final_energy_ry;

  if (steps.length < 2 && traj.length < 2) return null;
  return (
    <Card>
      <Title order={5} mb="xs">
        Geometry optimization / dynamics
      </Title>
      {pulay !== null && pulay > 1 && (
        <Alert color="orange" mb="sm" title="Basis-set (Pulay) error after variable-cell relaxation">
          The final SCF at the relaxed cell differs by {fmt(pulay, 2)} meV/atom from the last BFGS step. Plane waves
          were fixed by the starting cell during the optimization; raise ecutwfc/ecutrho and relax again until this
          difference is small.
        </Alert>
      )}
      <Grid>
        <Grid.Col span={{ base: 12, md: traj.length ? 7 : 12 }}>
          <Plot data={data} layout={layout} height={340} filename="relaxation" />
        </Grid.Col>
        {traj.length > 0 && cur && (
          <Grid.Col span={{ base: 12, md: 5 }}>
            <Stack gap={6}>
              <CrystalViewer structure={cur.structure} height={260} toolbar />
              <Group gap="xs" wrap="nowrap">
                <Tooltip label={playing ? 'Pause' : 'Play trajectory'}>
                  <ActionIcon variant="light" onClick={() => setPlaying((p) => !p)} disabled={traj.length < 2}>
                    {playing ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />}
                  </ActionIcon>
                </Tooltip>
                <Slider
                  style={{ flex: 1 }}
                  min={0}
                  max={Math.max(0, traj.length - 1)}
                  value={frame}
                  onChange={(v) => {
                    setPlaying(false);
                    setFrame(v);
                  }}
                  label={(v) => `frame ${v + 1}`}
                />
              </Group>
              <Text size="xs" c="dimmed" className="qes-mono">
                frame {frame + 1}/{traj.length} · E = {fmt(cur.energy_ev, 6)} eV · V = {fmt(cur.volume, 3)} Å³
                {cur.max_force_ev_a != null ? ` · F_max = ${fmt(cur.max_force_ev_a, 4)} eV/Å` : ''}
              </Text>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconAtom size={14} />}
                onClick={() => {
                  const last = traj[traj.length - 1];
                  setStructure({ ...last.structure, name }, null, name);
                  navigate('/structures');
                }}
              >
                Open final structure in the structure editor
              </Button>
            </Stack>
          </Grid.Col>
        )}
      </Grid>
      {finalCoords && (
        <Stack gap={4} mt="sm">
          <Text size="sm" fw={500}>
            Final coordinates{finalRy != null ? ` (E = ${fmt(finalRy * RY_EV, 6)} eV)` : ''}
          </Text>
          <Code block style={{ maxHeight: 220, overflow: 'auto' }}>
            {finalCoords}
          </Code>
        </Stack>
      )}
    </Card>
  );
}
