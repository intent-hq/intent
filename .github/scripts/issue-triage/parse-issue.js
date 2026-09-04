// Deterministic issue-form parser for the triage workflow (pass 1).
//
// Reads the rendered markdown body of an issue filed through the
// .github/ISSUE_TEMPLATE forms and derives what the template fields map
// onto:
//   - "Component" checkboxes -> component:intentd / component:fe /
//     component:ios / docs labels
//   - "Agent-filed" checkbox -> agent-filed label
//   - "Severity" dropdown    -> the issue's Priority FIELD value
//     (Urgent / High / Medium / Low), keyed on the leading token of the
//     selected option per the mapping comment in bug_report.yml
//
// Pure and dependency-free so it can be unit-tested with `node --test`
// and required from actions/github-script. It only ever *derives* labels
// to add and a Priority to fill; the workflow never removes labels or
// overwrites an existing Priority based on its output.

'use strict';

// Severity option leading token -> Priority field option name. The legacy
// `P0`–`P3` tokens (pre-rename template) stay accepted so issues filed from
// the old template still parse.
const SEVERITY_PRIORITIES = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  p0: 'Urgent',
  p1: 'High',
  p2: 'Medium',
  p3: 'Low',
};

// Checkbox option text -> label, matched on the option's leading token so
// wording tweaks after the token don't break extraction.
const COMPONENT_PREFIXES = [
  { prefix: 'intentd', label: 'component:intentd' },
  { prefix: 'cloudlands-fe', label: 'component:fe' },
  { prefix: 'ios', label: 'component:ios' },
  { prefix: 'docs', label: 'docs' },
];

// Split a rendered issue-form body into { sectionLabel: contentLines }.
// Issue forms render each field as a `### <label>` heading. Lines inside
// fenced code blocks (``` / ~~~) never derive headings or checkboxes, so
// template markdown pasted into a fence (logs, "here's my template output")
// cannot produce spurious sections. By default fenced lines are dropped from
// section content too (right for label derivation); `includeFenced: true`
// keeps them as plain content (right for completeness assessment, where a
// repro/log code block is real content).
function splitSections(body, opts) {
  const includeFenced = Boolean(opts && opts.includeFenced);
  const sections = Object.create(null);
  let current = null;
  let inFence = false;
  for (const line of String(body).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (includeFenced && current) sections[current].push(line);
      continue;
    }
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  return sections;
}

// Checked checkbox items ("- [x] <text>") within a section.
function checkedItems(lines) {
  const items = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[[xX]\]\s*(.+?)\s*$/);
    if (m) items.push(m[1]);
  }
  return items;
}

// First non-empty line of a section (the dropdown selection, or
// "_No response_" when unanswered).
function firstContentLine(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

// Derive the labels a template-filed issue body maps onto. Returns a
// deduplicated array; an empty/blank/free-form body yields [].
function labelsForIssueBody(body) {
  const labels = [];
  if (!body || typeof body !== 'string') return labels;
  const sections = splitSections(body);

  if (sections['Component']) {
    for (const item of checkedItems(sections['Component'])) {
      const lower = item.toLowerCase();
      for (const { prefix, label } of COMPONENT_PREFIXES) {
        if (lower.startsWith(prefix)) {
          labels.push(label);
          break;
        }
      }
    }
  }

  if (sections['Agent-filed'] && checkedItems(sections['Agent-filed']).length > 0) {
    labels.push('agent-filed');
  }

  return [...new Set(labels)];
}

// Derive the Priority field value the Severity dropdown maps onto:
// 'Urgent' | 'High' | 'Medium' | 'Low', or null when the section is
// missing, unanswered ("_No response_"), or free-form text.
function priorityForIssueBody(body) {
  if (!body || typeof body !== 'string') return null;
  const sections = splitSections(body);
  if (!sections['Severity']) return null;
  const selection = firstContentLine(sections['Severity']);
  const m = selection.match(/^([A-Za-z][A-Za-z0-9]*)\b/);
  if (!m) return null;
  return SEVERITY_PRIORITIES[m[1].toLowerCase()] || null;
}

module.exports = { labelsForIssueBody, priorityForIssueBody, splitSections };
