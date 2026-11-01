// Monaco language support for Quantum ESPRESSO input files:
// Monarch tokenizer, schema-driven completion (variables, enum values, cards, namelists) and hover docs.
import type * as Monaco from 'monaco-editor';
import { apiGet } from '../api/client';
import type { ProgramSchema, SchemaVar } from '../api/types';

export const QE_LANGUAGE_ID = 'qe';

export const PW_CARDS = [
  'ATOMIC_SPECIES',
  'ATOMIC_POSITIONS',
  'K_POINTS',
  'ADDITIONAL_K_POINTS',
  'CELL_PARAMETERS',
  'CONSTRAINTS',
  'OCCUPATIONS',
  'ATOMIC_VELOCITIES',
  'ATOMIC_FORCES',
  'SOLVENTS',
  'HUBBARD',
  'TOTAL_CHARGE',
];

export const PROGRAM_NAMELISTS: Record<string, string[]> = {
  pw: ['CONTROL', 'SYSTEM', 'ELECTRONS', 'IONS', 'CELL', 'FCP', 'RISM'],
  ph: ['INPUTPH'],
  pp: ['INPUTPP', 'PLOT'],
  dos: ['DOS'],
  projwfc: ['PROJWFC'],
  bands: ['BANDS'],
  q2r: ['INPUT'],
  matdyn: ['INPUT'],
  hp: ['INPUTHP'],
  neb: ['PATH'],
};

const CARD_OPTIONS: Record<string, string[]> = {
  ATOMIC_POSITIONS: ['crystal', 'angstrom', 'bohr', 'alat', 'crystal_sg'],
  K_POINTS: ['automatic', 'gamma', 'tpiba', 'crystal', 'tpiba_b', 'crystal_b', 'tpiba_c', 'crystal_c'],
  CELL_PARAMETERS: ['angstrom', 'bohr', 'alat'],
  HUBBARD: ['ortho-atomic', 'atomic', 'norm-atomic', 'wf', 'pseudo'],
};

/* ------------------------------------------------------------------ schema cache */
const schemaCache: Record<string, ProgramSchema> = {};
const schemaPending: Record<string, Promise<ProgramSchema | null>> = {};

export function ensureSchema(program: string): Promise<ProgramSchema | null> {
  if (schemaCache[program]) return Promise.resolve(schemaCache[program]);
  if (!schemaPending[program]) {
    schemaPending[program] = apiGet<ProgramSchema>(`/api/qe/schema/${program}`)
      .then((s) => {
        schemaCache[program] = s;
        return s;
      })
      .catch(() => {
        delete schemaPending[program];
        return null;
      });
  }
  return schemaPending[program];
}

function findVar(
  schema: ProgramSchema | undefined,
  name: string,
  namelist?: string | null,
): { nl: string; v: SchemaVar } | null {
  if (!schema) return null;
  const base = name.split('(')[0].toLowerCase();
  if (namelist && schema.namelists[namelist]) {
    const v = schema.namelists[namelist].find((x) => x.name.toLowerCase() === base);
    if (v) return { nl: namelist, v };
  }
  for (const [nl, vars] of Object.entries(schema.namelists)) {
    const v = vars.find((x) => x.name.toLowerCase() === base);
    if (v) return { nl, v };
  }
  return null;
}

export function varMarkdown(v: SchemaVar, nl: string, maxLen = 1800): string {
  const head = `**${v.name}**${v.dimension ? '(i)' : ''} — \`${v.type}\` in \`&${nl}\`${v.required ? ' · **required**' : ''}`;
  const parts = [head];
  if (v.label && v.label !== v.name) parts.push(`_${v.label}_`);
  if (v.default) parts.push(`Default: \`${v.default.replace(/\n/g, ' ')}\``);
  if (v.options?.length)
    parts.push(
      `Options: ${Array.from(new Set(v.options))
        .map((o) => `\`${o}\``)
        .join(', ')}`,
    );
  let desc = v.description || '';
  if (desc.length > maxLen) desc = desc.slice(0, maxLen) + ' …';
  if (desc) parts.push('```text\n' + desc + '\n```');
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ program per model */
const modelProgram = new WeakMap<object, string>();

export function setModelProgram(model: Monaco.editor.ITextModel, program: string): void {
  modelProgram.set(model, program);
  void ensureSchema(program);
}

function programOf(model: Monaco.editor.ITextModel): string {
  const p = modelProgram.get(model);
  if (p) return p;
  const text = model.getValue();
  const m = text.match(/^\s*&(\w+)/m);
  if (m) {
    const nl = m[1].toUpperCase();
    for (const [prog, nls] of Object.entries(PROGRAM_NAMELISTS)) if (nls.includes(nl) && prog !== 'matdyn') return prog;
  }
  return 'pw';
}

/** Remove comments and the contents of quoted strings (keeps quote chars). */
function scrub(line: string): string {
  let out = '';
  let q: string | null = null;
  for (const ch of line) {
    if (q) {
      if (ch === q) {
        q = null;
        out += ch;
      } else out += '_';
    } else if (ch === "'" || ch === '"') {
      q = ch;
      out += ch;
    } else if (ch === '!') {
      break;
    } else out += ch;
  }
  return out;
}

/** Namelist enclosing the given line (1-based), or null when outside any namelist. */
export function namelistAt(model: Monaco.editor.ITextModel, lineNumber: number, column: number): string | null {
  let current: string | null = null;
  for (let ln = 1; ln <= lineNumber; ln++) {
    let line = model.getLineContent(ln);
    if (ln === lineNumber) line = line.slice(0, column - 1);
    const s = scrub(line);
    const m = s.match(/^\s*&(\w+)/);
    if (m) {
      current = m[1].toUpperCase();
      const rest = s.slice(m[0].length);
      if (rest.includes('/')) current = null;
      continue;
    }
    if (current && (s.includes('/') || /^\s*&end\s*$/i.test(s))) current = null;
  }
  return current;
}

/* ------------------------------------------------------------------ registration */
let registered = false;

export function registerQELanguage(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: QE_LANGUAGE_ID, extensions: ['.in', '.pwi'], aliases: ['Quantum ESPRESSO input'] });
  monaco.languages.setLanguageConfiguration(QE_LANGUAGE_ID, {
    comments: { lineComment: '!' },
    autoClosingPairs: [
      { open: "'", close: "'", notIn: ['string', 'comment'] },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
      { open: '(', close: ')' },
      { open: '{', close: '}' },
    ],
    surroundingPairs: [
      { open: "'", close: "'" },
      { open: '(', close: ')' },
      { open: '{', close: '}' },
    ],
    wordPattern: /[A-Za-z_][\w-]*(\([\d,\s]*\))?|-?\d*\.\d+([eEdD][+-]?\d+)?/,
  });
  const cards = PW_CARDS.join('|');
  monaco.languages.setMonarchTokensProvider(QE_LANGUAGE_ID, {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^\s*&end\b/, 'keyword.namelist'],
        [/^(\s*)(&\w+)/, ['white', 'keyword.namelist']],
        [/^\s*\/\s*$/, 'keyword.namelist'],
        [
          new RegExp(`^(\\s*)(${cards})(\\s*)([{(][^})]*[})]|[A-Za-z_\\-]*)`),
          ['white', 'type.card', 'white', 'attribute.option'],
        ],
        [/'[^']*'?/, 'string'],
        [/"[^"]*"?/, 'string'],
        [/!.*$/, 'comment'],
        [/[A-Za-z_]\w*(\s*\([^)=]*\))?(?=\s*=)/, 'variable.key'],
        [/\.(true|false|t|f)\./, 'constant.logical'],
        [/[+-]?(\d+\.?\d*|\.\d+)([eEdDqQ][+-]?\d+)?/, 'number'],
        [/\/\s*$/, 'keyword.namelist'],
        [/[=,]/, 'delimiter'],
        [/^(\s*)([A-Za-z]{1,2}[\w+-]*)(?=\s+[-+.\d])/, ['white', 'identifier.species']],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);

  monaco.editor.defineTheme('qe-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword.namelist', foreground: '1864ab', fontStyle: 'bold' },
      { token: 'type.card', foreground: '087f5b', fontStyle: 'bold' },
      { token: 'attribute.option', foreground: '862e9c' },
      { token: 'variable.key', foreground: '1c3d5a' },
      { token: 'string', foreground: 'c92a2a' },
      { token: 'number', foreground: '0b7285' },
      { token: 'constant.logical', foreground: 'e67700', fontStyle: 'bold' },
      { token: 'comment', foreground: '868e96', fontStyle: 'italic' },
      { token: 'identifier.species', foreground: '5f3dc4' },
    ],
    colors: {},
  });
  monaco.editor.defineTheme('qe-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword.namelist', foreground: '74c0fc', fontStyle: 'bold' },
      { token: 'type.card', foreground: '63e6be', fontStyle: 'bold' },
      { token: 'attribute.option', foreground: 'e599f7' },
      { token: 'variable.key', foreground: 'a5d8ff' },
      { token: 'string', foreground: 'ffa8a8' },
      { token: 'number', foreground: '99e9f2' },
      { token: 'constant.logical', foreground: 'ffd43b', fontStyle: 'bold' },
      { token: 'comment', foreground: '868e96', fontStyle: 'italic' },
      { token: 'identifier.species', foreground: 'b197fc' },
    ],
    colors: { 'editor.background': '#1a1b1e' },
  });

  monaco.languages.registerCompletionItemProvider(QE_LANGUAGE_ID, {
    triggerCharacters: ['&', '=', "'", '.', ' '],
    provideCompletionItems: async (model, position) => {
      const program = programOf(model);
      const schema = (await ensureSchema(program)) ?? undefined;
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const nl = namelistAt(model, position.lineNumber, position.column);
      const K = monaco.languages.CompletionItemKind;
      const suggestions: Monaco.languages.CompletionItem[] = [];

      if (nl) {
        // value completion after "key ="
        const vm = linePrefix.match(/([A-Za-z_]\w*)(\s*\([^)]*\))?\s*=\s*(['"]?)([\w.+-]*)$/);
        if (vm) {
          const found = findVar(schema, vm[1], nl);
          if (!found) return { suggestions };
          const v = found.v;
          const quoted = vm[3] !== '';
          const before = model.getValueInRange({
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: Math.max(1, word.startColumn - 1),
            endColumn: word.startColumn,
          });
          if (v.type === 'logical') {
            const r = before === '.' ? { ...range, startColumn: range.startColumn - 1 } : range;
            for (const b of ['.true.', '.false.'])
              suggestions.push({ label: b, kind: K.Value, insertText: b, range: r });
          } else if (v.options?.length) {
            for (const o of Array.from(new Set(v.options))) {
              const insert = v.type === 'character' ? (quoted ? o : `'${o}'`) : o;
              suggestions.push({ label: o, kind: K.EnumMember, insertText: insert, range, detail: v.name });
            }
          }
          return { suggestions };
        }
        const vars = schema?.namelists[nl] ?? [];
        const present = new Set<string>();
        const full = model.getValue();
        const re = /^\s*([A-Za-z_]\w*)\s*(\(|=)/gm;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(full))) present.add(mm[1].toLowerCase());
        vars.forEach((v, i) => {
          const already = present.has(v.name.toLowerCase()) && !v.dimension;
          suggestions.push({
            label: { label: v.name, description: v.type, detail: v.required ? '  required' : undefined },
            kind: v.dimension ? K.Field : K.Variable,
            insertText: v.dimension ? `${v.name}(\${1:1}) = $0` : `${v.name} = $0`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: varMarkdown(v, nl, 1200) },
            sortText: `${already ? 'z' : v.required ? 'a' : 'm'}${String(i).padStart(4, '0')}`,
            range,
          });
        });
        if (/^\s*$/.test(linePrefix.slice(0, word.startColumn - 1))) {
          suggestions.push({
            label: '/',
            kind: K.Keyword,
            insertText: '/',
            range,
            detail: 'end of namelist',
            sortText: 'zz',
          });
        }
        return { suggestions };
      }

      // outside namelists: namelist names and (pw) cards
      const nls = PROGRAM_NAMELISTS[program] ?? [];
      const ampRange =
        linePrefix.endsWith('&') || /&\w*$/.test(linePrefix)
          ? { ...range, startColumn: linePrefix.lastIndexOf('&') + 1 }
          : range;
      for (const n of nls) {
        suggestions.push({
          label: `&${n}`,
          kind: K.Module,
          insertText: `&${n}\n  $0\n/`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range: ampRange,
          detail: 'namelist',
        });
      }
      if (program === 'pw') {
        for (const c of PW_CARDS) {
          const opts = CARD_OPTIONS[c];
          let snippet = c + (opts ? ` {\${1|${opts.join(',')}|}}` : '');
          if (c === 'K_POINTS')
            snippet = 'K_POINTS {${1|automatic,gamma,crystal_b,tpiba_b,crystal,tpiba|}}\n  ${2:4 4 4 0 0 0}';
          suggestions.push({
            label: c,
            kind: K.Struct,
            insertText: snippet,
            range,
            detail: 'card',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          });
        }
      }
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider(QE_LANGUAGE_ID, {
    provideHover: async (model, position) => {
      const w = model.getWordAtPosition(position);
      if (!w) return null;
      const program = programOf(model);
      const schema = (await ensureSchema(program)) ?? undefined;
      const nl = namelistAt(model, position.lineNumber, position.column);
      const found = findVar(schema, w.word, nl);
      if (!found) {
        const up = w.word.toUpperCase();
        if (PW_CARDS.includes(up) && program === 'pw') {
          const opts = CARD_OPTIONS[up];
          return {
            range: {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: w.startColumn,
              endColumn: w.endColumn,
            },
            contents: [
              { value: `**${up}** card${opts ? ` — options: ${opts.map((o) => `\`${o}\``).join(', ')}` : ''}` },
            ],
          };
        }
        return null;
      }
      return {
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: w.startColumn,
          endColumn: w.endColumn,
        },
        contents: [{ value: varMarkdown(found.v, found.nl) }],
      };
    },
  });
}
