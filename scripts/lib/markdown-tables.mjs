// Shared Markdown block scanner for the docs checks: fenced code, indented
// code, HTML blocks and GitHub (GFM) tables, read the way GitHub renders them.
//
// Every docs check that needs to know "is this line a table row?" or "is this
// line inside a code fence?" must ask this module instead of matching lines
// itself; three private parsers that disagreed with GitHub (and with each
// other) are why it exists (intent-hq/intent#7482). The rules follow the GFM
// spec (https://github.github.com/gfm/), sections 4.4 indented code, 4.5
// fenced code, 4.6 HTML blocks and 4.10 tables, and were checked against
// GitHub's own renderer; scripts/lib/markdown-tables.test.mjs pins them with
// the spec's examples and GitHub-rendered cases.
//
// Scope: top-level blocks. Container blocks are approximated: a list item's
// first line is never a table header, and its continuation lines are read as
// top-level lines (so a table or fence indented under a list item is found);
// a blockquote line and its lazy continuation lines are never table or fence
// lines. Tables inside blockquotes, and fences indented four or more spaces
// inside nested list items, are not recognised.

const TAB_STOP = 4;

/** Column of the first non-blank character (tabs advance to the next multiple of 4) and its string offset. */
function indentOf(line) {
  let col = 0;
  let offset = 0;
  for (; offset < line.length; offset += 1) {
    if (line[offset] === ' ') col += 1;
    else if (line[offset] === '\t') col += TAB_STOP - (col % TAB_STOP);
    else break;
  }
  return { col, rest: line.slice(offset) };
}

const isBlank = (line) => /^[ \t]*$/.test(line);

/** The line without its 0–3 columns of indentation, or null when it is indented four or more columns. */
function unindented(line) {
  if (line === undefined) return null;
  const { col, rest } = indentOf(line);
  return col <= 3 ? rest : null;
}

/**
 * The fence a line opens (GFM 4.5), or null: 0–3 spaces of indentation, then
 * three or more backticks or tildes. A backtick fence's info string cannot
 * contain a backtick, so a line like "```x``` y" is inline code, not a fence.
 * @returns {{ char: '`' | '~', length: number } | null}
 */
export function fenceOpener(line) {
  const m = unindented(line)?.match(/^(`{3,}|~{3,})(.*)$/);
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
  return { char: m[1][0], length: m[1].length };
}

/**
 * Whether `line` closes `fence` (GFM 4.5): 0–3 spaces of indentation, a run of
 * the same character at least as long as the opener, then only spaces or tabs.
 */
export function closesFence(line, fence) {
  const m = unindented(line)?.match(/^(`{3,}|~{3,})[ \t]*$/);
  return Boolean(m) && m[1][0] === fence.char && m[1].length >= fence.length;
}

/**
 * The cells of a table row (GFM 4.10), trimmed and left escaped. Leading
 * indentation, a leading pipe and a trailing pipe are optional. A pipe right
 * after a backslash is escaped wherever it appears, even after another
 * backslash or inside a code span (cmark-gfm scans `\|` before any other
 * escape); every other pipe splits a cell. A line with no cells, such as a
 * lone `|`, yields `[]`.
 * @returns {string[]}
 */
export function splitRow(line = '') {
  let text = line.replace(/^[ \t]+|[ \t\r]+$/g, '');
  if (text.startsWith('|')) text = text.slice(1);
  if (text === '') return [];
  const cells = text.split(/(?<!\\)\|/).map((c) => c.trim());
  if (/(?<!\\)\|$/.test(text)) cells.pop(); // A trailing pipe closes the last cell; it adds no column.
  return cells;
}

const DELIMITER_CELL_RE = /^:?-+:?$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;
const THEMATIC_RE = /^([-*_])([ \t]*\1){2,}[ \t]*$/;
const ATX_RE = /^#{1,6}(?:[ \t]|$)/;
const BULLET_RE = /^[-+*](?:[ \t](.*))?$/;
const ORDERED_RE = /^(\d{1,9})[.)](?:[ \t](.*))?$/;

/**
 * Whether `line` is a GFM table delimiter row: 0–3 spaces of indentation and
 * cells of `-` with optional alignment colons (`---`, `:--`, `--:`, `:-:`).
 * A dash-only line without a pipe is a setext underline and `- | -` is a
 * list item, so neither is a delimiter row (GitHub renders them that way).
 */
export function isDelimiterRow(line) {
  const rest = unindented(line);
  if (rest === null || isBlank(rest) || SETEXT_RE.test(rest) || BULLET_RE.test(rest)) return false;
  const cells = splitRow(rest);
  return cells.length > 0 && cells.every((c) => DELIMITER_CELL_RE.test(c));
}

/** List item start on an unindented line: `{ empty, startsAtOne }`, or null. */
function listStart(rest) {
  const bullet = rest.match(BULLET_RE);
  if (bullet) return { empty: !bullet[1]?.trim(), startsAtOne: true };
  const ordered = rest.match(ORDERED_RE);
  if (ordered) return { empty: !ordered[2]?.trim(), startsAtOne: Number(ordered[1]) === 1 };
  return null;
}

const HTML_BLOCK_6 = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const ATTRIBUTE = `[ \\t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:[^ \\t"'=<>\`]+|'[^']*'|"[^"]*"))?`;
const HTML_STARTS = [
  { start: /^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, end: /<\/(?:script|pre|style|textarea)>/i },
  { start: /^<!--/, end: /-->/ },
  { start: /^<\?/, end: /\?>/ },
  { start: /^<![A-Za-z]/, end: />/ },
  { start: /^<!\[CDATA\[/, end: /\]\]>/ },
  { start: new RegExp(`^</?(?:${HTML_BLOCK_6})(?:[ \\t]|/?>|$)`, 'i'), end: null },
  { start: new RegExp(`^(?:<[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*[ \\t]*/?>|</[A-Za-z][A-Za-z0-9-]*[ \\t]*>)[ \\t]*$`), end: null, type7: true },
];

/** The HTML block an unindented line starts (GFM 4.6): `{ end }` (null end: ends before a blank line), or null. */
function htmlStart(rest, { canInterruptParagraph }) {
  const hit = HTML_STARTS.find((h) => h.start.test(rest));
  if (!hit || (hit.type7 && !canInterruptParagraph)) return null;
  return { end: hit.end };
}

/**
 * Scan Markdown into GitHub's block structure, one pass, top level only.
 *
 * Returns:
 * - `lines`: the input lines, a trailing `\r` removed.
 * - `kinds`: one kind per line (index 0 is line 1): `blank`, `paragraph`,
 *   `heading`, `thematic`, `list`, `quote`, `html`, `code` (indented code),
 *   `fence` (a fence's opener, content and closer) or `table` (header,
 *   delimiter and body rows).
 * - `fences`: `{ openLine, closeLine }` per fenced code block (`closeLine` is
 *   null when the fence runs to the end of the document).
 * - `tables`: `{ headerLine, header, delimiterLine, delimiter, rows: [{ line, cells }] }`
 *   for every table GitHub renders. A row may have fewer or more cells than
 *   the header; GitHub pads or drops them silently.
 * - `brokenTables`: `{ headerLine, header, delimiterLine, delimiter }` where a
 *   delimiter row follows a header-like line with a different cell count;
 *   GitHub renders the lines as plain text, not a table.
 * All line numbers are 1-based; cells come from `splitRow`.
 */
export function scanMarkdown(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const kinds = new Array(lines.length);
  const fences = [];
  const tables = [];
  const brokenTables = [];
  // none | paragraph | list | quote | fence | code | html | table
  let state = 'none';
  let fence = null;
  let htmlEnd = null;
  let table = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (state === 'fence') {
      kinds[i] = 'fence';
      if (closesFence(line, fence)) {
        fences.at(-1).closeLine = i + 1;
        state = 'none';
      }
      continue;
    }
    if (state === 'html') {
      if (htmlEnd === null && isBlank(line)) {
        kinds[i] = 'blank';
        state = 'none';
      } else {
        kinds[i] = 'html';
        if (htmlEnd?.test(line)) state = 'none';
      }
      continue;
    }
    if (state === 'code') {
      if (isBlank(line) || indentOf(line).col >= 4) {
        kinds[i] = isBlank(line) ? 'blank' : 'code';
        continue;
      }
      state = 'none';
    }
    if (state === 'table') {
      // GFM 4.10: the body ends at a blank line or another block start; any other line with a cell is a row.
      if (!isBlank(line) && indentOf(line).col < 4 && !startsBlock(line, false)) {
        const cells = splitRow(line);
        if (cells.length > 0) {
          table.rows.push({ line: i + 1, cells });
          kinds[i] = 'table';
          continue;
        }
      }
      table = null;
      state = 'none';
    }

    if (isBlank(line)) {
      kinds[i] = 'blank';
      state = 'none';
      continue;
    }
    const inParagraph = state === 'paragraph' || state === 'list' || state === 'quote';
    const rest = unindented(line);
    if (rest === null) {
      // Indented code cannot interrupt a paragraph; there the line is lazy paragraph text.
      if (!inParagraph) {
        kinds[i] = 'code';
        state = 'code';
        continue;
      }
    } else {
      const opener = fenceOpener(line);
      if (opener) {
        kinds[i] = 'fence';
        fence = opener;
        fences.push({ openLine: i + 1, closeLine: null });
        state = 'fence';
        continue;
      }
      if (ATX_RE.test(rest) || (state === 'paragraph' && SETEXT_RE.test(rest))) {
        kinds[i] = 'heading';
        state = 'none';
        continue;
      }
      if (THEMATIC_RE.test(rest)) {
        kinds[i] = 'thematic';
        state = 'none';
        continue;
      }
      if (rest.startsWith('>')) {
        kinds[i] = 'quote';
        state = /^>[ \t]*$/.test(rest) ? 'none' : 'quote';
        continue;
      }
      const item = listStart(rest);
      if (item && (state !== 'paragraph' || (!item.empty && item.startsAtOne))) {
        kinds[i] = 'list';
        state = item.empty ? 'none' : 'list';
        continue;
      }
      const html = htmlStart(rest, { canInterruptParagraph: !inParagraph });
      if (html) {
        kinds[i] = 'html';
        state = html.end?.test(rest) ? 'none' : 'html';
        htmlEnd = html.end;
        continue;
      }
    }

    // Paragraph text. A blockquote's lazy continuation stays in the quote.
    if (state === 'quote') {
      kinds[i] = 'quote';
      continue;
    }
    // GFM 4.10: a paragraph's last line followed by a delimiter row with as many cells is a table header.
    if (isDelimiterRow(lines[i + 1])) {
      const header = splitRow(line);
      const delimiter = splitRow(lines[i + 1]);
      if (header.length > 0 && header.length === delimiter.length) {
        table = { headerLine: i + 1, header, delimiterLine: i + 2, delimiter, rows: [] };
        tables.push(table);
        kinds[i] = 'table';
        kinds[i + 1] = 'table';
        i += 1;
        state = 'table';
        continue;
      }
      if (header.length > 0) brokenTables.push({ headerLine: i + 1, header, delimiterLine: i + 2, delimiter });
    }
    kinds[i] = 'paragraph';
    state = 'paragraph';
  }
  return { lines, kinds, fences, tables, brokenTables };
}

/** Whether an unindented line starts a block that ends a table body (GFM 4.10). */
function startsBlock(line, inParagraph) {
  const rest = unindented(line);
  if (rest === null) return true;
  return Boolean(
    fenceOpener(line) || ATX_RE.test(rest) || THEMATIC_RE.test(rest) || rest.startsWith('>')
      || listStart(rest) || htmlStart(rest, { canInterruptParagraph: !inParagraph }),
  );
}
