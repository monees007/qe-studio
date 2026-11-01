import { useEffect, useState } from 'react';
import { NumberInput, Select, Switch, TextInput } from '@mantine/core';
import type { SchemaVar } from '../../api/types';
import { formatValue, parseList, parseLoose, parseReal, type NLValue } from './values';

/** Text field that commits on blur / Enter (keeps partial input like "1e-" while typing). */
function CommitInput({
  value,
  onCommit,
  validate,
  placeholder,
}: {
  value: string;
  onCommit: (s: string) => void;
  validate?: (s: string) => string | null;
  placeholder?: string;
}) {
  const [s, setS] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setS(value);
    setErr(null);
  }, [value]);
  const commit = () => {
    if (s === value) return;
    const e = validate?.(s) ?? null;
    setErr(e);
    if (!e) onCommit(s);
  };
  return (
    <TextInput
      size="xs"
      value={s}
      error={err}
      placeholder={placeholder}
      classNames={{ input: 'qes-mono' }}
      onChange={(e) => setS(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setS(value);
      }}
    />
  );
}

export function ValueInput({
  v,
  value,
  onChange,
}: {
  v: SchemaVar | null;
  value: unknown;
  onChange: (val: NLValue) => void;
}) {
  if (Array.isArray(value)) {
    return (
      <CommitInput value={formatValue(value)} onCommit={(s) => onChange(parseList(s))} placeholder="comma-separated" />
    );
  }
  if (!v) {
    return <CommitInput value={formatValue(value)} onCommit={(s) => onChange(parseLoose(s))} />;
  }
  if (v.type === 'logical') {
    return (
      <Switch
        size="sm"
        checked={value === true}
        onChange={(e) => onChange(e.currentTarget.checked)}
        label={value === true ? '.true.' : '.false.'}
        styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
      />
    );
  }
  if (v.type === 'character') {
    const cur = value == null ? '' : String(value);
    if (v.options?.length) {
      const data = Array.from(new Set([...(cur && !v.options.includes(cur) ? [cur] : []), ...v.options]));
      return (
        <Select
          size="xs"
          data={data}
          value={cur || null}
          searchable
          allowDeselect={false}
          onChange={(x) => x != null && onChange(x)}
          classNames={{ input: 'qes-mono' }}
          comboboxProps={{ withinPortal: true }}
        />
      );
    }
    return <CommitInput value={cur} onCommit={(s) => onChange(s.replace(/^'|'$/g, ''))} />;
  }
  if (v.type === 'integer') {
    if (v.options?.length && typeof value === 'number' && v.options.includes(String(value))) {
      return (
        <Select
          size="xs"
          data={Array.from(new Set(v.options))}
          value={String(value)}
          searchable
          allowDeselect={false}
          onChange={(x) => x != null && onChange(parseInt(x, 10))}
          classNames={{ input: 'qes-mono' }}
        />
      );
    }
    return (
      <NumberInput
        size="xs"
        allowDecimal={false}
        value={typeof value === 'number' ? value : ''}
        onChange={(x) => typeof x === 'number' && onChange(x)}
        classNames={{ input: 'qes-mono' }}
      />
    );
  }
  // real: accept Fortran notation (1.0d-8)
  return (
    <CommitInput
      value={formatValue(value)}
      validate={(s) => (parseReal(s) === null ? 'not a real number' : null)}
      onCommit={(s) => onChange(parseReal(s) as number)}
    />
  );
}
