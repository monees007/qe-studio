// The "edcore" entry bundles the editor with all editor features but without the
// built-in language contributions (TypeScript/CSS/HTML/JSON), keeping the bundle small.
declare module 'monaco-editor/esm/vs/editor/edcore.main' {
  export * from 'monaco-editor';
}
