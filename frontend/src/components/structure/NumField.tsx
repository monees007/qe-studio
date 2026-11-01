import { useEffect, useState } from 'react';
import { TextInput, type TextInputProps } from '@mantine/core';

/**
 * Numeric text field that keeps a local draft and commits on blur / Enter.
 * Avoids flooding the undo history while typing.
 */
export function NumField({
  value,
  onCommit,
  digits = 6,
  allowEmpty = false,
  ...rest
}: Omit<TextInputProps, 'value' | 'onChange'> & {
  value: number | null | undefined;
  onCommit: (v: number | null) => void;
  digits?: number;
  allowEmpty?: boolean;
}) {
  const show = (v: number | null | undefined) =>
    v === null || v === undefined || Number.isNaN(v) ? '' : String(Number(v.toFixed(digits)));
  const [draft, setDraft] = useState(show(value));
  const [err, setErr] = useState(false);
  useEffect(() => {
    setDraft(show(value));
    setErr(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, digits]);

  const commit = () => {
    const t = draft.trim().replace(/[dD]/, 'e');
    if (t === '') {
      if (allowEmpty) {
        if (value !== null && value !== undefined) onCommit(null);
        setErr(false);
      } else {
        setDraft(show(value));
      }
      return;
    }
    const v = Number(t);
    if (!Number.isFinite(v)) {
      setErr(true);
      return;
    }
    setErr(false);
    if (value === null || value === undefined || Math.abs(v - value) > 10 ** -(digits + 1)) onCommit(v);
  };

  return (
    <TextInput
      {...rest}
      value={draft}
      error={err || rest.error}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(show(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12.5 } }}
    />
  );
}
