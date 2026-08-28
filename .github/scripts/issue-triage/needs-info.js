// Needs-info completeness loop for the triage workflow (pass 1).
//
// Detects incomplete bug reports (empty/placeholder "Reproduction steps" or
// "Expected vs actual" sections) and near-empty blank-issue bodies, and
// carries the pure decision logic for the one-nudge loop:
//   - shouldNudge:          post the templated nudge + `needs-info` at most
//                           once per issue (hidden HTML marker comment is the
//                           idempotency guard, same precedent as
//                           packages/intentd/scripts/notify-fixed-issues.sh)
//   - shouldClearNeedsInfo: only the issue author's reply clears the label
//
// Pure and dependency-free so it can be unit-tested with `node --test`
// and required from actions/github-script.

'use strict';

const { splitSections } = require('./parse-issue.js');

const NEEDS_INFO_LABEL = 'needs-info';

// Hidden marker embedded in the nudge comment; its presence anywhere in the
// issue's comments means the nudge was already posted (re-runs never
// double-post, even after the label was removed).
const NEEDS_INFO_MARKER = '<!-- issue-triage: needs-info -->';

// Bug-template sections that must carry real content.
const REQUIRED_BUG_SECTIONS = ['Reproduction steps', 'Expected vs actual'];

// Words that alone convey no information ("tbd", "n/a", ...).
const PLACEHOLDER_WORDS = new Set(['tbd', 'todo', 'none', 'nil', 'na', 'idk', 'unknown']);

// Minimum meaningful characters for a free-form (non-template) body.
const NEAR_EMPTY_MIN_CHARS = 30;

// True when a section's content is empty, "_No response_", or contains no
// meaningful words (only punctuation, list numbering, or placeholder words —
// e.g. the template's untouched "1. ...\n2. ..." placeholder).
function isPlaceholderSection(lines) {
  const text = (lines || []).join('\n').trim();
  if (!text || /^_no response_$/i.test(text)) return true;
  const tokens = (text.match(/[A-Za-z]{2,}/g) || [])
    .map((t) => t.toLowerCase())
    .filter((t) => !PLACEHOLDER_WORDS.has(t));
  return tokens.length === 0;
}

// Meaningful character count of a free-form body: markdown images/links and
// bare URLs are stripped first so a body that is only a screenshot or a link
// still counts as near-empty.
function meaningfulLength(body) {
  const stripped = String(body || '')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const tokens = stripped.match(/[A-Za-z0-9]{2,}/g) || [];
  return tokens.join('').length;
}

// Assess an issue body's completeness. Returns { incomplete, reasons }.
//   - Bodies with the bug template's repro/expected sections must have real
//     content in both.
//   - Bodies with no template sections at all (blank issues) must clear a
//     minimal meaningful-content bar.
//   - Everything else (e.g. feature requests) is never flagged.
function assessCompleteness(body) {
  const reasons = [];
  const sections = splitSections(body || '');
  const isBugTemplate = REQUIRED_BUG_SECTIONS.some((name) => sections[name]);
  if (isBugTemplate) {
    for (const name of REQUIRED_BUG_SECTIONS) {
      if (!sections[name] || isPlaceholderSection(sections[name])) {
        reasons.push(`the "${name}" section is empty or placeholder-only`);
      }
    }
  } else if (Object.keys(sections).length === 0) {
    if (meaningfulLength(body) < NEAR_EMPTY_MIN_CHARS) {
      reasons.push(
        'the issue body has almost no content — please describe what happened, ' +
          'how to reproduce it, and what you expected'
      );
    }
  }
  return { incomplete: reasons.length > 0, reasons };
}

// The one templated nudge comment, marker included.
function buildNudgeComment(reasons) {
  const bullets = reasons.map((r) => `- ${r}`).join('\n');
  return [
    'Thanks for the report! To triage it we need a bit more detail — right now:',
    '',
    bullets,
    '',
    'Could you reply to this issue with the missing details? The `needs-info`',
    'label is removed automatically on your next comment and triage re-runs.',
    '',
    NEEDS_INFO_MARKER,
  ].join('\n');
}

// Nudge at most once: never when the body is complete, the label is already
// present, or any existing comment carries the marker (i.e. we nudged before,
// even if the label was since removed).
function shouldNudge({ assessment, labels, commentBodies }) {
  if (!assessment || !assessment.incomplete) return false;
  if ((labels || []).includes(NEEDS_INFO_LABEL)) return false;
  const bodies = commentBodies || [];
  if (bodies.some((b) => typeof b === 'string' && b.includes(NEEDS_INFO_MARKER))) return false;
  return true;
}

// Clear `needs-info` only when the ISSUE AUTHOR comments on a labeled issue.
// Comments from anyone else — including our own marker-carrying nudge — do
// not clear it.
function shouldClearNeedsInfo({ labels, issueAuthor, commentAuthor, commentBody }) {
  if (!(labels || []).includes(NEEDS_INFO_LABEL)) return false;
  if (!issueAuthor || !commentAuthor || commentAuthor !== issueAuthor) return false;
  if (typeof commentBody === 'string' && commentBody.includes(NEEDS_INFO_MARKER)) return false;
  return true;
}

module.exports = {
  NEEDS_INFO_LABEL,
  NEEDS_INFO_MARKER,
  assessCompleteness,
  buildNudgeComment,
  shouldNudge,
  shouldClearNeedsInfo,
};
