#!/usr/bin/env python3
"""Plan the runner smoke workflow (.github/workflows/intent-cache-smoke.yml).

Reads the committed runner configs (runners.env and hosts/*.env) and prints
the smoke jobs' matrices as GitHub step outputs (key=value lines):

  isolation      matrix of heavy-pool isolation legs
  isolation_xl   matrix of xl-pool isolation legs, or empty for none
  heavy          runs-on labels for the fresh-container and cache-reader jobs
  readers        cache-reader slot names (every heavy slot busy at once)
  host           the targeted host, or empty

Without --host, every leg targets a pool label and accepts any committed
host's slot size for that pool (the min..max memory across the hosts). With
--host NAME, every leg targets that host's label (intent-host-NAME, which
supervisor.sh registers on each slot), there is one leg per slot, and the
CPUs and memory must match that host's config exactly.

A host config is runners.env (intent-cache) or hosts/NAME.env whose
RUNNER_NAME_PREFIX is NAME; other files there are layout templates.
"""
from pathlib import Path
import argparse
import json
import sys

HERE = Path(__file__).resolve().parent
# Built-in supervisor.sh default for configs without RUNNER_NAME_PREFIX.
DEFAULT_PREFIX = 'intent-cache'
POOL_LABEL = {'heavy': 'intent-cache', 'xl': 'intent-cache-xl'}
DEFAULT_READERS = 3
UNITS = {'k': 2 ** 10, 'm': 2 ** 20, 'g': 2 ** 30}


def read_env(path):
    env = {}
    for line in Path(path).read_text().splitlines():
        if line and not line.startswith('#'):
            key, _, value = line.partition('=')
            env[key] = value
    return env


def cpu_count(entry):
    n = 0
    for part in entry.split(','):
        a, _, b = part.partition('-')
        n += int(b or a) - int(a) + 1
    return n


def slots(env, pool):
    """(cpus, memory bytes) of each configured slot of a pool (none if not listed)."""
    if pool not in env['RUNNER_POOLS'].split():
        return []
    p = pool.upper()
    memory = env[f'{p}_MEMORY']
    size = int(memory[:-1]) * UNITS[memory[-1]]
    entries = env[f'{p}_CPUSETS'].split()[:int(env[f'{p}_SLOTS'])]
    return [(cpu_count(entry), size) for entry in entries]


def configs(root=HERE):
    """(path, env) of every committed config: intent-cache first, then hosts/."""
    paths = [root / 'runners.env', *sorted((root / 'hosts').glob('*.env'))]
    return [(path, read_env(path)) for path in paths]


def hosts(root=HERE):
    """Host name -> config, for configs that describe a real host."""
    out = {}
    for path, env in configs(root):
        prefix = env.get('RUNNER_NAME_PREFIX', DEFAULT_PREFIX)
        if path.name == 'runners.env' or path.stem == prefix:
            out[prefix] = env
    return out


def leg(name, pool, cpus, low, high, runs_on):
    return {'name': name, 'label': POOL_LABEL[pool], 'cpus': cpus,
            'memory_min': low, 'memory_max': high, 'runs_on': runs_on}


def fleet_leg(pool, root):
    sizes = [s for env in hosts(root).values() for s in slots(env, pool)]
    if not sizes:
        raise SystemExit(f'::error::no committed host has a {pool} slot')
    cpus = {c for c, _ in sizes}
    if len(cpus) != 1:
        raise SystemExit(f'::error::{pool} slots differ in CPU count across configs: {sorted(cpus)}')
    return leg(POOL_LABEL[pool], pool, cpus.pop(), min(m for _, m in sizes), max(m for _, m in sizes),
               ['self-hosted', POOL_LABEL[pool]])


def host_legs(host, env, pool):
    runs_on = ['self-hosted', POOL_LABEL[pool], f'intent-host-{host}']
    pool_slots = slots(env, pool)
    return [leg(f'{POOL_LABEL[pool]} on {host}, {n}/{len(pool_slots)}', pool, cpus, size, size, runs_on)
            for n, (cpus, size) in enumerate(pool_slots, 1)]


def plan(host='', xl=False, root=HERE):
    if not host:
        return {
            'isolation': {'include': [fleet_leg('heavy', root)]},
            'isolation_xl': {'include': [fleet_leg('xl', root)]} if xl else None,
            'heavy': ['self-hosted', POOL_LABEL['heavy']],
            'readers': [str(n) for n in range(1, DEFAULT_READERS + 1)],
            'host': '',
        }
    known = hosts(root)
    if host not in known:
        raise SystemExit(f"::error::unknown runner host '{host}'; expected one of: {', '.join(sorted(known))}")
    env = known[host]
    unknown = set(env['RUNNER_POOLS'].split()) - set(POOL_LABEL)
    if unknown:
        raise SystemExit(f'::error::{host}: the smoke workflow does not know pools {sorted(unknown)}')
    if not slots(env, 'heavy'):
        raise SystemExit(f'::error::{host} has no heavy slot; the smoke workflow needs one')
    if xl and not slots(env, 'xl'):
        raise SystemExit(f'::error::{host} has no xl slot; dispatch without xl=true')
    return {
        'isolation': {'include': host_legs(host, env, 'heavy')},
        # A host's own xl slots are online by definition, so check them unasked.
        'isolation_xl': {'include': host_legs(host, env, 'xl')} if slots(env, 'xl') else None,
        'heavy': ['self-hosted', POOL_LABEL['heavy'], f'intent-host-{host}'],
        # One reader per heavy slot of the host: all of them busy at once.
        'readers': [str(n) for n in range(1, len(slots(env, 'heavy')) + 1)],
        'host': host,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--host', default='', help='host name (RUNNER_NAME_PREFIX); empty for the whole fleet')
    parser.add_argument('--xl', default='false', choices=('true', 'false'), help='without --host: also check the xl pool')
    args = parser.parse_args(argv)
    result = plan(args.host.strip(), args.xl == 'true')
    for key, value in result.items():
        if key == 'host':
            print(f'{key}={value}')
        else:
            print(f"{key}={'' if value is None else json.dumps(value, separators=(',', ':'))}")


if __name__ == '__main__':
    sys.exit(main())
