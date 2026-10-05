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
