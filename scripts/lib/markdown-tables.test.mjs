// Tests for scripts/lib/markdown-tables.mjs.
// Run: node --test scripts/lib/markdown-tables.test.mjs
//
// The cases are GFM spec examples (https://github.github.com/gfm/, numbered
// as in cmark-gfm's test/spec.txt) and cases rendered by GitHub's own
// Markdown API. MARKDOWN_TABLES_LIVE=1 re-renders every case with
// `gh api markdown` and compares the table and code-block structure, so the
// expectations can be re-proved against GitHub at any time (needs `gh auth`;
// never run in CI).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { closesFence, fenceOpener, isDelimiterRow, scanMarkdown, splitRow } from './markdown-tables.mjs';

const LETTER = { blank: 'B', paragraph: 'P', heading: 'H', thematic: 'R', list: 'L', quote: 'Q', html: 'X', code: 'C', fence: 'F', table: 'T' };

/**
 * A scan reduced to comparable data: one letter per line (see LETTER),
 * fences as [openLine, closeLine], tables as [headerLine, headerCells,
 * ...rowCells], broken tables as [headerLine, headerCells, delimiterCells].
 */
function shape(md) {
  const scan = scanMarkdown(md);
  return {
    kinds: scan.kinds.map((k) => LETTER[k]).join(''),
    fences: scan.fences.map((f) => [f.openLine, f.closeLine]),
    tables: scan.tables.map((t) => [t.headerLine, t.header.length, ...t.rows.map((r) => r.cells.length)]),
    broken: scan.brokenTables.map((b) => [b.headerLine, b.header.length, b.delimiter.length]),
  };
}

// [name, markdown, kinds, tables?, broken?] — fences are checked through the F runs in `kinds`.
const SPEC_FENCES = [
  ['89', '```\n<\n >\n```', 'FFFF'],
  ['90', '~~~\n<\n >\n~~~', 'FFFF'],
  ['91: two backticks are inline code', '``\nfoo\n``', 'PPP'],
  ['92: a tilde line does not close a backtick fence', '```\naaa\n~~~\n```', 'FFFF'],
  ['93: a backtick line does not close a tilde fence', '~~~\naaa\n```\n~~~', 'FFFF'],
  ['94: a shorter run does not close', '````\naaa\n```\n``````', 'FFFF'],
  ['95', '~~~~\naaa\n~~~\n~~~~', 'FFFF'],
  ['96: an unclosed fence runs to the end', '```', 'F'],
  ['97', '`````\n\n```\naaa', 'FFFF'],
  ['99', '```\n\n  \n```', 'FFFF'],
  ['100', '```\n```', 'FF'],
  ['101', ' ```\n aaa\naaa\n```', 'FFFF'],
  ['102', '  ```\naaa\n  aaa\naaa\n  ```', 'FFFFF'],
  ['103', '   ```\n   aaa\n    aaa\n  aaa\n   ```', 'FFFFF'],
  ['104: four spaces is indented code, not a fence', '    ```\n    aaa\n    ```', 'CCC'],
  ['105', '```\naaa\n  ```', 'FFF'],
  ['106', '   ```\naaa\n  ```', 'FFF'],
  ['107: a closer indented four spaces is content', '```\naaa\n    ```', 'FFF'],
  ['108: a backtick info string cannot hold a backtick', '``` ```\naaa', 'PP'],
  ['109: a closer cannot have an info string', '~~~~~~\naaa\n~~~ ~~', 'FFF'],
  ['110: a fence interrupts a paragraph', 'foo\n```\nbar\n```\nbaz', 'PFFFP'],
  ['111', 'foo\n---\n~~~\nbar\n~~~\n# baz', 'PHFFFH'],
  ['112', '```ruby\ndef foo(x)\n  return 3\nend\n```', 'FFFFF'],
  ['113', '~~~~    ruby startline=3 $%@#$\ndef foo(x)\n  return 3\nend\n~~~~~~~', 'FFFFF'],
  ['114', '````;\n````', 'FF'],
  ['115', '``` aa ```\nfoo', 'PP'],
  ['116: a tilde info string may hold backticks', '~~~ aa ``` ~~~\nfoo\n~~~', 'FFF'],
  ['117', '```\n``` aaa\n```', 'FFF'],
];

const SPEC_TABLES = [
  ['198', '| foo | bar |\n| --- | --- |\n| baz | bim |', 'TTT', [[1, 2, 2]]],
  ['199: leading and trailing pipes are optional', '| abc | defghi |\n:-: | -----------:\nbar | baz', 'TTT', [[1, 2, 2]]],
  ['200: an escaped pipe does not split a cell', '| f\\|oo  |\n| ------ |\n| b `\\|` az |\n| b **\\|** im |', 'TTTT', [[1, 1, 1, 1]]],
  ['201: a blockquote ends the table', '| abc | def |\n| --- | --- |\n| bar | baz |\n> bar', 'TTTQ', [[1, 2, 2]]],
  ['202: a lazy line is a row; a blank line ends the table', '| abc | def |\n| --- | --- |\n| bar | baz |\nbar\n\nbar', 'TTTTBP', [[1, 2, 2, 1]]],
  ['203: a delimiter with another cell count is not a table', '| abc | def |\n| --- |\n| bar |', 'PPP', [], [[1, 2, 1]]],
  ['204: rows may have fewer or more cells', '| abc | def |\n| --- | --- |\n| bar |\n| bar | baz | boo |', 'TTTT', [[1, 2, 1, 3]]],
  ['205: a table may have no body', '| abc | def |\n| --- | --- |', 'TT', [[1, 2]]],
];

// Rendered with `gh api markdown -f mode=gfm` on 2026-10-21.
const T = '| a | b |\n| - | - |\n';
const GITHUB = [
  ['`- | -` after a header is a list item, not a delimiter', 'a | b\n- | -\nc | d', 'PLP'],
  ['`- | -` after a piped header is a list item too', '| a | b |\n- | -\n| c | d |', 'PLP'],
  ['a delimiter with fewer cells is plain text', '| a | b |\n| - |\n| c | d |', 'PPP', [], [[1, 2, 1]]],
  ['a delimiter with more cells is plain text', '| a | b |\n| - | - | - |\n| c | d |', 'PPP', [], [[1, 2, 3]]],
  ['only the last paragraph line is the header', 'intro\n| a | b |\n| - | - |\n| 1 | 2 |', 'PTTT', [[2, 2, 2]]],
  ['a lazy paragraph line indented four spaces can be the header', 'text\n    a | b\n| - | - |\n| c | d |', 'PTTT', [[2, 2, 2]]],
  ['a non-1 ordered item cannot interrupt a paragraph, so it can be the header', 'text\n2. a | b\n| - | - |', 'PTT', [[2, 2]]],
  ['HTML type 7 cannot interrupt a paragraph, so it can be the header', 'text\n<span>\n| - |', 'PTT', [[2, 1]]],
  ['a header without pipes', 'a\n| - |\n| c |', 'TTT', [[1, 1, 1]]],
  ['a table without any pipe', 'a\n:-:\nb', 'TTT', [[1, 1, 1]]],
  ['a lone `|` header is not a table', '|\n| - |', 'PP'],
  ['a dash-only line is a setext underline', '| a |\n---', 'PH'],
  ['`===` is a setext underline, not a delimiter', '| a |\n===\n| b |', 'PHP'],
  ['a single-column delimiter without pipes', '| a |\n:-:\n| b |', 'TTT', [[1, 1, 1]]],
  ['a delimiter without leading pipes', `| a | b |\n--- | ---\n| c | d |`, 'TTT', [[1, 2, 2]]],
  ['a tight delimiter', '| a | b |\n-|-\n| c | d |', 'TTT', [[1, 2, 2]]],
  ['alignment colons', '| a | b |\n:-: | -:\n| c | d |', 'TTT', [[1, 2, 2]]],
  ['a spaced dash is not a delimiter cell', '| a | b |\n| - - | - |', 'PP'],
  ['an escaped pipe in the delimiter joins its cells', '| a | b |\n| - \\| - |', 'PP'],
  ['a delimiter indented three spaces', '| a | b |\n   | - | - |\n| c | d |', 'TTT', [[1, 2, 2]]],
  ['a delimiter indented four spaces is paragraph text', '| a | b |\n    | - | - |\n| c | d |', 'PPP'],
  ['a table indented three spaces', '   | a | b |\n   | - | - |\n   | c | d |', 'TTT', [[1, 2, 2]]],
  ['a table indented four spaces is indented code', '    | a | b |\n    | - | - |', 'CC'],
  ['a heading line is not a header', '# a | b\n| - | - |\n| c | d |', 'HPP'],
  ['a blockquote line is not a header', '> a | b\n| - | - |', 'QQ'],
  ['lazy blockquote lines are not a table', '> quote\n| a | b |\n| - | - |', 'QQQ'],
  ['a table follows a heading directly', '# H\n| a |\n| - |\n| b |', 'HTTT', [[2, 1, 1]]],
  ['a table follows indented code directly', '    code\n| a |\n| - |', 'CTT', [[2, 1]]],
  ['a table indented under a list item', '- item\n  | a | b |\n  | - | - |\n  | c | d |', 'LTTT', [[2, 2, 2]]],
  ['a lazy delimiter after a list item is paragraph text', '- a | b\n| - | - |\n| c | d |', 'LPP'],
  ['inline triple backticks do not open a fence', '``` x ``` y\n| a | b |\n| - | - |', 'PTT', [[2, 2]]],
  ['two backticks do not open a fence', '``\n| a | b |\n| - | - |', 'PTT', [[2, 2]]],
  ['a tilde fence info string may hold tildes', '~~~ x ~~~\n| a | b |\n| - | - |\n~~~', 'FFFF'],
  ['a tilde fence info string may hold backticks', '~~~ `x`\n| a | b |\n| - | - |\n~~~', 'FFFF'],
  ['a tilde line does not close a backtick fence', '```\n~~~\n| a | b |\n| - | - |\n```', 'FFFFF'],
  ['a shorter run does not close a fence', '````\n```\n| a | b |\n| - | - |\n````\nafter', 'FFFFFP'],
  ['a closer with an info string is content', '```\n``` x\n| a | b |\n| - | - |\n```', 'FFFFF'],
  ['a closer indented four spaces is content', '```\n    ```\n| a | b |\n| - | - |\n```', 'FFFFF'],
  ['a closer indented three spaces closes', '```\n   ```\n| a | b |\n| - | - |', 'FFTT', [[3, 2]]],
  ['a closer with trailing spaces closes', '```\n```   \n| a | b |\n| - | - |', 'FFTT', [[3, 2]]],
  ['an indented fence hides its table', '   ```\n   | a | b |\n   | - | - |\n   ```\n| c |\n| - |', 'FFFFTT', [[5, 1]]],
  ['a fence interrupts a paragraph', 'text\n```\n| a | b |\n| - | - |\n```', 'PFFFF'],
  ['an unclosed fence hides the rest', '```\n| a | b |\n| - | - |', 'FFF'],
  ['an HTML type 6 block hides its table', '<div>\n| a | b |\n| - | - |\n</div>', 'XXXX'],
  ['a multi-line HTML comment hides its table', '<!--\n| a | b |\n| - | - |\n-->\n| c |\n| - |', 'XXXXTT', [[5, 1]]],
  ['inline HTML starts a paragraph that can hold a header', '<span>x</span>\n| a | b |\n| - | - |', 'PTT', [[2, 2]]],
  ['a backslash before an escaped pipe still escapes it', `${T}| x\\\\|y | z |`, 'TTT', [[1, 2, 2]]],
  ['an escaped pipe can start a row', `${T}\\| x | y`, 'TTT', [[1, 2, 2]]],
  ['an escaped trailing pipe is cell content', `${T}| c | d \\|`, 'TTT', [[1, 2, 2]]],
  ['a lazy row without pipes', `${T}foo`, 'TTT', [[1, 2, 1]]],
  ['a short lazy row', `${T}| c`, 'TTT', [[1, 2, 1]]],
  ['rows of empty cells', `${T}| |\n||\n| c |`, 'TTTTT', [[1, 2, 1, 1, 1]]],
  ['a lone `|` ends the table', `${T}|\n| c | d |`, 'TTPP', [[1, 2]]],
  ['a list item ends the table', `${T}| 1 | 2 |\n- x | y`, 'TTTL', [[1, 2, 2]]],
  ['a `+` list item ends the table', `${T}+ x`, 'TTL', [[1, 2]]],
  ['an indented list item ends the table', `${T}  - x | y`, 'TTL', [[1, 2]]],
  ['an empty list item ends the table', `${T}-`, 'TTL', [[1, 2]]],
  ['an ordered item ends the table', `${T}1. x | y`, 'TTL', [[1, 2]]],
  ['an ordered item with `)` ends the table', `${T}1) x`, 'TTL', [[1, 2]]],
  ['any ordered start number ends the table', `${T}2.`, 'TTL', [[1, 2]]],
  ['a ten-digit number is not a list item', `${T}1234567890. x`, 'TTT', [[1, 2, 1]]],
  ['a number without a space is not a list item', `${T}1.x | y`, 'TTT', [[1, 2, 2]]],
  ['emphasis is not a list item', `${T}*x* | y`, 'TTT', [[1, 2, 2]]],
  ['a blockquote ends the table', `${T}> x | y`, 'TTQ', [[1, 2]]],
  ['a heading ends the table', `${T}# x | y`, 'TTH', [[1, 2]]],
  ['`#` without a space is not a heading', `${T}#x | y`, 'TTT', [[1, 2, 2]]],
  ['a fence ends the table', `${T}\`\`\`\nx | y\n\`\`\``, 'TTFFF', [[1, 2]]],
  ['a `***` thematic break ends the table', `${T}***`, 'TTR', [[1, 2]]],
  ['a `---` thematic break ends the table', `${T}---`, 'TTR', [[1, 2]]],
  ['a `_ _ _` thematic break ends the table', `${T}_ _ _`, 'TTR', [[1, 2]]],
  ['`===` is a row', `${T}c | d\n===`, 'TTTT', [[1, 2, 2, 1]]],
  ['an HTML type 6 block ends the table', `${T}<div>x | y</div>`, 'TTX', [[1, 2]]],
  ['`<details>` ends the table', `${T}<details>x | y`, 'TTX', [[1, 2]]],
  ['an HTML comment ends the table', `${T}<!-- x | y -->`, 'TTX', [[1, 2]]],
  ['a lone HTML type 7 tag ends the table', `${T}<span>\n| c | d |`, 'TTXX', [[1, 2]]],
  ['a lone closing tag ends the table', `${T}</span>`, 'TTX', [[1, 2]]],
  ['inline HTML followed by text is a row', `${T}<span>x | y</span>`, 'TTT', [[1, 2, 2]]],
  ['`<br>` followed by text is a row', `${T}<br> x | y`, 'TTT', [[1, 2, 2]]],
  ['a row indented four spaces is indented code', `${T}    c | d`, 'TTC', [[1, 2]]],
  ['a tab-indented row is indented code', `${T}\t| c | d |`, 'TTC', [[1, 2]]],
];

const cases = [
  ...SPEC_FENCES.map((c) => [`GFM spec example ${c[0]}`, ...c.slice(1)]),
  ...SPEC_TABLES.map((c) => [`GFM spec example ${c[0]}`, ...c.slice(1)]),
  ...GITHUB.map((c) => [`GitHub: ${c[0]}`, ...c.slice(1)]),
];

for (const [name, md, kinds, tables = [], broken = []] of cases) {
  test(name, () => {
    const got = shape(md);
    assert.deepEqual({ kinds: got.kinds, tables: got.tables, broken: got.broken }, { kinds, tables, broken }, JSON.stringify(md));
  });
}

test('GFM spec example 200: cells keep their escapes; the code span pipe does not split', () => {
  const [table] = scanMarkdown(SPEC_TABLES[2][1]).tables;
  assert.deepEqual(table.header, ['f\\|oo']);
  assert.deepEqual(table.rows.map((r) => r.cells), [['b `\\|` az'], ['b **\\|** im']]);
});

test('fences report their opening and closing lines; an unclosed fence has a null closeLine', () => {
  assert.deepEqual(shape('x\n\n```js\na\n```\n\n~~~~\nb').fences, [[3, 5], [7, null]]);
});

test('splitRow: optional outer pipes, trimmed cells, escapes kept', () => {
  assert.deepEqual(splitRow('| a | b |'), ['a', 'b']);
  assert.deepEqual(splitRow('a | b'), ['a', 'b']);
  assert.deepEqual(splitRow('  | a | b  '), ['a', 'b']);
  assert.deepEqual(splitRow('| a | b |\r'), ['a', 'b']);
  assert.deepEqual(splitRow('| a || b |'), ['a', '', 'b']);
  assert.deepEqual(splitRow('| `"x"\\|"y"` | z |'), ['`"x"\\|"y"`', 'z']);
  assert.deepEqual(splitRow('| a\\\\|b |'), ['a\\\\|b']);
  assert.deepEqual(splitRow('| a \\|'), ['a \\|']);
  assert.deepEqual(splitRow('|'), []);
  assert.deepEqual(splitRow(''), []);
  assert.deepEqual(splitRow('| |'), ['']);
});

test('isDelimiterRow follows GFM delimiter cells and rejects setext, list and indented lines', () => {
  for (const ok of ['| --- | --- |', '|:--|--:|', ':-: | -', '-|-', '| - |', ':-:', '   | - |']) assert.equal(isDelimiterRow(ok), true, ok);
  for (const no of ['---', '- | -', '    | - |', '| - - |', '| --- | x |', '| : |', '', undefined, '|']) assert.equal(isDelimiterRow(no), false, String(no));
});

test('fenceOpener and closesFence', () => {
  assert.deepEqual(fenceOpener('```json'), { char: '`', length: 3 });
  assert.deepEqual(fenceOpener('   ~~~~ x `y`'), { char: '~', length: 4 });
  assert.equal(fenceOpener('    ```'), null);
  assert.equal(fenceOpener('```x``` y'), null);
  assert.equal(fenceOpener('``'), null);
  const fence = { char: '`', length: 4 };
  assert.equal(closesFence('````', fence), true);
  assert.equal(closesFence('   `````  ', fence), true);
  assert.equal(closesFence('```', fence), false);
  assert.equal(closesFence('~~~~', fence), false);
  assert.equal(closesFence('```` x', fence), false);
  assert.equal(closesFence('    ````', fence), false);
});

test('CRLF input reads like LF input', () => {
  const md = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```\n| x |\n```';
  assert.deepEqual(shape(md.replace(/\n/g, '\r\n')), shape(md));
});

/** Table [headerCells, bodyRows] pairs and the <pre> count in GitHub-rendered HTML. */
function htmlShape(html) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map(([t]) => {
    const head = t.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? '';
    const body = t.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? '';
    return [(head.match(/<th[\s>]/g) ?? []).length, (body.match(/<tr[\s>]/g) ?? []).length];
  });
  return { tables, pre: (html.match(/<pre[\s>]/g) ?? []).length };
}

function scanShape(md) {
  const scan = scanMarkdown(md);
  let pre = scan.fences.length;
  let inCode = false;
  for (const kind of scan.kinds) {
    if (kind === 'code' && !inCode) pre += 1;
    if (kind !== 'blank') inCode = kind === 'code';
  }
  return { tables: scan.tables.map((t) => [t.header.length, t.rows.length]), pre };
}

test('MARKDOWN_TABLES_LIVE=1: every case matches GitHub’s renderer', { skip: process.env.MARKDOWN_TABLES_LIVE !== '1' && 'set MARKDOWN_TABLES_LIVE=1 to render the cases with `gh api markdown`' }, () => {
  for (const [name, md] of cases) {
    const html = execFileSync('gh', ['api', 'markdown', '-f', `text=${md}`, '-f', 'mode=gfm'], { encoding: 'utf8' });
    assert.deepEqual(scanShape(md), htmlShape(html), `${name}: ${JSON.stringify(md)}`);
  }
});
