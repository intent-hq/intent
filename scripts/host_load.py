"""Warn when a shared dev host is far busier than its CPU count.

Many workspaces share one dev host. When another workspace keeps the 1-minute
load well above the core count (a `make test-stress LOAD=1` run, a big build),
time-limited tests here fail with timeouts that say nothing about the code under
test: on 2026-11-01 a load of 95-120 on a 32-core host turned a component-test
stress check that passes 480/480 in 12 minutes into 225 timeouts over 2 hours.

check() measures the load once and, when it is at least LOAD_FACTOR times the
host's CPU count, names the busiest commands (`ps` CPU share summed by command
name) so the run's output says where the load came from. It never fails a run:
a missing loadavg or `ps` just yields no report.

`python3 scripts/host_load.py --label NAME` prints the warning (if any) for use
from other targets; it always exits 0.
"""

from __future__ import annotations

import argparse
import os
from pathlib import PurePath
import subprocess
import sys

LOAD_FACTOR = 1.5
BUSIEST_LIMIT = 3


def read_load() -> float | None:
    try:
        return os.getloadavg()[0]
    except (AttributeError, OSError):
        return None


def host_cpus() -> int:
    """Every CPU of the host: the load average counts runnable tasks host-wide."""
    return os.cpu_count() or 1


def ps_snapshot() -> str:
    try:
        result = subprocess.run(["ps", "-A", "-o", "pcpu=,comm="], capture_output=True, text=True,
                                errors="replace", timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout if result.returncode == 0 else ""


def busiest_commands(ps_output: str, limit: int = BUSIEST_LIMIT) -> list[dict[str, object]]:
    """Group `ps -o pcpu=,comm=` lines by command name, busiest total CPU first."""
    totals: dict[str, list[float]] = {}
    for line in ps_output.splitlines():
        fields = line.split(None, 1)
        if len(fields) != 2:
            continue
        try:
            share = float(fields[0].replace(",", "."))
        except ValueError:
            continue
        # macOS prints the full executable path; Linux the 15-char task name.
        name = PurePath(fields[1].strip()).name or fields[1].strip()
        if name == "ps":
            continue
        entry = totals.setdefault(name, [0, 0.0])
        entry[0] += 1
        entry[1] += share
    ranked = sorted(totals.items(), key=lambda item: (-item[1][1], item[0]))
    return [{"command": name, "processes": int(count), "cpu_percent": round(share)}
            for name, (count, share) in ranked[:limit] if share >= 1]


def check(load: float | None = None, cpus: int | None = None, ps_output: str | None = None,
          factor: float = LOAD_FACTOR) -> dict[str, object] | None:
    """A report when the host's 1-minute load is at least `factor` x its CPUs, else None."""
    load = read_load() if load is None else load
    cpus = host_cpus() if cpus is None else cpus
    if load is None or cpus <= 0 or load < factor * cpus:
        return None
    busiest = busiest_commands(ps_snapshot() if ps_output is None else ps_output)
    return {"load1": round(load, 1), "cpus": cpus, "busiest": busiest}


def describe_busiest(busiest: list[dict[str, object]]) -> str:
    return ", ".join(
        f"{entry['command']}{' ×' + str(entry['processes']) if entry['processes'] != 1 else ''} "
        f"({entry['cpu_percent']}% CPU)" for entry in busiest) or "unknown (ps unavailable)"


def warning(report: dict[str, object], label: str) -> str:
    return (f"[{label}] WARNING: host load is {report['load1']:g} on {report['cpus']} CPUs "
            f"({report['load1'] / report['cpus']:.1f}x); busiest commands: "
            f"{describe_busiest(report['busiest'])}. Other workspaces share this host, so "
            "timeouts in this run may come from that load rather than the code under test; "
            "rerun when the host is quieter before treating them as real failures.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Warn when the host load is far above its CPU count.")
    parser.add_argument("--label", default="host-load")
    args = parser.parse_args(argv)
    report = check()
    if report:
        print(warning(report, args.label), file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
