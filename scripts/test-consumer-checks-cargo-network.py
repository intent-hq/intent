#!/usr/bin/env python3
"""Consumer-checks Cargo contract: a crates.io network blip must not eject a PR.

The connected transfer-selection step builds intentd in the merge queue. On
intentd#3384 its first `cargo test` died with "failed to get serde_with ...
[16] Error in the HTTP2 framing layer" (intentd run 43666226247, job
132666159130), and the approved PR had to be re-queued by hand. intentd's own
ci.yml already avoids this (intentd#3026): HTTP/2 multiplexing off, more cargo
retries, and a retrying `cargo fetch` before the first build. The shared
consumer-checks job gets the same settings and runs intentd's
scripts/fetch-locked-crates.py (no monorepo copy, as with setup-sccache.py).
Requires PyYAML.

Run: python3 -I -B scripts/test-consumer-checks-cargo-network.py
"""
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github/workflows/consumer-checks.yml'
CI = ROOT / '.github/workflows/ci.yml'
INTENTD = ROOT / 'packages/intentd'
FETCH_SCRIPT = 'packages/intentd/scripts/fetch-locked-crates.py'
FETCH_RUN = f'python3 -I -B {FETCH_SCRIPT}'
NETWORK_ENV = {'CARGO_HTTP_MULTIPLEXING': 'false', 'CARGO_NET_RETRY': '10'}
GUARDED = (*NETWORK_ENV, 'CARGO_NET_OFFLINE')
CONNECTED_RUN = 'Run the connected transfer selection contract'


def load(path):
    return yaml.safe_load(path.read_text())


def builds(step):
    return step.get('name') == CONNECTED_RUN or 'cargo ' in (step.get('run') or '')


class ConsumerChecksCargoNetwork(unittest.TestCase):
    def setUp(self):
        self.doc = load(WORKFLOW)
        self.job = self.doc['jobs']['consumer-checks']
        self.steps = self.job['steps']

    def test_job_env_disables_multiplexing_and_raises_retries(self):
        env = self.job.get('env') or {}
        for key, value in NETWORK_ENV.items():
            self.assertEqual(env.get(key), value, f'consumer-checks job env {key} (quoted string)')

    def test_nothing_overrides_the_network_settings(self):
        self.assertFalse(set(GUARDED) & set(self.doc.get('env') or {}), 'workflow env overrides the job settings')
        for step in self.steps:
            for key in GUARDED:
                self.assertNotIn(key, step.get('env') or {}, f'{step.get("name") or step.get("uses")} overrides {key}')
            run = step.get('run') or ''
            for key in GUARDED:
                self.assertNotIn(f'{key}=', run, f'{step.get("name")} reassigns {key}')

    def test_locked_crates_are_fetched_after_the_toolchain_and_before_the_first_build(self):
        fetches = [i for i, s in enumerate(self.steps) if s.get('run') == FETCH_RUN]
        self.assertEqual(len(fetches), 1, 'one retrying crate fetch')
        fetch = fetches[0]
        toolchain = next(i for i, s in enumerate(self.steps) if 'rustup toolchain install' in (s.get('run') or ''))
        first_build = next(i for i, s in enumerate(self.steps) if i != fetch and builds(s))
        self.assertLess(toolchain, fetch, 'the pinned toolchain is installed before fetching')
        self.assertLess(fetch, first_build, f'fetch precedes {self.steps[first_build].get("name")!r}')
        self.assertEqual(self.steps[fetch].get('if'), self.steps[toolchain].get('if'),
                         'fetch runs exactly when the toolchain is installed')
        self.assertEqual(self.steps[fetch].get('if'), self.steps[first_build].get('if'),
                         'fetch runs exactly when the connected build runs')
        self.assertNotIn('continue-on-error', self.steps[fetch], 'a failed fetch fails the job')

    def test_monorepo_keeps_no_copy_of_the_fetch_script(self):
        self.assertFalse((ROOT / 'scripts/fetch-locked-crates.py').exists(),
                         f'a monorepo copy would drift from intentd; run {FETCH_SCRIPT}')

    @unittest.skipUnless((INTENTD / '.github/workflows/ci.yml').is_file(), 'packages/intentd is not initialized')
    def test_settings_match_intentd_ci(self):
        intentd_env = load(INTENTD / '.github/workflows/ci.yml').get('env') or {}
        for key, value in NETWORK_ENV.items():
            self.assertEqual(str(intentd_env.get(key)), value, f'intentd ci.yml {key}')
        self.assertTrue((ROOT / FETCH_SCRIPT).is_file(), f'{FETCH_SCRIPT} is missing from the intentd pin')

    def test_this_suite_runs_on_pull_requests(self):
        job = load(CI)['jobs']['ci-policy']
        self.assertNotIn('if', job, 'ci-policy runs on every event')
        runs = [s.get('run') for s in job['steps']]
        self.assertIn('python3 -I -B scripts/test-consumer-checks-cargo-network.py', runs)


if __name__ == '__main__':
    unittest.main()
