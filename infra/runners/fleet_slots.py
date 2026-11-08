#!/usr/bin/env python3
"""Total the runner fleet's slots per pool for the routing variables.

Reads the committed host configs (runners.env and hosts/NAME.env whose
RUNNER_NAME_PREFIX is NAME; other files there are layout templates) and
prints each pool's total slots as key=value lines:

  heavy    every heavy slot           -> CI_LINUX_HEAVY_SLOTS
  bigmem   heavy slots labeled intent-cache-bigmem -> CI_LINUX_BIGMEM_SLOTS
  xl       every xl slot              -> CI_LINUX_XL_SLOTS

--without HOST leaves a host out (retire step 1: lower the variables before
its config is removed). --apply also sets the three variables in every
repository of RUNNER_GROUP_REPOS with gh. See docs/GITHUB_RUNNERS.md.
"""
from pathlib import Path
import argparse
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke_plan import HERE, hosts, read_env, slots  # noqa: E402

VARIABLES = {'heavy': 'CI_LINUX_HEAVY_SLOTS', 'bigmem': 'CI_LINUX_BIGMEM_SLOTS', 'xl': 'CI_LINUX_XL_SLOTS'}


def totals(fleet):
    out = dict.fromkeys(VARIABLES, 0)
    for env in fleet.values():
        heavy = len(slots(env, 'heavy'))
        out['heavy'] += heavy
        if heavy and 'intent-cache-bigmem' in env['HEAVY_LABELS'].split(','):
            out['bigmem'] += heavy
        out['xl'] += len(slots(env, 'xl'))
    return out


def main(argv=None, root=HERE):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--without', action='append', default=[], metavar='HOST',
                        help='leave out a host (RUNNER_NAME_PREFIX); repeatable')
    parser.add_argument('--apply', action='store_true',
                        help='set the CI_LINUX_*_SLOTS variables in every RUNNER_GROUP_REPOS repository with gh')
    args = parser.parse_args(argv)
    fleet = hosts(root)
    for host in args.without:
        if host not in fleet:
            known = ', '.join(sorted(hosts(root)))
            raise SystemExit(f"fleet_slots: error: unknown runner host '{host}'; expected one of: {known}")
        del fleet[host]
    result = totals(fleet)
    for pool, n in result.items():
        print(f'{pool}={n}', flush=True)
    if not args.apply:
        return 0
    env = read_env(root / 'runners.env')
    for repo in env['RUNNER_GROUP_REPOS'].split(','):
        slug = f"{env['GITHUB_ORG']}/{repo}"
        for pool, name in VARIABLES.items():
            cmd = ['gh', 'variable', 'set', name, '--repo', slug, '--body', str(result[pool])]
            if subprocess.run(cmd).returncode != 0:
                raise SystemExit(f"fleet_slots: error: {' '.join(cmd)} failed")
            print(f'{slug} {name}={result[pool]}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
