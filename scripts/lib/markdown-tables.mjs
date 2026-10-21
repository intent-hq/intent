// Shared Markdown block scanner for the docs checks: fenced code, indented
// code, HTML blocks, headings and GitHub (GFM) tables, read the way GitHub
// renders them.
//
// Every docs check that needs to know "is this line a table row?" or "is this
// line inside a code fence?" must ask this module instead of matching lines
// itself; three private parsers that disagreed with GitHub (and with each
// other) are why it exists (intent-hq/intent#7482). The rules follow the GFM
// spec (https://github.github.com/gfm/), sections 4.2–4.6 leaf blocks, 4.10
// tables, 5.1 blockquotes and 5.2 list items, and were checked against
// GitHub's own renderer; scripts/lib/markdown-tables.test.mjs pins them with
// the spec's examples and GitHub-rendered cases.
//
// Containers: list items are tracked by their content column, so a table or
// fence inside a list item is found, a less-indented line ends the item (or
// is a lazy paragraph line, which is never a table header or delimiter), and
// a list item's first line can be a table header. A blockquote's own lines
// are never read as tables or fences; the scanner only tracks whether the
// quote ends in a paragraph, which decides whether the next unquoted line is a
// lazy quote line or a new block. Tables inside blockquotes are not reported.

const TAB_STOP = 4;

/** Column of the first non-blank character (tabs advance to the next multiple of 4) and the rest of the line. */
function indentOf(line, startCol = 0) {
  let col = startCol;
  let offset = 0;
  for (; offset < line.length; offset += 1) {
    if (line[offset] === ' ') col += 1;
    else if (line[offset] === '\t') col += TAB_STOP - (col % TAB_STOP);
    else break;
  }
  return { col, rest: line.slice(offset) };
}

const isBlank = (line) => /^[ \t]*$/.test(line);
const FENCE_RUN_RE = /^(`{3,}|~{3,})(.*)$/;

function openerOf(rest) {
  const m = rest.match(FENCE_RUN_RE);
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
  return { char: m[1][0], length: m[1].length };
}

function closes(rest, fence) {
  const m = rest.match(/^(`{3,}|~{3,})[ \t]*$/);
  return Boolean(m) && m[1][0] === fence.char && m[1].length >= fence.length;
}

/**
 * The fence a line opens (GFM 4.5), or null: 0–3 spaces of indentation, then
 * three or more backticks or tildes. A backtick fence's info string cannot
 * contain a backtick, so a line like "```x``` y" is inline code, not a fence.
 * @returns {{ char: '`' | '~', length: number } | null}
 */
export function fenceOpener(line) {
  const { col, rest } = indentOf(line);
  return col <= 3 ? openerOf(rest) : null;
}

/**
 * Whether `line` closes `fence` (GFM 4.5): 0–3 spaces of indentation, a run of
 * the same character at least as long as the opener, then only spaces or tabs.
 */
export function closesFence(line, fence) {
  const { col, rest } = indentOf(line);
  return col <= 3 && closes(rest, fence);
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
const ATX_RE = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const BULLET_RE = /^[-+*](?:[ \t]|$)/;
const UNESCAPED_PIPE_RE = /(?<!\\)\|/;

/** Whether `line` is a delimiter row for a table whose content starts at column `base`. */
function delimiterAt(line, base) {
  if (line === undefined || isBlank(line)) return false;
  const { col, rest } = indentOf(line);
  if (col < base || col - base > 3 || SETEXT_RE.test(rest) || BULLET_RE.test(rest)) return false;
  const cells = splitRow(rest);
  return cells.length > 0 && cells.every((c) => DELIMITER_CELL_RE.test(c));
}

/**
 * Whether `line` is a GFM table delimiter row: 0–3 spaces of indentation and
 * cells of `-` with optional alignment colons (`---`, `:--`, `--:`, `:-:`).
 * A dash-only line without a pipe is a setext underline and `- | -` is a
 * list item, so neither is a delimiter row (GitHub renders them that way).
 */
export function isDelimiterRow(line) {
  return delimiterAt(line, 0);
}

/** ATX heading text (GFM 4.2: the closing `#` run needs a space before it), or null. */
function atxText(rest) {
  const m = rest.match(ATX_RE);
  if (!m) return null;
  return { level: m[1].length, text: (m[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim() };
}

/**
 * The list item a line starts (GFM 5.2), with the marker at column `col`:
 * `{ empty, startsAtOne, contentCol, content, codeContent }`, or null.
 */
function listItem(rest, col) {
  const m = rest.match(/^(?:[-+*]|(\d{1,9})[.)])(?=[ \t]|$)/);
  if (!m) return null;
  const markerEnd = col + m[0].length;
  const { col: textCol, rest: content } = indentOf(rest.slice(m[0].length), markerEnd);
  const empty = content === '';
  const codeContent = !empty && textCol - markerEnd > 4;
  return {
    empty,
    codeContent,
    startsAtOne: m[1] === undefined || Number(m[1]) === 1,
    contentCol: empty || codeContent ? markerEnd + 1 : textCol,
    content,
  };
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

/** Whether an unindented line starts a block that can interrupt a paragraph (so it is not a lazy line). */
function interruptsParagraph(rest) {
  const item = listItem(rest, 0);
  return Boolean(
    openerOf(rest) || atxText(rest) || THEMATIC_RE.test(rest) || rest.startsWith('>')
      || (item && !item.empty && item.startsAtOne) || htmlStart(rest, { canInterruptParagraph: false }),
  );
}

/** Whether an unindented line starts a block that ends a table body (GFM 4.10). */
function endsTable(rest) {
  return Boolean(
    openerOf(rest) || atxText(rest) || THEMATIC_RE.test(rest) || rest.startsWith('>')
      || listItem(rest, 0) || htmlStart(rest, { canInterruptParagraph: true }),
  );
}

/**
 * Follow a blockquote's content (one `>` line at a time) far enough to know
 * whether the quote currently ends in a paragraph: only then can the next
 * unquoted line be a lazy continuation (GFM 5.1).
 */
function quoteStep(quote, content) {
  if (quote.fence) {
    if (closes(indentOf(content).rest, quote.fence) && indentOf(content).col <= 3) quote.fence = null;
    quote.inner = 'other';
    return;
  }
  const { col, rest } = indentOf(content);
  if (isBlank(content)) quote.inner = 'other';
  else if (col >= 4) quote.inner = quote.inner === 'para' ? 'para' : 'other';
  else if (openerOf(rest)) {
    quote.fence = openerOf(rest);
    quote.inner = 'other';
  } else if (atxText(rest) || THEMATIC_RE.test(rest) || htmlStart(rest, { canInterruptParagraph: quote.inner !== 'para' })
    || (quote.inner === 'para' && SETEXT_RE.test(rest))) quote.inner = 'other';
  else if (quote.inner === 'table') quote.inner = splitRow(rest).length > 0 ? 'table' : 'para';
  else if (quote.inner === 'para' && delimiterAt(content, 0)) quote.inner = 'table';
  else quote.inner = 'para';
}

/**
 * Scan Markdown into GitHub's block structure in one pass.
 *
 * Returns:
 * - `lines`: the input lines, a trailing `\r` removed.
 * - `kinds`: one kind per line (index 0 is line 1): `blank`, `paragraph`,
 *   `heading` (ATX line, or a setext heading's text and underline),
 *   `thematic`, `list` (a list item's first line), `quote` (a blockquote line
 *   or its lazy continuation), `html`, `code` (indented code), `fence` (a
 *   fence's opener, content and closer) or `table` (header, delimiter and
 *   body rows).
 * - `headings`: `{ line, level, text }` per heading (`line` is its first line).
 * - `fences`: `{ openLine, closeLine }` per fenced code block (`closeLine` is
 *   null when the fence runs to the end of the document or its list item).
 * - `tables`: `{ headerLine, header, delimiterLine, delimiter, rows: [{ line, cells }] }`
 *   for every table GitHub renders. A row may have fewer or more cells than
 *   the header; GitHub pads or drops them silently.
 * - `brokenTables`: `{ headerLine, header, delimiterLine, delimiter }` where a
 *   delimiter row follows a header line holding an unescaped pipe but has a
 *   different cell count; GitHub renders the lines as plain text, not a table.
 * All line numbers are 1-based; cells come from `splitRow`.
 */
export function scanMarkdown(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const kinds = new Array(lines.length);
  const headings = [];
  const fences = [];
  const tables = [];
  const brokenTables = [];
  const items = []; // content columns of the open list items, innermost last
  const base = () => items.at(-1) ?? 0;
  // none | paragraph | quote | fence | code | html | table
  let state = 'none';
  let paraStart = -1;
  let fence = null;
  let html = null;
  let codeBase = 0;
  let table = null;
  let quote = null;

  // A paragraph line `content` whose container starts at column `b`: a table header when the next line is a matching delimiter row.
  const tryTable = (i, content, b) => {
    if (!delimiterAt(lines[i + 1], b)) return false;
    const header = splitRow(content);
    const delimiter = splitRow(lines[i + 1]);
    if (header.length > 0 && header.length === delimiter.length) {
      table = { headerLine: i + 1, header, delimiterLine: i + 2, delimiter, rows: [], base: b };
      tables.push(table);
      kinds[i] = 'table';
      kinds[i + 1] = 'table';
      state = 'table';
      return true;
    }
    if (header.length > 0 && UNESCAPED_PIPE_RE.test(content)) brokenTables.push({ headerLine: i + 1, header, delimiterLine: i + 2, delimiter });
    return false;
  };
  const openFence = (i, opener, b) => {
    kinds[i] = 'fence';
    fence = { ...opener, base: b };
    fences.push({ openLine: i + 1, closeLine: null });
    state = 'fence';
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const blank = isBlank(line);
    const { col, rest } = indentOf(line);

    // Leaf blocks that continue across lines. A less-indented non-blank line ends their list item, and them with it.
    if (state === 'fence') {
      if (blank || col >= fence.base) {
        kinds[i] = 'fence';
        if (!blank && col - fence.base <= 3 && closes(rest, fence)) {
          fences.at(-1).closeLine = i + 1;
          state = 'none';
        }
        continue;
      }
      state = 'none';
    }
    if (state === 'html') {
      if (blank && html.end === null) {
        kinds[i] = 'blank';
        state = 'none';
        continue;
      }
      if (blank || col >= html.base) {
        kinds[i] = 'html';
        if (html.end?.test(line)) state = 'none';
        continue;
      }
      state = 'none';
    }
    if (state === 'code') {
      if (blank || col >= codeBase + 4) {
        kinds[i] = blank ? 'blank' : 'code';
        continue;
      }
      state = 'none';
    }
    if (state === 'table') {
      // GFM 4.10: the body ends at a blank line or another block start; any other line with a cell is a row.
      if (!blank && col >= table.base && col - table.base < 4 && !endsTable(rest)) {
        const cells = splitRow(line);
        if (cells.length > 0) {
          table.rows.push({ line: i + 1, cells });
          kinds[i] = 'table';
          continue;
        }
      }
      state = 'none';
    }

    if (blank) {
      kinds[i] = 'blank';
      state = 'none';
      quote = null;
      continue;
    }

    // Containers: a line indented less than the open list item is a lazy paragraph line or ends the item.
    const inParagraph = state === 'paragraph' || state === 'quote';
    if (col < base()) {
      if (inParagraph && !interruptsParagraph(rest)) {
        kinds[i] = state === 'quote' ? 'quote' : 'paragraph';
        continue;
      }
      while (items.length > 0 && col < base()) items.pop();
      if (inParagraph) state = 'none';
    }
    const b = base();

    if (col - b >= 4) {
      if (state === 'quote') {
        kinds[i] = 'quote';
        continue;
      }
      // Indented code cannot interrupt a paragraph; there the line is paragraph text (and may be a header).
      if (state !== 'paragraph') {
        kinds[i] = 'code';
        codeBase = b;
        state = 'code';
        quote = null;
        continue;
      }
    } else if (rest.startsWith('>')) {
      kinds[i] = 'quote';
      quote ??= { inner: 'other', fence: null };
      quoteStep(quote, rest.slice(1).replace(/^ /, ''));
      state = quote.inner === 'para' ? 'quote' : 'none';
      continue;
    } else if (state === 'quote' && !interruptsParagraph(rest)) {
      kinds[i] = 'quote';
      continue;
    } else {
      quote = null;
      const opener = openerOf(rest);
      if (opener) {
        openFence(i, opener, b);
        continue;
      }
      const atx = atxText(rest);
      if (atx) {
        kinds[i] = 'heading';
        headings.push({ line: i + 1, ...atx });
        state = 'none';
        continue;
      }
      if (state === 'paragraph' && SETEXT_RE.test(rest)) {
        for (let j = paraStart; j <= i; j += 1) kinds[j] = 'heading';
        headings.push({ line: paraStart + 1, level: rest[0] === '=' ? 1 : 2, text: lines.slice(paraStart, i).map((l) => l.trim()).join(' ') });
        state = 'none';
        continue;
      }
      if (THEMATIC_RE.test(rest)) {
        kinds[i] = 'thematic';
        state = 'none';
        continue;
      }
      const item = listItem(rest, col);
      if (item && (state !== 'paragraph' || (!item.empty && item.startsAtOne))) {
        items.push(item.contentCol);
        kinds[i] = 'list';
        state = 'none';
        if (item.empty || item.codeContent) continue;
        const itemFence = openerOf(item.content);
        if (itemFence) {
          openFence(i, itemFence, item.contentCol);
          continue;
        }
        const itemAtx = atxText(item.content);
        if (itemAtx) {
          headings.push({ line: i + 1, ...itemAtx });
          continue;
        }
        if (tryTable(i, item.content, item.contentCol)) {
          i += 1;
          continue;
        }
        paraStart = i;
        state = 'paragraph';
        continue;
      }
      const block = htmlStart(rest, { canInterruptParagraph: state !== 'paragraph' });
      if (block) {
        kinds[i] = 'html';
        html = { end: block.end, base: b };
        state = block.end?.test(rest) ? 'none' : 'html';
        continue;
      }
    }

    // Paragraph text. GFM 4.10: a paragraph's last line followed by a delimiter row with as many cells is a table header.
    if (tryTable(i, line, b)) {
      i += 1;
      continue;
    }
    if (state !== 'paragraph') paraStart = i;
    kinds[i] = 'paragraph';
    state = 'paragraph';
  }
  for (const t of tables) delete t.base;
  return { lines, kinds, headings, fences, tables, brokenTables };
}
