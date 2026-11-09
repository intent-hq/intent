// Transcript scoring shared by the eval runner and the stored-conversation metrics.
//
// Input: messages in order, each { role, blocks } where blocks are intentd content
// blocks (agent.getSession `contentBlocks`, or agent_message.content as stored).
// Only workspace_api results flagged is_error count as errors.

const UNKNOWN_METHOD = /\bnot a function\b|does not exist; did you mean/i;
const STRING_LITERAL = /(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g;
const HELP_CALL = /(?<![\w$.])ws\s*\.\s*help\s*\(/g;
const NAMESPACE = /(?<![\w$.])ws\s*\.\s*([A-Za-z_$][\w$]*)\s*\./g;

export function isWorkspaceApi(block) {
  const names = [block.name, block.input?._acpTitle].filter((n) => typeof n === 'string');
  return names.some((n) => /(^|[._])workspace_api$/.test(n));
}

const isError = (result) => result.is_error === true || result.is_error === 1;

function resultText(result) {
  const out = result.output;
  if (typeof out === 'string') return out;
  const content = out?.content ?? out?.result?.content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? '').join('\n');
  return JSON.stringify(out ?? '');
}

const codeOf = (use) => (typeof use.input?.code === 'string' ? use.input.code : '');
const masked = (code) => code.replace(STRING_LITERAL, '""');

export function helpCalls(code) {
  return (masked(code).match(HELP_CALL) ?? []).length;
}

export function namespaces(code) {
  return new Set([...masked(code).matchAll(NAMESPACE)].map((m) => m[1]).filter((ns) => ns !== 'help'));
}

/** Split messages into turns: each user or system message starts one. */
export function turns(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'system' || out.length === 0) out.push([]);
    out[out.length - 1].push(m);
  }
  return out;
}

/**
 * Score a transcript. An error is unrecovered when no later successful
 * workspace_api call in the same turn touches one of the failed call's ws.*
 * namespaces (any later success counts when the failed code names none).
 */
export function scoreTranscript(messages) {
  const s = { turns: 0, toolCalls: 0, wsCalls: 0, wsErrors: 0, unknownMethod: 0, unrecovered: 0, helpCalls: 0 };
  for (const turn of turns(messages)) {
    if (turn.some((m) => m.role === 'user' || m.role === 'system')) s.turns += 1;
    const uses = new Map();
    const calls = [];
    for (const m of turn) {
      for (const b of Array.isArray(m.blocks) ? m.blocks : []) {
        if (b?.type === 'tool_use') {
          s.toolCalls += 1;
          if (!isWorkspaceApi(b)) continue;
          s.wsCalls += 1;
          s.helpCalls += helpCalls(codeOf(b));
          const call = { code: codeOf(b), result: undefined };
          uses.set(b.toolCallId ?? b.id, call);
          calls.push(call);
        } else if (b?.type === 'tool_result') {
          const call = uses.get(b.tool_use_id);
          if (call) call.result = b;
        }
      }
    }
    calls.forEach((call, i) => {
      if (!call.result || !isError(call.result)) return;
      s.wsErrors += 1;
      if (UNKNOWN_METHOD.test(resultText(call.result))) s.unknownMethod += 1;
      const failed = namespaces(call.code);
      const recovered = calls.slice(i + 1).some((later) => {
        if (!later.result || isError(later.result)) return false;
        if (failed.size === 0) return true;
        return [...namespaces(later.code)].some((ns) => failed.has(ns));
      });
      if (!recovered) s.unrecovered += 1;
    });
  }
  return s;
}

export function addScores(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
  return out;
}
