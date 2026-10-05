// Whole-string specification oracle only: not a bounded scanner, cursor or Store.
import assert from 'node:assert/strict';
import { boundary, validText, utf8 } from './contract.mjs';

export function caseFoldTable(data) {
  const table = new Map();
  for (const line of data.split('\n')) {
    const [code, status, mapping] = line.split('#')[0].split(';').map(s => s.trim());
    if (status === 'C' || status === 'F') {
      table.set(String.fromCodePoint(parseInt(code, 16)),
        mapping.split(/\s+/u).map(x => String.fromCodePoint(parseInt(x, 16))).join(''));
    }
  }
  return table;
}

export function sourceSearch(source, query, table, ranges = [[0, source.length]]) {
  assert.ok(validText(source));
  assert.ok(validText(query) && query.length > 0 && utf8(query) <= 1024);
  const union = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    assert.ok(boundary(source, start) && boundary(source, end) && start <= end);
    if (start === end) continue;
    if (union.length && start <= union.at(-1)[1]) union.at(-1)[1] = Math.max(end, union.at(-1)[1]);
    else union.push([start, end]);
  }
  const needle = [...query].map(c => table.get(c) ?? c).join('');
  const hits = [];
  for (const [start, end] of union) {
    let folded = '', offset = start;
    const boundaries = new Map([[0, start]]);
    for (const scalar of source.slice(start, end)) {
      folded += table.get(scalar) ?? scalar;
      offset += scalar.length;
      boundaries.set(folded.length, offset);
    }
    for (let at = 0; at + needle.length <= folded.length; at++) {
      if (boundaries.has(at) && boundaries.has(at + needle.length) && folded.startsWith(needle, at)) {
        hits.push([boundaries.get(at), boundaries.get(at + needle.length)]);
      }
    }
  }
  return hits;
}

// Controlled page trace validation, with fixture cursors. No real cursor authority
// or streaming matcher is implemented here; expected hits use the oracle above.
export function assertSourceSearchTrace(source, query, table, ranges, pages, maxItems) {
  const expected = sourceSearch(source, query, table, ranges);
  const domainEnd = Math.max(0, ...(ranges ?? [[0, source.length]])
    .filter(([start, end]) => start < end).map(([, end]) => end));
  assert.ok(Number.isSafeInteger(maxItems) && maxItems > 0 && pages.length > 0);
  const emitted = [], cursors = new Set();
  let frontier = 0, observed = 0;
  for (const [index, page] of pages.entries()) {
    assert.ok(boundary(source, page.scannedThrough) && page.scannedThrough >= frontier);
    assert.ok(Array.isArray(page.items) && page.items.length <= maxItems);
    for (const hit of page.items) {
      assert.ok(hit[1] <= page.scannedThrough);
      emitted.push(hit);
    }
    assert.deepEqual(emitted, expected.slice(0, emitted.length));
    assert.ok(Number.isSafeInteger(page.count.value) && page.count.value >= observed
      && page.count.value >= emitted.length
      && page.count.value <= expected.filter(([, end]) => end <= page.scannedThrough).length);
    const terminal = page.nextCursor === null;
    assert.equal(page.count.exact, terminal);
    assert.equal(terminal, index === pages.length - 1);
    if (terminal) {
      assert.ok(page.scannedThrough >= domainEnd);
      assert.deepEqual(emitted, expected);
      assert.equal(page.count.value, expected.length);
    } else {
      assert.ok(typeof page.nextCursor === 'string' && page.nextCursor.length > 0
        && !cursors.has(page.nextCursor));
      cursors.add(page.nextCursor);
    }
    frontier = page.scannedThrough; observed = page.count.value;
  }
}
