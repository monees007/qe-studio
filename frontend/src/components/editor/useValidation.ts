import { useEffect, useState } from 'react';
import { apiPost } from '../../api/client';
import type { ValidationResult } from '../../api/types';

/** Debounced server-side validation of a QE input. */
export function useValidation(text: string, program: string | null | undefined, delay = 600) {
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!text.trim()) {
      setResult(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      apiPost<ValidationResult>('/api/qe/validate', { text, program: program || null }, ctrl.signal)
        .then((r) => setResult(r))
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') setResult(null);
        })
        .finally(() => setLoading(false));
    }, delay);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, program, delay]);
  return { result, loading };
}

export function issueCounts(r: ValidationResult | null | undefined) {
  const issues = r?.issues ?? [];
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    infos: issues.filter((i) => i.severity === 'info').length,
  };
}

export function issuesAsText(r: ValidationResult | null | undefined): string {
  if (!r || r.issues.length === 0) return 'No validation issues reported by QE Studio.';
  return r.issues.map((i) => `[${i.severity}]${i.line ? ` line ${i.line}` : ''}: ${i.message}`).join('\n');
}
