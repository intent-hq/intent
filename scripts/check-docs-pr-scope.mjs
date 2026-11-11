#!/usr/bin/env node
//
// Fail a pull request whose title says `docs:` but whose diff changes code.
//
//   check-docs-pr-scope.mjs <pull-request.json> <changed-files.txt>
//
// <pull-request.json> is the GitHub REST pull request object (title and
// labels are read from it); <changed-files.txt> lists one changed path per
// line (for renames, both the old and the new path). The reusable workflow
// .github/workflows/docs-pr-scope.yml fetches both from the API at run time,
// so a re-run sees the current title and labels rather than the stale event.
//
// Why: intentd#2839, titled "docs: explain sidebar multi-pane selection",
// also rewrote the hook_manager.rs tests that fixed three flaky daemon tests.
// A later search for existing fixes skipped it because of its docs title, and
// a whole workspace re-investigated a problem that was already solved. A docs
// title also files the change under Documentation in the changelog.
//
// Documentation is Markdown-family text anywhere (the app guide included)
// plus image assets inside a docs/ directory. Everything else counts as code.
// When the code change really is documentation (for example doc comments
// only), the docs-with-code-intended label skips the check.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const EXEMPTION_LABEL = 'docs-with-code-intended';
export const MAX_LISTED_FILES = 20;

const DOCS_TITLE = /^docs(\([^)]*\))?!?:/i;
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.rst', '.adoc']);
const DOC_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const TEST_PATH = [
  /(^|\/)(tests?|__tests__|e2e|fixtures)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.test\.(sh|py)$/,
  /(^|\/)test_[^/]+\.py$/,
  /(_test|_tests)\.rs$/,
  /(^|\/)tests?\.rs$/,
];

export function isDocsTitle(title) {
  return DOCS_TITLE.test(String(title ?? '').trim());
}

export function isDocumentationPath(file) {
  const extension = path.posix.extname(file).toLowerCase();
  if (DOC_EXTENSIONS.has(extension)) return true;
  return DOC_ASSET_EXTENSIONS.has(extension) && /(^|\/)docs\//.test(file);
}

export function isTestPath(file) {
  return TEST_PATH.some((pattern) => pattern.test(file));
}

export function suggestTypes(codeFiles) {
  if (codeFiles.length > 0 && codeFiles.every((file) => file.startsWith('.github/'))) return ['ci'];
  if (codeFiles.length > 0 && codeFiles.every(isTestPath)) return ['test'];
  return ['fix', 'test', 'refactor', 'feat', 'chore'];
}

// Returns null when the check passes, otherwise the offending code files and
// the suggested replacement types.
export function evaluate({ title, labels, files }) {
  if (!isDocsTitle(title)) return null;
  if ((labels ?? []).includes(EXEMPTION_LABEL)) return null;
  const codeFiles = [...new Set(files ?? [])].filter((file) => file && !isDocumentationPath(file)).sort();
  if (codeFiles.length === 0) return null;
  return { codeFiles, suggestions: suggestTypes(codeFiles) };
}

export function formatFailure(title, { codeFiles, suggestions }) {
  const count = codeFiles.length === 1 ? '1 file that is not documentation' : `${codeFiles.length} files that are not documentation`;
  const listed = codeFiles.slice(0, MAX_LISTED_FILES).map((file) => `  ${file}`);
  if (codeFiles.length > MAX_LISTED_FILES) listed.push(`  ... and ${codeFiles.length - MAX_LISTED_FILES} more`);
  const retitled = String(title).trim().replace(DOCS_TITLE, `${suggestions[0]}$1:`);
  return [
    `This pull request is titled as documentation but changes ${count}:`,
    ...listed,
    '',
    'A docs: title hides the code change from title searches and files it under',
    'Documentation in the changelog (intentd#2839 hid a flaky-test fix this way).',
    'Do one of:',
    `  - Retitle it with the type of the code change (${suggestions.map((type) => `${type}:`).join(', ')}),`,
    `    for example "${retitled}".`,
    '  - Split the code change into its own pull request.',
    `  - If the code change really is documentation (doc comments only), apply the ${EXEMPTION_LABEL} label.`,
    'Title and label changes do not start a new run: re-run this job afterwards.',
  ].join('\n');
}

function labelNames(pullRequest) {
  const labels = pullRequest.labels ?? [];
  if (!Array.isArray(labels)) throw new TypeError('pull request labels must be an array');
  return labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
}

async function main(args) {
  const [pullRequestPath, filesPath] = args;
  if (!pullRequestPath || !filesPath) {
    console.error('usage: check-docs-pr-scope.mjs <pull-request.json> <changed-files.txt>');
    return 2;
  }
  const pullRequest = JSON.parse(await fs.readFile(pullRequestPath, 'utf8'));
  if (typeof pullRequest.title !== 'string') throw new TypeError(`${pullRequestPath} has no pull request title`);
  const files = (await fs.readFile(filesPath, 'utf8')).split('\n').map((line) => line.trim()).filter(Boolean);
  const failure = evaluate({ title: pullRequest.title, labels: labelNames(pullRequest), files });
  if (failure === null) {
    const reason = !isDocsTitle(pullRequest.title)
      ? 'the title is not a docs: title'
      : labelNames(pullRequest).includes(EXEMPTION_LABEL)
        ? `the ${EXEMPTION_LABEL} label is applied`
        : `all ${files.length} changed file(s) are documentation`;
    console.log(`docs-pr-scope: ok (${reason}).`);
    return 0;
  }
  const message = formatFailure(pullRequest.title, failure);
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::error title=docs: title with code changes::${message.split('\n')[0]} Retitle (for example ${failure.suggestions[0]}:), split the PR, or apply ${EXEMPTION_LABEL}.`);
  }
  console.error(message);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
