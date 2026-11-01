// Schema-driven form editor for a QE input document (namelists + cards).
import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  HoverCard,
  Loader,
  Menu,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
} from '@mantine/core';
import { IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useSchema } from '../api/hooks';
import type { QEDoc, SchemaVar } from '../api/types';
import { PROGRAM_NAMELISTS } from '../lib/qeLanguage';
import { CardsEditor } from './editor/CardsEditor';
import { ValueInput } from './editor/ValueInput';
import { baseName, defaultFor, indexOf, type NLValue } from './editor/values';

export interface ParamFormProps {
  doc: QEDoc;
  program: string;
  onChange: (doc: QEDoc) => void;
  height?: number | string;
}

/** Variables documented as REQUIRED only under a condition on other variables. */
const CONDITIONAL_REQUIRED: Record<string, (vals: Record<string, unknown>) => boolean> = {
  gcscf_mu: (v) => v.lgcscf === true,
  ahc_nbnd: (v) => String(v.electron_phonon ?? '').toLowerCase() === 'ahc',
};

function VarHelp({ v, nl }: { v: SchemaVar; nl: string }) {
  return (
    <HoverCard width={460} shadow="md" openDelay={250} position="right" withinPortal>
      <HoverCard.Target>
        <ActionIcon size="xs" variant="transparent" color="gray" aria-label={`help for ${v.name}`}>
          <IconInfoCircle size={14} />
        </ActionIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap={4}>
          <Group gap={6}>
            <Text fw={600} ff="monospace">
              {v.name}
              {v.dimension ? '(i)' : ''}
            </Text>
            <Badge size="xs">{v.type}</Badge>
            <Badge size="xs" variant="outline">
              &amp;{nl}
            </Badge>
            {v.required && (
              <Badge size="xs" color="red">
                required
              </Badge>
            )}
          </Group>
          {v.label && v.label !== v.name && (
            <Text size="xs" fs="italic">
              {v.label}
            </Text>
          )}
          {v.default && (
            <Text size="xs">
              Default: <code>{v.default}</code>
            </Text>
          )}
          <ScrollArea.Autosize mah={300}>
            <Text size="xs" style={{ whiteSpace: 'pre-wrap' }} ff="monospace">
              {v.description || 'No description.'}
            </Text>
          </ScrollArea.Autosize>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function KeyCell({
  k,
  v,
  nl,
  onRename,
}: {
  k: string;
  v: SchemaVar | null;
  nl: string;
  onRename: (nk: string) => void;
}) {
  const idx = indexOf(k);
  return (
    <Group gap={4} wrap="nowrap">
      <Text ff="monospace" size="sm" c={v ? undefined : 'orange'}>
        {baseName(k)}
      </Text>
      {idx !== null && (
        <>
          <Text size="sm" ff="monospace">
            (
          </Text>
          <TextInput
            size="xs"
            w={Math.max(40, idx.length * 9 + 22)}
            value={idx}
            classNames={{ input: 'qes-mono' }}
            onChange={(e) => {
              const ni = e.currentTarget.value.replace(/[^\d,]/g, '');
              if (ni) onRename(`${baseName(k)}(${ni})`);
            }}
          />
          <Text size="sm" ff="monospace">
            )
          </Text>
        </>
      )}
      {v ? (
        <VarHelp v={v} nl={nl} />
      ) : (
        <Badge size="xs" color="orange" variant="outline">
          not in schema
        </Badge>
      )}
    </Group>
  );
}

function NamelistEditor({
  nl,
  values,
  vars,
  onChange,
}: {
  nl: string;
  values: Record<string, unknown>;
  vars: SchemaVar[];
  onChange: (vals: Record<string, unknown>) => void;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  const [idx, setIdx] = useState<number | string>(1);
  const byName = useMemo(() => Object.fromEntries(vars.map((v) => [v.name.toLowerCase(), v])), [vars]);
  const keys = Object.keys(values);
  const presentBase = new Set(keys.map((k) => baseName(k).toLowerCase()));
  const missingRequired = vars.filter(
    (v) =>
      v.required &&
      !presentBase.has(v.name.toLowerCase()) &&
      (CONDITIONAL_REQUIRED[v.name.toLowerCase()]?.(values) ?? true),
  );
  const addable = vars
    .filter((v) => v.dimension || !presentBase.has(v.name.toLowerCase()))
    .map((v) => ({ value: v.name, label: `${v.name}${v.dimension ? '(i)' : ''} — ${v.label || v.type}` }));
  const selected = adding ? byName[adding.toLowerCase()] : null;

  const add = (v: SchemaVar, index?: number | string) => {
    const key = v.dimension ? `${v.name}(${index || 1})` : v.name;
    onChange({ ...values, [key]: defaultFor(v) });
  };

  return (
    <Stack gap="xs">
      {missingRequired.length > 0 && (
        <Alert color="red" p="xs">
          <Group gap={6}>
            <Text size="sm">Missing required:</Text>
            {missingRequired.map((v) => (
              <Button key={v.name} size="compact-xs" variant="light" color="red" onClick={() => add(v)}>
                {v.name}
              </Button>
            ))}
          </Group>
        </Alert>
      )}
      {keys.length === 0 ? (
        <Text size="sm" c="dimmed">
          Empty namelist (QE defaults apply).
        </Text>
      ) : (
        <Table verticalSpacing={4} highlightOnHover>
          <Table.Tbody>
            {keys.map((k) => {
              const v = byName[baseName(k).toLowerCase()] ?? null;
              return (
                <Table.Tr key={k}>
                  <Table.Td w="40%">
                    <KeyCell
                      k={k}
                      v={v}
                      nl={nl}
                      onRename={(nk) => {
                        if (nk === k || nk in values) return;
                        const next: Record<string, unknown> = {};
                        for (const kk of keys) next[kk === k ? nk : kk] = values[kk];
                        onChange(next);
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <ValueInput
                      v={v}
                      value={values[k]}
                      onChange={(val: NLValue) => onChange({ ...values, [k]: val })}
                    />
                  </Table.Td>
                  <Table.Td w={36}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`remove ${k}`}
                      onClick={() => {
                        const next = { ...values };
                        delete next[k];
                        onChange(next);
                      }}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}
      <Group gap="xs" align="flex-end">
        <Select
          size="xs"
          w={340}
          searchable
          placeholder="Add parameter…"
          data={addable}
          value={adding}
          onChange={setAdding}
          nothingFoundMessage="no matching parameter"
          limit={60}
          comboboxProps={{ withinPortal: true }}
        />
        {selected?.dimension && (
          <NumberInput size="xs" w={80} label="index" min={1} value={idx} onChange={setIdx} allowDecimal={false} />
        )}
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={!selected}
          onClick={() => {
            if (selected) add(selected, idx);
            setAdding(null);
          }}
        >
          Add
        </Button>
        {selected && (
          <Text size="xs" c="dimmed" maw={360} lineClamp={2}>
            {selected.description.split('\n')[0]}
          </Text>
        )}
      </Group>
    </Stack>
  );
}

export function ParamForm({ doc, program, onChange, height }: ParamFormProps) {
  const { data: schema, isLoading } = useSchema(program);
  const order = PROGRAM_NAMELISTS[program] ?? Object.keys(schema?.namelists ?? {});
  const present = [
    ...order.filter((n) => n in doc.namelists),
    ...Object.keys(doc.namelists).filter((n) => !order.includes(n)),
  ];
  const absent = [...new Set([...order, ...Object.keys(schema?.namelists ?? {})])].filter((n) => !(n in doc.namelists));
  const [tab, setTab] = useState<string | null>(present[0] ?? 'cards');
  const active = tab && (present.includes(tab) || tab === 'cards') ? tab : (present[0] ?? 'cards');

  if (isLoading) return <Loader size="sm" />;

  return (
    <ScrollArea.Autosize mah={height ?? '100%'} type="auto">
      <Tabs value={active} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          {present.map((n) => (
            <Tabs.Tab key={n} value={n} ff="monospace">
              &amp;{n}{' '}
              <Badge size="xs" variant="light" ml={4}>
                {Object.keys(doc.namelists[n] ?? {}).length}
              </Badge>
            </Tabs.Tab>
          ))}
          <Tabs.Tab value="cards">{program === 'pw' ? `Cards (${doc.cards.length})` : 'Other lines'}</Tabs.Tab>
          {absent.length > 0 && (
            <Menu withinPortal position="bottom-start">
              <Menu.Target>
                <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} ml="xs" mt={6}>
                  namelist
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {absent.map((n) => (
                  <Menu.Item
                    key={n}
                    ff="monospace"
                    onClick={() => {
                      onChange({ ...doc, namelists: { ...doc.namelists, [n]: {} } });
                      setTab(n);
                    }}
                  >
                    &amp;{n}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )}
        </Tabs.List>
        {present.map((n) => (
          <Tabs.Panel key={n} value={n} pt="sm">
            <Group justify="flex-end" mb={4}>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() => {
                  const nls = { ...doc.namelists };
                  delete nls[n];
                  onChange({ ...doc, namelists: nls });
                  setTab(null);
                }}
              >
                Remove &amp;{n}
              </Button>
            </Group>
            <NamelistEditor
              nl={n}
              values={doc.namelists[n] ?? {}}
              vars={schema?.namelists[n] ?? []}
              onChange={(vals) => onChange({ ...doc, namelists: { ...doc.namelists, [n]: vals } })}
            />
          </Tabs.Panel>
        ))}
        <Tabs.Panel value="cards" pt="sm">
          <CardsEditor doc={doc} onChange={onChange} />
        </Tabs.Panel>
      </Tabs>
    </ScrollArea.Autosize>
  );
}
