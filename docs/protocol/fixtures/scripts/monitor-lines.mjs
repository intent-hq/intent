// Bounded synthetic stream framer, NOT the production PTY decoder/regex engine.
export const MAX_LINE_BYTES = 4096;
export const MAX_PATTERN_BYTES = 1024;
export const MAX_COUNT = 1000000;
const utf8 = new TextEncoder();

// Trusted fixture patterns use the common JS/Rust subset. Component tests MUST
// validate the complete Rust syntax and finite-automata compile/cache limits.
// Never use this backtracking helper for untrusted runtime input.
export function fixtureRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern || utf8.encode(pattern).length > MAX_PATTERN_BYTES || /[\r\n]/.test(pattern) || /\(\?[=!<]|\\[1-9]|\\k</.test(pattern)) throw new Error('invalid pattern');
  const insensitive = pattern.startsWith('(?i)');
  return new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? 'iu' : 'u');
}

export class MonitorLines {
  constructor() {
    this.decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    this.position = 0;
    this.lineStart = 0;
    this.text = '';
    this.bytes = 0;
    this.overlong = false;
    this.control = '';
    this.controlEsc = false;
    this.afterCR = false;
    this.skipLine = false;
  }
  emit(onLine) {
    if (!this.skipLine) onLine({ text: this.text, overlong: this.overlong, start: this.lineStart });
    this.text = ''; this.bytes = 0; this.overlong = false; this.skipLine = false;
    this.lineStart = this.position;
  }
  char(c, onLine) {
    if (this.control === 'csi') {
      if (c >= '@' && c <= '~') this.control = '';
      return;
    }
    if (this.control === 'osc' || this.control === 'string') {
      if (this.controlEsc && c === '\\' || this.control === 'osc' && c === '\x07') { this.control = ''; this.controlEsc = false; }
      else this.controlEsc = c === '\x1b';
      return;
    }
    if (this.control === 'escape' || this.control === 'intermediate') {
      if (this.control === 'intermediate') { if (c >= '0' && c <= '~') this.control = ''; }
      else this.control = c === '[' ? 'csi' : c === ']' ? 'osc' : ['P', 'X', '^', '_'].includes(c) ? 'string' : c >= ' ' && c <= '/' ? 'intermediate' : '';
      return;
    }
    if (c === '\x1b') { this.control = 'escape'; return; }
    if (c === '\n' && this.afterCR) { this.afterCR = false; this.lineStart = this.position; return; }
    if (c === '\r' || c === '\n') { this.emit(onLine); this.afterCR = c === '\r'; return; }
    if (c !== '\t' && (c.codePointAt(0) < 32 || c.codePointAt(0) >= 127 && c.codePointAt(0) <= 159)) return;
    this.afterCR = false;
    if (this.skipLine || this.overlong) return;
    this.bytes += utf8.encode(c).length;
    if (this.bytes > MAX_LINE_BYTES) { this.text = ''; this.overlong = true; return; }
    this.text += c;
  }
  push(input, onLine) {
    const bytes = typeof input === 'string' ? utf8.encode(input) : Uint8Array.from(input);
    for (const byte of bytes) {
      this.position++;
      for (const c of this.decoder.decode(Uint8Array.of(byte), { stream: true })) this.char(c, onLine);
    }
  }
  eof(onLine) {
    for (const c of this.decoder.decode()) this.char(c, onLine);
    if (this.text || this.overlong) this.emit(onLine);
    this.control = ''; this.controlEsc = false;
  }
  gap() {
    this.decoder = new TextDecoder("utf-8", { ignoreBOM: true }); this.control = ''; this.controlEsc = false;
    this.text = ''; this.bytes = 0; this.overlong = false; this.afterCR = false;
    this.skipLine = true;
  }
}
