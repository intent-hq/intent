// Deterministic issue-form parser for the triage workflow (pass 1).
//
// Reads the rendered markdown body of an issue filed through the
// .github/ISSUE_TEMPLATE forms and derives the labels that the template
// fields map onto:
//   - "Component" checkboxes -> component:intentd / component:fe /
//     component:ios / docs
//   - "Severity" dropdown    -> priority:P0..P3 (keyed on the leading
//     "Pn" token, per the mapping comment in bug_report.yml)
//   - "Agent-filed" checkbox -> agent-filed
//
// Pure and dependency-free so it can be unit-tested with `node --test`
// and required from actions/github-script. It only ever *derives* labels
// to add; the workflow never removes labels based on its output.

'use strict';

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
// fenced code blocks (``` / ~~~) are skipped entirely so template markdown
// pasted into a fence (logs, "here's my template output") cannot derive
// spurious headings or checkboxes.
function splitSections(body) {
  const sections = Object.create(null);
  let current = null;
  let inFence = false;
  for (const line of String(body).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
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

  if (sections['Severity']) {
    const selection = firstContentLine(sections['Severity']);
    const m = selection.match(/^P([0-3])\b/);
    if (m) labels.push(`priority:P${m[1]}`);
  }

  if (sections['Agent-filed'] && checkedItems(sections['Agent-filed']).length > 0) {
    labels.push('agent-filed');
  }

  return [...new Set(labels)];
}

module.exports = { labelsForIssueBody };
