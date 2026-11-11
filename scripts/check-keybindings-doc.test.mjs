import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  BINDINGS_FILE, DOCS_FILE, FE_DIR,
  canonicalChord, compare, parseBindings, parseDocRows, run,
} from './check-keybindings-doc.mjs';

const script = fileURLToPath(new URL('./check-keybindings-doc.mjs', import.meta.url));

// Synthetic sources in the shapes the pinned files use today; the tests never
// read the real component or doc, so an unrelated edit there cannot break them.
const bindingsTs = (entries, extra = '') => `export const SHORTCUT_DEFAULTS = {
${Object.entries(entries).map(([id, value]) => `  '${id}': '${value.replace(/\\/g, '\\\\')}',\n`).join('')}${extra}} as const;

export type ShortcutId = keyof typeof SHORTCUT_DEFAULTS;
`;

const docMd = (rows, { header = '| Shortcut | Action | Context | ID |' } = {}) => `# Shortcuts

| Shortcut | Action |
| -------- | ------ |
| \`Mod+P\` | Quick Open |

${header}
| --- | --- | --- | --- |
${rows.join('\n')}

Prose with | a pipe.
`;

test('canonicalChord reads the doc spelling and the table spelling alike', () => {
  const same = [
    ['Mod+Alt+→', 'mod+alt+right'],
    ['Mod+Alt+←', 'mod+alt+left'],
    ['Alt+Mod+ArrowRight', 'mod+alt+right'],
    ['Cmd+Shift+P', 'mod+shift+p'],
    ['Mod+\\', 'mod+\\'],
    ['Mod+,', 'mod+,'],
    ['Mod+?', 'mod+?'],
    ['Mod+Shift+]', 'mod+shift+]'],
    ['Ctrl+Shift+Tab', 'ctrl+shift+tab'],
    ['Option+Z', 'alt+z'],
    ['Mod+Alt+PageDown', 'mod+alt+pagedown'],
    ['Escape', 'esc'],
    ['Enter', 'enter'],
    ['Space', 'space'],
    ['/', '/'],
    ['@', '@'],
    ['h/j/k/l', 'h/j/k/l'],
    ['H/J/K/L', 'H/J/K/L'],
    ['q + 1-9', 'q + 1-9'],
    ['Mod+1-9', 'mod+1-9'],
  ];
  for (const [doc, table] of same) {
    assert.equal(canonicalChord(doc), canonicalChord(table), `${doc} vs ${table}`);
    assert.notEqual(canonicalChord(doc), null, doc);
  }
  const different = [
    ['Mod+Shift+]', 'mod+alt+right'],
    ['Ctrl+Tab', 'mod+tab'],
    ['H/J/K/L', 'h/j/k/l'],
    ['Mod+[', 'mod+shift+['],
  ];
  for (const [a, b] of different) assert.notEqual(canonicalChord(a), canonicalChord(b), `${a} vs ${b}`);
  for (const bad of ['', 'Hyper+K', 'Mod+', 'Mod+Mod+K', 'Mod+Shift']) assert.equal(canonicalChord(bad), null, bad);
});

test('parseBindings reads SHORTCUT_DEFAULTS and fails closed on another shape', () => {
  const bindings = parseBindings(bindingsTs({ 'panel.create-column-right': 'mod+\\', 'chat.send': 'enter' }));
  assert.deepEqual([...bindings], [['panel.create-column-right', 'mod+\\'], ['chat.send', 'enter']]);
  assert.throws(() => parseBindings('export const OTHER = {};'), /SHORTCUT_DEFAULTS = \{/);
  assert.throws(() => parseBindings(bindingsTs({ 'a.b': 'mod+k' }, '  ...EXTRA,\n')), /not a `'id': 'binding',` line/);
  assert.throws(() => parseBindings(bindingsTs({ 'a.b': 'mod+k' }, "  'a.b': 'mod+j',\n")), /more than once/);
});

test('parseDocRows reads tagged rows and rejects malformed tags', () => {
  const rows = parseDocRows(docMd([
    '| `Mod+Alt+→` | Focus Next Column | Anywhere | `panel.focus-next-column` |',
    '| `Mod+J` | Toggle Overlay | Anywhere | |',
    '| `Ctrl+\\`` | Toggle Overlay | Anywhere |  |',
  ]));
  assert.deepEqual(rows, [{ line: 9, id: 'panel.focus-next-column', chord: 'Mod+Alt+→' }]);
  assert.throws(
    () => parseDocRows(docMd(['| `Mod+K` / `Mod+P` | Palette | Anywhere | `global.command-palette-alt` |'])),
    /KEYBINDINGS\.md:9: .*one code span/,
  );
  assert.throws(() => parseDocRows(docMd(['| `Mod+K` | Palette | Anywhere | global.command-palette-alt |'])), /:9: .*code span/);
  assert.throws(() => parseDocRows(docMd(['| `Mod+K` | Palette | `global.command-palette-alt` |'])), /:9: .*4 cells/);
  assert.throws(() => parseDocRows('# Shortcuts\n\nNo tables.\n'), /no table with an ID column/);
});

const bindings = new Map([
  ['panel.focus-next-column', 'mod+alt+right'],
  ['panel.create-column-right', 'mod+\\'],
  ['leader.navigate-panels', 'h/j/k/l'],
]);
const row = (id, chord, line = 10) => ({ line, id, chord });
const allDocumented = [row('panel.create-column-right', 'Mod+\\', 11), row('leader.navigate-panels', 'h/j/k/l', 12)];

test('compare passes when every tagged row matches the table', () => {
  const result = compare({ bindings, rows: [row('panel.focus-next-column', 'Mod+Alt+→'), ...allDocumented], pending: {} });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.checked, 3);
});

test('compare fails a documented chord that disagrees with the table', () => {
  const result = compare({ bindings, rows: [row('panel.focus-next-column', 'Mod+Shift+]', 42), ...allDocumented], pending: {} });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /docs\/fe\/KEYBINDINGS\.md:42: panel\.focus-next-column is documented as `Mod\+Shift\+\]` but .*binds it to `mod\+alt\+right`/);
});

test('compare fails a table shortcut the doc does not list', () => {
  const result = compare({ bindings, rows: allDocumented, pending: {} });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /panel\.focus-next-column \(mod\+alt\+right\) has no row in docs\/fe\/KEYBINDINGS\.md/);
  assert.deepEqual(result.warnings, []);
});

test('compare only warns for a doc id the table does not define (docs-first addition)', () => {
  const result = compare({ bindings, rows: [row('panel.focus-next-column', 'Mod+Alt+→'), row('panel.new', 'Mod+G'), ...allDocumented], pending: {} });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /panel\.new, which .*does not define/);
});

test('a PENDING entry lets the docs lead a cloudlands-fe chord change', () => {
  const pending = { 'panel.focus-next-column': { from: 'mod+shift+]', to: 'mod+alt+right', reason: 'cloudlands-fe#4205' } };
  const pinned = new Map([...bindings, ['panel.focus-next-column', 'mod+shift+]']]);
  const docsFirst = compare({ bindings: pinned, rows: [row('panel.focus-next-column', 'Mod+Alt+→'), ...allDocumented], pending });
  assert.deepEqual(docsFirst.errors, []);
  assert.deepEqual(docsFirst.warnings, []);
  assert.equal(docsFirst.pending, 1);

  const landed = compare({ bindings, rows: [row('panel.focus-next-column', 'Mod+Alt+→'), ...allDocumented], pending });
  assert.deepEqual(landed.errors, []);
  assert.match(landed.warnings.join('\n'), /PENDING entry panel\.focus-next-column is stale/);

  const wrongDoc = compare({ bindings: pinned, rows: [row('panel.focus-next-column', 'Mod+Alt+PageDown'), ...allDocumented], pending });
  assert.equal(wrongDoc.errors.length, 1);

  const noReason = compare({ bindings: pinned, rows: [row('panel.focus-next-column', 'Mod+Alt+→'), ...allDocumented], pending: { 'panel.focus-next-column': { from: 'mod+shift+]', to: 'mod+alt+right' } } });
  assert.match(noReason.errors.join('\n'), /needs a reason/);
});

test('the CLI reads a checkout and exits non-zero on a stale row', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'check-keybindings-doc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  write(path.join(FE_DIR, BINDINGS_FILE), bindingsTs({ 'panel.focus-next-column': 'mod+alt+right' }));
  write(DOCS_FILE, docMd(['| `Mod+Alt+→` | Focus Next Column | Anywhere | `panel.focus-next-column` |']));
  assert.deepEqual(run(root, { log: () => {}, warn: () => {} }).errors, []);
  const ok = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1 documented shortcut matches/);

  write(path.join(FE_DIR, BINDINGS_FILE), bindingsTs({ 'panel.focus-next-column': 'mod+alt+n' }));
  const stale = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /documented as `Mod\+Alt\+→` but .*`mod\+alt\+n`/);
});
