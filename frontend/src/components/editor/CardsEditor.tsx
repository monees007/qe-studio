import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { usePseudos } from '../../api/hooks';
import type { QECard, QEDoc } from '../../api/types';
import { labelToElement } from '../../lib/elements';
import { PW_CARDS } from '../../lib/qeLanguage';

const CARD_OPTIONS: Record<string, string[]> = {
  ATOMIC_POSITIONS: ['crystal', 'angstrom', 'bohr', 'alat', 'crystal_sg'],
  K_POINTS: ['automatic', 'gamma', 'tpiba', 'crystal', 'tpiba_b', 'crystal_b', 'tpiba_c', 'crystal_c'],
  CELL_PARAMETERS: ['angstrom', 'bohr', 'alat'],
  HUBBARD: ['ortho-atomic', 'atomic', 'norm-atomic', 'wf', 'pseudo'],
};

function LinesEditor({
  lines,
  onChange,
  minRows = 3,
}: {
  lines: string[];
  onChange: (l: string[]) => void;
  minRows?: number;
}) {
  const [s, setS] = useState(lines.join('\n'));
  useEffect(() => setS(lines.join('\n')), [lines]);
  return (
    <Textarea
      autosize
      minRows={minRows}
      maxRows={18}
      value={s}
      classNames={{ input: 'qes-mono' }}
      onChange={(e) => setS(e.currentTarget.value)}
      onBlur={() => {
        const next = s
          .split('\n')
          .map((x) => x.trim())
          .filter((x) => x.length > 0);
        if (next.join('\n') !== lines.join('\n')) onChange(next);
      }}
    />
  );
}

function KPointsEditor({ card, onChange }: { card: QECard; onChange: (c: QECard) => void }) {
  const opt = card.option ?? 'tpiba';
  const nums = (card.lines[0] ?? '4 4 4 0 0 0').split(/\s+/).map((x) => parseInt(x, 10));
  const mesh = [0, 1, 2].map((i) => (Number.isFinite(nums[i]) ? nums[i] : 1));
  const shift = [3, 4, 5].map((i) => (Number.isFinite(nums[i]) ? nums[i] : 0));
  const setAuto = (m: number[], s: number[]) => onChange({ ...card, lines: [`${m.join(' ')} ${s.join(' ')}`] });
  return (
    <Stack gap="xs">
      {opt === 'automatic' ? (
        <Group gap="xs" align="flex-end">
          {mesh.map((n, i) => (
            <NumberInput
              key={i}
              size="xs"
              w={78}
              min={1}
              max={200}
              label={`n${'abc'[i]}`}
              value={n}
              allowDecimal={false}
              onChange={(x) => {
                if (typeof x !== 'number' || x < 1) return;
                const m = mesh.slice();
                m[i] = x;
                setAuto(m, shift);
              }}
            />
          ))}
          {shift.map((n, i) => (
            <Checkbox
              key={i}
              size="xs"
              label={`shift ${'abc'[i]}`}
              checked={n === 1}
              mb={6}
              onChange={(e) => {
                const s = shift.slice();
                s[i] = e.currentTarget.checked ? 1 : 0;
                setAuto(mesh, s);
              }}
            />
          ))}
          <Text size="xs" c="dimmed" mb={6}>
            {mesh[0] * mesh[1] * mesh[2]} points before symmetry
          </Text>
        </Group>
      ) : opt === 'gamma' ? (
        <Text size="sm" c="dimmed">
          Γ-point only (real wavefunctions, faster). No further lines.
        </Text>
      ) : (
        <>
          <Text size="xs" c="dimmed">
            First line: number of points; then one line per point “kx ky kz weight” (for *_b: weight = points to next
            vertex).
          </Text>
          <LinesEditor lines={card.lines} onChange={(l) => onChange({ ...card, lines: l })} />
        </>
      )}
    </Stack>
  );
}

function SpeciesEditor({ card, onChange }: { card: QECard; onChange: (c: QECard) => void }) {
  const { data } = usePseudos();
  const rows = card.lines.map((ln) => {
    const t = ln.trim().split(/\s+/);
    return { label: t[0] ?? '', mass: t[1] ?? '', pseudo: t[2] ?? '' };
  });
  const write = (r: typeof rows) => onChange({ ...card, lines: r.map((x) => `${x.label}  ${x.mass}  ${x.pseudo}`) });
  const known = useMemo(() => new Set((data?.pseudos ?? []).map((p) => p.filename)), [data]);
  return (
    <Stack gap={6}>
      <Table withRowBorders={false} verticalSpacing={4}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={120}>Label</Table.Th>
            <Table.Th w={120}>Mass (amu)</Table.Th>
            <Table.Th>Pseudopotential</Table.Th>
            <Table.Th w={36} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r, i) => {
            const el = labelToElement(r.label);
            const opts = (data?.pseudos ?? [])
              .filter((p) => (p.element ?? '').toLowerCase() === el.toLowerCase())
              .map((p) => ({
                value: p.filename,
                label: `${p.filename}${p.type ? ` · ${p.type}` : ''}${p.functional ? ` · ${p.functional}` : ''}`,
              }));
            if (r.pseudo && !opts.some((o) => o.value === r.pseudo))
              opts.unshift({ value: r.pseudo, label: `${r.pseudo} (not in library)` });
            return (
              <Table.Tr key={i}>
                <Table.Td>
                  <TextInput
                    size="xs"
                    value={r.label}
                    classNames={{ input: 'qes-mono' }}
                    onChange={(e) =>
                      write(rows.map((x, j) => (j === i ? { ...x, label: e.currentTarget.value.trim() } : x)))
                    }
                  />
                </Table.Td>
                <Table.Td>
                  <TextInput
                    size="xs"
                    value={r.mass}
                    classNames={{ input: 'qes-mono' }}
                    onChange={(e) =>
                      write(rows.map((x, j) => (j === i ? { ...x, mass: e.currentTarget.value.trim() } : x)))
                    }
                  />
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Select
                      size="xs"
                      style={{ flex: 1 }}
                      data={opts}
                      value={r.pseudo || null}
                      searchable
                      allowDeselect={false}
                      placeholder={opts.length ? 'choose' : `no ${el} pseudopotential in library`}
                      onChange={(x) => x && write(rows.map((y, j) => (j === i ? { ...y, pseudo: x } : y)))}
                    />
                    {r.pseudo && !known.has(r.pseudo) && (
                      <Tooltip label="Upload it on the Pseudopotentials page">
                        <Badge color="red" size="xs">
                          missing
                        </Badge>
                      </Tooltip>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => write(rows.filter((_, j) => j !== i))}
                    aria-label="remove species"
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => write([...rows, { label: 'X', mass: '1.0', pseudo: '' }])}
        >
          Add species
        </Button>
      </Group>
    </Stack>
  );
}

function countLines(c: QECard | undefined): number {
  return c ? c.lines.filter((l) => l.trim()).length : 0;
}

/** Cards (pw.x) or free trailing sections (ph.x q-point, matdyn.x q-path) of a QE document. */
export function CardsEditor({ doc, onChange }: { doc: QEDoc; onChange: (d: QEDoc) => void }) {
  const [addCard, setAddCard] = useState<string | null>(null);
  const setCard = (i: number, c: QECard) => {
    const cards = doc.cards.slice();
    cards[i] = c;
    const next: QEDoc = { ...doc, cards };
    // keep nat/ntyp consistent with the cards
    if (doc.program === 'pw' && next.namelists.SYSTEM) {
      const sys = { ...next.namelists.SYSTEM };
      if (c.name === 'ATOMIC_SPECIES' && 'ntyp' in sys) sys.ntyp = countLines(c);
      if (c.name === 'ATOMIC_POSITIONS' && 'nat' in sys) sys.nat = countLines(c);
      next.namelists = { ...next.namelists, SYSTEM: sys };
    }
    onChange(next);
  };

  if (doc.program !== 'pw') {
    return (
      <Stack gap="sm">
        {(doc.program === 'ph' || doc.preamble.length > 0) && (
          <TextInput
            label="Title line"
            description="ph.x reads the first line as the job title (required)"
            value={doc.preamble.join(' ')}
            onChange={(e) => onChange({ ...doc, preamble: [e.currentTarget.value] })}
          />
        )}
        <div>
          <Text size="sm" fw={500}>
            Lines after the namelists
          </Text>
          <Text size="xs" c="dimmed" mb={4}>
            {doc.program === 'matdyn'
              ? 'q-points: count, then “qx qy qz n” lines (with q_in_band_form).'
              : doc.program === 'ph'
                ? 'q-point “xq(1) xq(2) xq(3)” when ldisp is false.'
                : 'Usually empty for this program.'}
          </Text>
          <LinesEditor lines={doc.trailing} onChange={(l) => onChange({ ...doc, trailing: l })} />
        </div>
      </Stack>
    );
  }

  const missing = PW_CARDS.filter((c) => !doc.cards.some((x) => x.name === c));
  return (
    <Stack gap="sm">
      {!doc.cards.some((c) => c.name === 'K_POINTS') && (
        <Alert color="yellow" p="xs">
          No K_POINTS card — pw.x will use the Γ point only.
        </Alert>
      )}
      {doc.cards.map((c, i) => (
        <Paper key={`${c.name}-${i}`} withBorder p="sm">
          <Group justify="space-between" mb={6}>
            <Group gap="xs">
              <Text fw={600} ff="monospace" size="sm">
                {c.name}
              </Text>
              {CARD_OPTIONS[c.name] ? (
                <Select
                  size="xs"
                  w={150}
                  data={CARD_OPTIONS[c.name]}
                  value={c.option}
                  placeholder="(no option)"
                  clearable
                  onChange={(x) => setCard(i, { ...c, option: x })}
                />
              ) : (
                <TextInput
                  size="xs"
                  w={150}
                  placeholder="option"
                  value={c.option ?? ''}
                  onChange={(e) => setCard(i, { ...c, option: e.currentTarget.value.trim() || null })}
                />
              )}
            </Group>
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label="remove card"
              onClick={() => onChange({ ...doc, cards: doc.cards.filter((_, j) => j !== i) })}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
          {c.name === 'K_POINTS' ? (
            <KPointsEditor card={c} onChange={(x) => setCard(i, x)} />
          ) : c.name === 'ATOMIC_SPECIES' ? (
            <SpeciesEditor card={c} onChange={(x) => setCard(i, x)} />
          ) : (
            <LinesEditor lines={c.lines} onChange={(l) => setCard(i, { ...c, lines: l })} minRows={2} />
          )}
        </Paper>
      ))}
      {missing.length > 0 && (
        <Group gap="xs">
          <Select size="xs" w={220} placeholder="Add card…" data={missing} value={addCard} onChange={setAddCard} />
          <Button
            size="xs"
            variant="light"
            disabled={!addCard}
            onClick={() => {
              if (!addCard) return;
              const init: QECard =
                addCard === 'K_POINTS'
                  ? { name: 'K_POINTS', option: 'automatic', lines: ['4 4 4 0 0 0'] }
                  : { name: addCard, option: CARD_OPTIONS[addCard]?.[0] ?? null, lines: [] };
              onChange({ ...doc, cards: [...doc.cards, init] });
              setAddCard(null);
            }}
          >
            Add
          </Button>
        </Group>
      )}
    </Stack>
  );
}
