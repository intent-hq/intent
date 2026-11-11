#!/usr/bin/env python3
"""scripts/host_load.py: the co-tenant load warning shared by test runners."""

import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("host_load", HERE / "host_load.py")
host_load = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_load)

# The 2026-11-01 incident: 64 test-stress spinners on a 32-core host.
PS = "\n".join(["  99.8 yes"] * 64 + [" 250.0 rustc", "  80.0 rustc", " 120.5 /usr/local/bin/node",
                                      "   0.0 bash", "  12.0 ps", "garbage", "  x  bad"])


class HostLoadTests(unittest.TestCase):
    def test_quiet_host_reports_nothing(self):
        self.assertIsNone(host_load.check(load=40, cpus=32, ps_output=PS))
        with mock.patch.object(host_load, "read_load", return_value=None):
            self.assertIsNone(host_load.check(cpus=32, ps_output=PS), "no loadavg (Windows) is not a warning")

    def test_busy_host_names_the_busiest_commands(self):
        report = host_load.check(load=112.4, cpus=32, ps_output=PS)
        self.assertEqual(report["load1"], 112.4)
        self.assertEqual(report["busiest"], [
            {"command": "yes", "processes": 64, "cpu_percent": 6387},
            {"command": "rustc", "processes": 2, "cpu_percent": 330},
            {"command": "node", "processes": 1, "cpu_percent": 120},
        ])
        text = host_load.warning(report, "test-stress")
        self.assertTrue(text.startswith("[test-stress] WARNING: host load is 112.4 on 32 CPUs (3.5x); "
                                        "busiest commands: yes ×64 (6387% CPU), rustc ×2 (330% CPU), "
                                        "node (120% CPU)."), text)
        self.assertIn("rather than the code under test", text)

    def test_threshold_is_one_and_a_half_times_the_cpus(self):
        self.assertIsNone(host_load.check(load=47.9, cpus=32, ps_output=""))
        self.assertIsNotNone(host_load.check(load=48, cpus=32, ps_output=""))

    def test_missing_ps_still_warns(self):
        report = host_load.check(load=100, cpus=8, ps_output="")
        self.assertIn("busiest commands: unknown (ps unavailable)", host_load.warning(report, "x"))

    def test_cli_prints_to_stderr_and_never_fails(self):
        stderr = io.StringIO()
        with mock.patch.object(host_load, "read_load", return_value=99.0), \
                mock.patch.object(host_load, "host_cpus", return_value=4), \
                mock.patch.object(host_load, "ps_snapshot", return_value=PS), \
                contextlib.redirect_stderr(stderr):
            self.assertEqual(host_load.main(["--label", "probe"]), 0)
        self.assertIn("[probe] WARNING: host load is 99 on 4 CPUs", stderr.getvalue())

    def test_real_host_snapshot_parses(self):
        if sys.platform.startswith(("linux", "darwin")):
            self.assertIsInstance(host_load.busiest_commands(host_load.ps_snapshot()), list)


if __name__ == "__main__":
    unittest.main()
