// Heavy part of the QE editor: Monaco bundled locally (no CDN), loaded on demand by QEEditor.
import { useEffect, useRef } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { useComputedColorScheme } from '@mantine/core';
import { QE_LANGUAGE_ID, registerQELanguage, setModelProgram } from '../../lib/qeLanguage';
import type { QEEditorProps } from '../QEEditor';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });
registerQELanguage(monaco);

export default function MonacoQE({
  value,
  onChange,
  program = 'pw',
  readOnly = false,
  height = 400,
  issues,
  onSave,
  revealLine,
}: QEEditorProps) {
  const scheme = useComputedColorScheme('light');
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  const onMount: OnMount = (editor) => {
    editorRef.current = editor as unknown as monaco.editor.IStandaloneCodeEditor;
    const model = editor.getModel();
    if (model) setModelProgram(model as unknown as monaco.editor.ITextModel, program);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
    applyMarkers();
  };

  const applyMarkers = () => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;
    const n = model.getLineCount();
    const markers: monaco.editor.IMarkerData[] = (issues ?? [])
      .filter((i) => i.line != null && i.line >= 1 && i.line <= n)
      .map((i) => ({
        severity:
          i.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : i.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        message: i.message,
        startLineNumber: i.line as number,
        endLineNumber: i.line as number,
        startColumn: Math.max(1, model.getLineFirstNonWhitespaceColumn(i.line as number)),
        endColumn: model.getLineMaxColumn(i.line as number),
        source: 'QE Studio',
      }));
    monaco.editor.setModelMarkers(model, 'qe-validate', markers);
  };

  // re-apply markers whenever the issues or the text change
  useEffect(applyMarkers, [issues, value]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) setModelProgram(model, program);
  }, [program]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !revealLine) return;
    const n = ed.getModel()?.getLineCount() ?? 1;
    const line = Math.min(Math.max(1, revealLine), n);
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.setSelection(new monaco.Selection(line, 1, line, ed.getModel()?.getLineMaxColumn(line) ?? 1));
    ed.focus();
  }, [revealLine]);

  return (
    <Editor
      height={height}
      language={QE_LANGUAGE_ID}
      theme={scheme === 'dark' ? 'qe-dark' : 'qe-light'}
      value={value}
      onChange={(v) => onChange?.(v ?? '')}
      onMount={onMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        renderWhitespace: 'none',
        wordWrap: 'off',
        lineNumbersMinChars: 3,
        glyphMargin: false,
        folding: true,
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
        fixedOverflowWidgets: true,
        domReadOnly: readOnly,
        renderValidationDecorations: 'on',
      }}
    />
  );
}
