// Interactive 3D crystal-structure viewer (react-three-fiber).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { GizmoHelper, GizmoViewport, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import {
  ActionIcon,
  Group,
  NumberInput,
  Paper,
  Popover,
  Slider,
  Stack,
  Switch,
  Text,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import { IconCamera, IconFocusCentered, IconPerspective, IconSettings, IconBox } from '@tabler/icons-react';
import { apiPost } from '../api/client';
import type { Structure, Vec3 } from '../api/types';
import { covalentRadius, elementColor, labelToElement } from '../lib/elements';
import { angleDeg, micVector, norm, type Mat3 } from './structure/geometry';

export interface ViewerMesh {
  vertices: number[]; // flat xyz (Angstrom)
  faces: number[]; // flat triangle indices
  normals?: number[];
  color: string;
  opacity?: number;
}

export interface CrystalViewerProps {
  structure: Structure | null;
  height?: number | string;
  repeat?: [number, number, number];
  showBonds?: boolean;
  showCell?: boolean;
  showAxes?: boolean;
  showLabels?: boolean;
  atomScale?: number;
  selected?: number[];
  onSelect?: (indices: number[], additive: boolean) => void;
  meshes?: ViewerMesh[];
  toolbar?: boolean;
}

type Bond = [number, number, [number, number, number]];

interface DisplayAtom {
  base: number;
  pos: Vec3;
  element: string;
  label: string;
}

const MAX_HALF_BONDS = 80000;
const MAX_LABELS = 300;

function useBonds(structure: Structure | null, enabled: boolean): Bond[] {
  const [bonds, setBonds] = useState<Bond[]>([]);
  const key = useMemo(
    () =>
      structure && enabled
        ? JSON.stringify([structure.cell, structure.sites.map((s) => [s.species, s.xyz]), structure.pbc])
        : '',
    [structure, enabled],
  );
  useEffect(() => {
    if (!key || !structure || structure.sites.length === 0) {
      setBonds([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      apiPost<{ bonds: Bond[] }>('/api/structures/bonds', { structure }, ctrl.signal)
        .then((r) => setBonds(r.bonds))
        .catch(() => setBonds([]));
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return bonds;
}

/* ------------------------------------------------------------------ scene parts */
function Atoms({
  atoms,
  scale,
  selectedSet,
  onPick,
  onHover,
}: {
  atoms: DisplayAtom[];
  scale: number;
  selectedSet: Set<number>;
  onPick: (base: number, additive: boolean) => void;
  onHover: (base: number | null) => void;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const haloRef = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const [segW, segH] = atoms.length > 2000 ? [12, 8] : atoms.length > 500 ? [18, 12] : [28, 20];
  const geo = useMemo(() => new THREE.SphereGeometry(1, segW, segH), [segW, segH]);
  useEffect(() => () => geo.dispose(), [geo]);
  const selectedAtoms = useMemo(() => atoms.filter((a) => selectedSet.has(a.base)), [atoms, selectedSet]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    atoms.forEach((a, i) => {
      const r = covalentRadius(a.element) * scale;
      m.makeScale(r, r, r).setPosition(a.pos[0], a.pos[1], a.pos[2]);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.set(elementColor(a.element)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [atoms, scale, invalidate]);

  useLayoutEffect(() => {
    const mesh = haloRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    selectedAtoms.forEach((a, i) => {
      const r = covalentRadius(a.element) * scale * 1.18 + 0.06;
      m.makeScale(r, r, r).setPosition(a.pos[0], a.pos[1], a.pos[2]);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [selectedAtoms, scale, invalidate]);

  if (atoms.length === 0) return null;
  return (
    <>
      <instancedMesh
        key={`atoms-${atoms.length}`}
        ref={ref}
        args={[geo, undefined, atoms.length]}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          if (e.delta > 4 || e.instanceId === undefined) return;
          e.stopPropagation();
          onPick(atoms[e.instanceId].base, e.shiftKey || e.ctrlKey || e.metaKey);
        }}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          if (e.instanceId !== undefined) onHover(atoms[e.instanceId].base);
        }}
        onPointerOut={() => onHover(null)}
      >
        <meshStandardMaterial roughness={0.42} metalness={0.08} />
      </instancedMesh>
      {selectedAtoms.length > 0 && (
        <instancedMesh
          key={`halo-${selectedAtoms.length}`}
          ref={haloRef}
          args={[geo, undefined, selectedAtoms.length]}
          raycast={() => null}
        >
          <meshBasicMaterial color="#ffd43b" transparent opacity={0.45} depthWrite={false} />
        </instancedMesh>
      )}
    </>
  );
}

function Bonds({
  atoms,
  bonds,
  structure,
  radius,
}: {
  atoms: DisplayAtom[];
  bonds: Bond[];
  structure: Structure;
  radius: number;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const geo = useMemo(() => new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), []);
  useEffect(() => () => geo.dispose(), [geo]);

  const halves = useMemo(() => {
    const n = structure.sites.length;
    const cell = structure.cell;
    const out: { a: Vec3; b: Vec3; color: string }[] = [];
    if (!bonds.length || !n) return out;
    const nimg = atoms.length / n;
    for (let img = 0; img < nimg && out.length < MAX_HALF_BONDS; img++) {
      for (const [i, j, off] of bonds) {
        const ai = atoms[img * n + i];
        const aj = atoms[img * n + j];
        if (!ai || !aj) continue;
        const shift: Vec3 = [
          off[0] * cell[0][0] + off[1] * cell[1][0] + off[2] * cell[2][0],
          off[0] * cell[0][1] + off[1] * cell[1][1] + off[2] * cell[2][1],
          off[0] * cell[0][2] + off[1] * cell[1][2] + off[2] * cell[2][2],
        ];
        // i -> image of j
        const pj: Vec3 = [aj.pos[0] + shift[0], aj.pos[1] + shift[1], aj.pos[2] + shift[2]];
        const mid1: Vec3 = [(ai.pos[0] + pj[0]) / 2, (ai.pos[1] + pj[1]) / 2, (ai.pos[2] + pj[2]) / 2];
        out.push({ a: ai.pos, b: mid1, color: elementColor(ai.element) });
        // j -> image of i (reverse direction)
        const pi: Vec3 = [ai.pos[0] - shift[0], ai.pos[1] - shift[1], ai.pos[2] - shift[2]];
        const mid2: Vec3 = [(aj.pos[0] + pi[0]) / 2, (aj.pos[1] + pi[1]) / 2, (aj.pos[2] + pi[2]) / 2];
        out.push({ a: aj.pos, b: mid2, color: elementColor(aj.element) });
      }
    }
    return out.slice(0, MAX_HALF_BONDS);
  }, [atoms, bonds, structure]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    halves.forEach((h, i) => {
      dir.set(h.b[0] - h.a[0], h.b[1] - h.a[1], h.b[2] - h.a[2]);
      const len = dir.length();
      dir.normalize();
      q.setFromUnitVectors(up, dir);
      pos.set((h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2, (h.a[2] + h.b[2]) / 2);
      s.set(radius, len, radius);
      m.compose(pos, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.set(h.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [halves, radius, invalidate]);

  if (!halves.length) return null;
  return (
    <instancedMesh key={`bonds-${halves.length}`} ref={ref} args={[geo, undefined, halves.length]} raycast={() => null}>
      <meshStandardMaterial roughness={0.5} metalness={0.05} />
    </instancedMesh>
  );
}

function CellBox({ cell, color }: { cell: Mat3; color: string }) {
  const geo = useMemo(() => {
    const [a, b, c] = cell;
    const p = (i: number, j: number, k: number): number[] => [
      i * a[0] + j * b[0] + k * c[0],
      i * a[1] + j * b[1] + k * c[1],
      i * a[2] + j * b[2] + k * c[2],
    ];
    const edges: [number[], number[]][] = [];
    for (const [i, j] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      edges.push([p(i, j, 0), p(i, j, 1)]);
      edges.push([p(i, 0, j), p(i, 1, j)]);
      edges.push([p(0, i, j), p(1, i, j)]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(edges.flat(2), 3));
    return g;
  }, [cell]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <lineSegments geometry={geo} raycast={() => null}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}

function LatticeVectors({ cell }: { cell: Mat3 }) {
  const items = useMemo(() => {
    const cols = ['#e03131', '#2f9e44', '#1971c2'];
    return cell.map((v, i) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, v[0], v[1], v[2]], 3));
      return { g, color: cols[i], tip: v, name: 'abc'[i] };
    });
  }, [cell]);
  useEffect(() => () => items.forEach((it) => it.g.dispose()), [items]);
  return (
    <>
      {items.map((it) => (
        <group key={it.name}>
          <lineSegments geometry={it.g} raycast={() => null}>
            <lineBasicMaterial color={it.color} linewidth={2} />
          </lineSegments>
          <LabelSprite position={it.tip} text={it.name} color={it.color} />
        </group>
      ))}
    </>
  );
}

function IsoMesh({ mesh }: { mesh: ViewerMesh }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices, 3));
    if (mesh.normals && mesh.normals.length === mesh.vertices.length)
      g.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
    g.setIndex(mesh.faces);
    if (!mesh.normals || mesh.normals.length !== mesh.vertices.length) g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }, [mesh]);
  useEffect(() => () => geo.dispose(), [geo]);
  const op = mesh.opacity ?? 0.55;
  return (
    <mesh geometry={geo} raycast={() => null} renderOrder={2}>
      <meshPhongMaterial
        color={mesh.color}
        side={THREE.DoubleSide}
        transparent={op < 1}
        opacity={op}
        depthWrite={op >= 1}
        shininess={40}
      />
    </mesh>
  );
}

function Labels({ atoms }: { atoms: DisplayAtom[] }) {
  return (
    <>
      {atoms.map((a, i) => (
        <LabelSprite
          key={i}
          position={a.pos}
          text={`${a.label}${a.base + 1}`}
          color="#111"
          background="rgba(255,255,255,0.75)"
        />
      ))}
    </>
  );
}

/**
 * Screen-space text label drawn into a canvas texture. Pure WebGL (no DOM overlay), so it
 * is unmounted together with the scene and needs no fonts from the network.
 */
function LabelSprite({
  position,
  text,
  color,
  background,
  size = 0.032,
}: {
  position: Vec3;
  text: string;
  color: string;
  background?: string;
  size?: number;
}) {
  const label = useMemo(() => {
    const px = 48;
    const font = `600 ${px}px Inter, system-ui, sans-serif`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = font;
    const pad = background ? 14 : 4;
    canvas.width = Math.ceil(ctx.measureText(text).width) + 2 * pad;
    canvas.height = px + 16;
    ctx.font = font; // resizing the canvas resets the context state
    if (background) {
      ctx.fillStyle = background;
      ctx.beginPath();
      ctx.roundRect(0, 0, canvas.width, canvas.height, 10);
      ctx.fill();
    } else {
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = 6;
    }
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, canvas.height / 2 + 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return { texture, aspect: canvas.width / canvas.height };
  }, [text, color, background]);
  useEffect(() => () => label.texture.dispose(), [label]);
  return (
    <sprite position={position} scale={[size * label.aspect, size, 1]} renderOrder={10} raycast={() => null}>
      <spriteMaterial map={label.texture} sizeAttenuation={false} depthTest={false} transparent />
    </sprite>
  );
}

function CameraRig({
  ortho,
  center,
  radius,
  viewKey,
  size,
}: {
  ortho: boolean;
  center: Vec3;
  radius: number;
  viewKey: number;
  size: { w: number; h: number };
}) {
  // generic oblique view, ~60° away from [111] (the bond axis of diamond/zincblende/rocksalt primitive cells)
  const dir = new THREE.Vector3(1.0, -0.45, 0.5).normalize();
  const c = new THREE.Vector3(...center);
  const r = Math.max(radius, 1.5);
  const fov = 35;
  const dist = (r / Math.sin(((fov / 2) * Math.PI) / 180)) * 0.92;
  const pos = c.clone().add(dir.clone().multiplyScalar(ortho ? r * 6 : dist));
  const zoom = Math.min(size.w, size.h) / (1.9 * r);
  return (
    <>
      {ortho ? (
        <OrthographicCamera
          key={`o-${viewKey}`}
          makeDefault
          position={pos.toArray()}
          zoom={zoom}
          near={-1000}
          far={10000}
          up={[0, 0, 1]}
        >
          <directionalLight position={[2, 3, 5]} intensity={1.6} />
        </OrthographicCamera>
      ) : (
        <PerspectiveCamera
          key={`p-${viewKey}`}
          makeDefault
          position={pos.toArray()}
          fov={fov}
          near={0.05}
          far={r * 200}
          up={[0, 0, 1]}
        >
          <directionalLight position={[2, 3, 5]} intensity={1.6} />
        </PerspectiveCamera>
      )}
      <OrbitControls key={`c-${viewKey}-${ortho}`} makeDefault target={center} enableDamping={false} />
    </>
  );
}

function Capture({ onReady }: { onReady: (fn: () => string) => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    onReady(() => {
      gl.render(scene, camera);
      return gl.domElement.toDataURL('image/png');
    });
  }, [gl, scene, camera, onReady]);
  return null;
}

/* ------------------------------------------------------------------ main component */
export function CrystalViewer({
  structure,
  height = 400,
  repeat,
  showBonds = true,
  showCell = true,
  showAxes = true,
  showLabels = false,
  atomScale = 0.45,
  selected,
  onSelect,
  meshes,
  toolbar = false,
}: CrystalViewerProps) {
  const scheme = useComputedColorScheme('light');
  const [opts, setOpts] = useState({ showBonds, showCell, showAxes, showLabels, atomScale, ortho: false });
  const [rep, setRep] = useState<[number, number, number]>(repeat ?? [1, 1, 1]);
  useEffect(
    () => setOpts((o) => ({ ...o, showBonds, showCell, showAxes, showLabels, atomScale })),
    [showBonds, showCell, showAxes, showLabels, atomScale],
  );
  useEffect(() => {
    if (repeat) setRep(repeat);
  }, [repeat?.[0], repeat?.[1], repeat?.[2]]); // eslint-disable-line react-hooks/exhaustive-deps

  const [innerSel, setInnerSel] = useState<number[]>([]);
  const sel = selected ?? innerSel;
  const selectedSet = useMemo(() => new Set(sel), [sel]);
  const [hover, setHover] = useState<number | null>(null);
  const [viewKey, setViewKey] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const captureRef = useRef<(() => string) | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 600, h: el.clientHeight || 400 }));
    ro.observe(el);
    setSize({ w: el.clientWidth || 600, h: el.clientHeight || 400 });
    return () => ro.disconnect();
  }, []);

  const atoms = useMemo<DisplayAtom[]>(() => {
    if (!structure) return [];
    const out: DisplayAtom[] = [];
    const [a, b, c] = structure.cell;
    const reps = rep.map((x) => Math.max(1, Math.min(10, Math.round(x || 1)))) as [number, number, number];
    for (let i = 0; i < reps[0]; i++)
      for (let j = 0; j < reps[1]; j++)
        for (let k = 0; k < reps[2]; k++) {
          const sh: Vec3 = [
            i * a[0] + j * b[0] + k * c[0],
            i * a[1] + j * b[1] + k * c[1],
            i * a[2] + j * b[2] + k * c[2],
          ];
          structure.sites.forEach((s, idx) => {
            const el = structure.species[s.species]?.element ?? labelToElement(s.species);
            out.push({
              base: idx,
              pos: [s.xyz[0] + sh[0], s.xyz[1] + sh[1], s.xyz[2] + sh[2]],
              element: el,
              label: s.species,
            });
          });
        }
    return out;
  }, [structure, rep]);

  const bonds = useBonds(structure, opts.showBonds && atoms.length <= 60000);

  const bounds = useMemo(() => {
    const box = new THREE.Box3();
    if (structure) {
      const [a, b, c] = structure.cell;
      for (const i of [0, rep[0]])
        for (const j of [0, rep[1]])
          for (const k of [0, rep[2]])
            box.expandByPoint(
              new THREE.Vector3(
                i * a[0] + j * b[0] + k * c[0],
                i * a[1] + j * b[1] + k * c[1],
                i * a[2] + j * b[2] + k * c[2],
              ),
            );
    }
    for (const at of atoms) box.expandByPoint(new THREE.Vector3(...at.pos));
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return { center: sphere.center.toArray() as Vec3, radius: sphere.radius };
  }, [atoms, structure, rep]);

  // re-fit the camera when a different structure (cell/atom count) is loaded
  const fitKey = structure
    ? `${structure.sites.length}|${structure.cell
        .flat()
        .map((x) => x.toFixed(2))
        .join(',')}|${rep.join('x')}`
    : '';
  useEffect(() => setViewKey((v) => v + 1), [fitKey]);

  const pick = useCallback(
    (base: number, additive: boolean) => {
      if (onSelect) {
        onSelect(additive ? (sel.includes(base) ? sel.filter((x) => x !== base) : [...sel, base]) : [base], additive);
      } else {
        setInnerSel((cur) =>
          additive
            ? cur.includes(base)
              ? cur.filter((x) => x !== base)
              : [...cur, base]
            : cur.length === 1 && cur[0] === base
              ? []
              : [base],
        );
      }
    },
    [onSelect, sel],
  );

  const clearSel = useCallback(() => {
    if (onSelect) onSelect([], false);
    else setInnerSel([]);
  }, [onSelect]);

  const screenshot = () => {
    const fn = captureRef.current;
    if (!fn) return;
    const url = fn();
    const a = document.createElement('a');
    a.href = url;
    a.download = `${structure?.name ?? 'structure'}.png`;
    a.click();
  };

  const labelAtoms = useMemo(() => {
    if (!opts.showLabels) return atoms.filter((a) => selectedSet.has(a.base)).slice(0, MAX_LABELS);
    return atoms.length <= MAX_LABELS ? atoms : atoms.filter((a) => selectedSet.has(a.base)).slice(0, MAX_LABELS);
  }, [atoms, opts.showLabels, selectedSet]);

  const measure = useMemo(() => {
    if (!structure || sel.length < 2) return null;
    const cell = structure.cell as Mat3;
    const P = sel
      .slice(0, 3)
      .map((i) => structure.sites[i]?.xyz)
      .filter(Boolean) as Vec3[];
    if (P.length < 2) return null;
    const d01 = micVector(P[0], P[1], cell, structure.pbc);
    const out: string[] = [`d(${sel[0] + 1}–${sel[1] + 1}) = ${norm(d01).toFixed(4)} Å`];
    if (P.length === 3) {
      const v10 = micVector(P[1], P[0], cell, structure.pbc);
      const v12 = micVector(P[1], P[2], cell, structure.pbc);
      out.push(`d(${sel[1] + 1}–${sel[2] + 1}) = ${norm(v12).toFixed(4)} Å`);
      out.push(`∠(${sel[0] + 1}–${sel[1] + 1}–${sel[2] + 1}) = ${angleDeg(v10, v12).toFixed(2)}°`);
    }
    return out;
  }, [structure, sel]);

  const dark = scheme === 'dark';
  const bg = dark ? '#141517' : '#f8f9fa';
  const cellColor = dark ? '#adb5bd' : '#495057';
  const hoverSite = hover !== null && structure ? structure.sites[hover] : null;

  return (
    <div ref={wrapRef} className="qes-viewer" style={{ height }}>
      {!structure || structure.sites.length === 0 ? (
        <Stack align="center" justify="center" h="100%">
          <Text c="dimmed" size="sm">
            No structure loaded
          </Text>
        </Stack>
      ) : (
        <Canvas
          frameloop="demand"
          dpr={[1, 2]}
          gl={{ preserveDrawingBuffer: true, antialias: true, alpha: false }}
          onPointerMissed={(e) => {
            if (e.type === 'click' && !(e as MouseEvent).shiftKey) clearSel();
          }}
          style={{ background: bg }}
        >
          <color attach="background" args={[bg]} />
          <ambientLight intensity={dark ? 0.55 : 0.7} />
          <hemisphereLight args={['#ffffff', '#666666', 0.35]} />
          <CameraRig ortho={opts.ortho} center={bounds.center} radius={bounds.radius} viewKey={viewKey} size={size} />
          <Atoms atoms={atoms} scale={opts.atomScale} selectedSet={selectedSet} onPick={pick} onHover={setHover} />
          {opts.showBonds && (
            <Bonds
              atoms={atoms}
              bonds={bonds}
              structure={structure}
              radius={0.11 * Math.max(0.6, opts.atomScale / 0.45)}
            />
          )}
          {opts.showCell && structure.pbc.some(Boolean) && <CellBox cell={structure.cell as Mat3} color={cellColor} />}
          {opts.showAxes && structure.pbc.some(Boolean) && <LatticeVectors cell={structure.cell as Mat3} />}
          {meshes?.map((m, i) => (
            <IsoMesh key={i} mesh={m} />
          ))}
          {labelAtoms.length > 0 && <Labels atoms={labelAtoms} />}
          {opts.showAxes && (
            <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
              <GizmoViewport axisColors={['#e03131', '#2f9e44', '#1971c2']} labelColor="white" />
            </GizmoHelper>
          )}
          <Capture onReady={(fn) => (captureRef.current = fn)} />
        </Canvas>
      )}

      {toolbar && structure && (
        <Paper className="qes-viewer-overlay" shadow="xs" p={4} style={{ top: 8, right: 8 }} withBorder>
          <Group gap={2}>
            <Tooltip label={opts.ortho ? 'Perspective projection' : 'Orthographic projection'}>
              <ActionIcon
                variant={opts.ortho ? 'filled' : 'subtle'}
                size="sm"
                onClick={() => setOpts((o) => ({ ...o, ortho: !o.ortho }))}
                aria-label="Toggle projection"
              >
                <IconPerspective size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Reset view">
              <ActionIcon variant="subtle" size="sm" onClick={() => setViewKey((v) => v + 1)} aria-label="Reset view">
                <IconFocusCentered size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Save PNG">
              <ActionIcon variant="subtle" size="sm" onClick={screenshot} aria-label="Screenshot">
                <IconCamera size={16} />
              </ActionIcon>
            </Tooltip>
            <Popover position="bottom-end" shadow="md" withinPortal>
              <Popover.Target>
                <ActionIcon variant="subtle" size="sm" aria-label="Display options">
                  <IconSettings size={16} />
                </ActionIcon>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs" w={220}>
                  <Switch
                    size="xs"
                    label="Bonds"
                    checked={opts.showBonds}
                    onChange={(e) => setOpts((o) => ({ ...o, showBonds: e.currentTarget.checked }))}
                  />
                  <Switch
                    size="xs"
                    label="Unit cell"
                    checked={opts.showCell}
                    onChange={(e) => setOpts((o) => ({ ...o, showCell: e.currentTarget.checked }))}
                  />
                  <Switch
                    size="xs"
                    label="Axes"
                    checked={opts.showAxes}
                    onChange={(e) => setOpts((o) => ({ ...o, showAxes: e.currentTarget.checked }))}
                  />
                  <Switch
                    size="xs"
                    label={`Labels${atoms.length > MAX_LABELS ? ' (selected only)' : ''}`}
                    checked={opts.showLabels}
                    onChange={(e) => setOpts((o) => ({ ...o, showLabels: e.currentTarget.checked }))}
                  />
                  <div>
                    <Text size="xs">Atom size</Text>
                    <Slider
                      size="xs"
                      min={0.1}
                      max={1.2}
                      step={0.05}
                      value={opts.atomScale}
                      onChange={(v) => setOpts((o) => ({ ...o, atomScale: v }))}
                    />
                  </div>
                  <div>
                    <Group gap={4}>
                      <IconBox size={14} />
                      <Text size="xs">Display repeat</Text>
                    </Group>
                    <Group gap={4} grow>
                      {[0, 1, 2].map((ax) => (
                        <NumberInput
                          key={ax}
                          size="xs"
                          min={1}
                          max={10}
                          value={rep[ax]}
                          disabled={!structure.pbc[ax]}
                          onChange={(v) =>
                            setRep((r) => {
                              const c = [...r] as [number, number, number];
                              c[ax] = Math.max(1, Math.min(10, Number(v) || 1));
                              return c;
                            })
                          }
                        />
                      ))}
                    </Group>
                  </div>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          </Group>
        </Paper>
      )}

      {structure && (hoverSite || sel.length > 0) && (
        <Paper
          className="qes-viewer-overlay"
          p={6}
          shadow="xs"
          withBorder
          style={{ left: 8, bottom: 8, maxWidth: '70%', opacity: 0.94 }}
        >
          <Stack gap={0}>
            {hoverSite && hover !== null && (
              <Text size="xs" ff="monospace">
                #{hover + 1} {hoverSite.species} ({hoverSite.xyz.map((x) => x.toFixed(3)).join(', ')}) Å
              </Text>
            )}
            {sel.length > 0 && (
              <Text size="xs" c="dimmed">
                selected:{' '}
                {sel
                  .slice(0, 8)
                  .map((i) => `${structure.sites[i]?.species ?? '?'}${i + 1}`)
                  .join(', ')}
                {sel.length > 8 ? ` … (+${sel.length - 8})` : ''}
              </Text>
            )}
            {measure?.map((m) => (
              <Text key={m} size="xs" ff="monospace">
                {m}
              </Text>
            ))}
          </Stack>
        </Paper>
      )}
    </div>
  );
}
