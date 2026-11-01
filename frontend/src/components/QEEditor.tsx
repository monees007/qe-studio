// Code editor for QE input files. The Monaco implementation is lazy-loaded so pages
// that never show an editor do not download it.
import { lazy, Suspense } from 'react';
import { Center, Loader } from '@mantine/core';
import type { ValidationIssue } from '../api/types';

export interface QEEditorProps {
  value: string;
  onChange?: (v: string) => void;
  program?: string;
  readOnly?: boolean;
  height?: number | string;
  issues?: ValidationIssue[];
  onSave?: () => void;
  /** Imperative jump target (1-based line); changes trigger reveal. */
  revealLine?: number | null;
}

const MonacoQE = lazy(() => import('./editor/MonacoQE'));

export function QEEditor(props: QEEditorProps) {
  const h = props.height ?? 400;
  return (
    <div
      style={{
        height: h,
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-md)',
        overflow: 'hidden',
      }}
    >
      <Suspense
        fallback={
          <Center h="100%">
            <Loader size="sm" />
          </Center>
        }
      >
        <MonacoQE {...props} height="100%" />
      </Suspense>
    </div>
  );
}
