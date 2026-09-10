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
// overwrites an existing Priority based on its output — with one
// exception, the legacy type-label retirement planned by
// planLegacyTypeLabels below.

'use strict';

// Type label -> GitHub issue Type name. The repo enables exactly Task, Bug,
// and Feature (no "Question" Type), so questions map to Task. Type IDs are
// resolved at runtime from `repository.issueTypes`, never hardcoded. Shared
// with pass 2 (agentic-triage.js).
const ISSUE_TYPE_BY_LABEL = { bug: 'Bug', enhancement: 'Feature', question: 'Task' };

// Type labels retired in favour of the issue Type field: pass 1 converts
// them into the Type (when the issue has none) and removes them. `question`
// is NOT legacy — it stays a regular label and is never removed, though it
// still maps onto Task above for pass 2's inference. Order matters: when an
// issue carries several legacy labels, the first one here decides the Type.
const LEGACY_TYPE_LABELS = ['bug', 'enhancement'];

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

// Plan the legacy type-label retirement for an issue. Pure, so the gating
// is unit-testable:
//   - no legacy label present -> no-op,
//   - an existing Type is never overwritten (setType stays null),
//   - with no Type, the first legacy label (LEGACY_TYPE_LABELS order) maps
//     through ISSUE_TYPE_BY_LABEL and must resolve to an enabled Type in
//     `issueTypes` (the runtime `repository.issueTypes` list),
//   - labels are removed only when a Type will be present after the step
//     (already set, or set by this plan); when none can be set (empty list,
//     Types disabled, name missing) nothing is removed.
// Returns { setType: { id, name } | null, removeLabels: string[] }.
function planLegacyTypeLabels({ labels, currentIssueType, issueTypes }) {
  const current = new Set(labels || []);
  const present = LEGACY_TYPE_LABELS.filter((l) => current.has(l));
  if (present.length === 0) return { setType: null, removeLabels: [] };
  if (currentIssueType) return { setType: null, removeLabels: present };
  const name = ISSUE_TYPE_BY_LABEL[present[0]];
  const match = (issueTypes || []).find(
    (t) => t && t.name === name && t.isEnabled !== false && t.id
  );
  if (!match) return { setType: null, removeLabels: [] };
  return { setType: { id: match.id, name }, removeLabels: present };
}

module.exports = {
  ISSUE_TYPE_BY_LABEL,
  LEGACY_TYPE_LABELS,
  labelsForIssueBody,
  planLegacyTypeLabels,
  priorityForIssueBody,
  splitSections,
};
