import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("live_rig.py")
SPEC = importlib.util.spec_from_file_location("live_rig", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)

SECRET = "sk-very-secret-value-123"


def host_entry(**extra):
    entry = {
        "id": "northflank-ed2985610b1c",
        "provider": "northflank",
        "name": "Northflank",
        "state": "ready",
        "template": "ghcr.io/intent-hq/intent-node:0.11.276",
        "agentProviders": ["claude-code"],
        "sizes": [{"id": "4x8"}],
        "size": "4x8",
        "idlePauseMinutes": 10,
        "pausedDeleteDays": 7,
        "configuredAt": "2026-11-13T06:39:20Z",
        "checkedAt": "2026-11-23T02:50:47Z",
        "northflank": {
            "projectId": "default",
            "region": "us-central",
            "image": "ghcr.io/intent-hq/intent-node",
            "plans": {"4x8": "nf-compute-400"},
            "diskGiB": 20,
        },
    }
    entry.update(extra)
    return entry


class SelectTests(unittest.TestCase):
    ITEMS = [
        {"id": "e2b", "name": "Personal E2B"},
        {"id": "vercel-f20bc4870b3f", "name": "Vercel"},
    ]

    def test_selects_by_id_and_by_name_without_case(self):
        picked = MODULE.select(self.ITEMS, "e2b, vercel", "cloud entry")
        self.assertEqual([i["id"] for i in picked], ["e2b", "vercel-f20bc4870b3f"])

    def test_empty_selection_picks_nothing(self):
        self.assertEqual(MODULE.select(self.ITEMS, "", "cloud entry"), [])

    def test_unknown_name_lists_the_choices(self):
        with self.assertRaises(MODULE.RigError) as caught:
            MODULE.select(self.ITEMS, "agent37", "cloud entry")
        self.assertIn("agent37", str(caught.exception))
        self.assertIn("Personal E2B (e2b)", str(caught.exception))

    def test_a_name_two_items_share_is_refused(self):
        items = [{"id": "a", "name": "Same"}, {"id": "b", "name": "same"}]
        with self.assertRaises(MODULE.RigError):
            MODULE.select(items, "same", "profile")

    def test_repeated_choice_is_picked_once(self):
        picked = MODULE.select(self.ITEMS, "e2b,Personal E2B", "cloud entry")
        self.assertEqual(len(picked), 1)


class EnvTests(unittest.TestCase):
    def test_stored_entries_become_writes(self):
        doc = json.dumps(
            {
                "fingerprint": "f",
                "entries": [
                    {"kind": "set", "key": "TOKEN", "value": SECRET},
                    {"kind": "unset", "key": "OTHER"},
                ],
            }
        )
        writes = MODULE.env_writes(doc)
        self.assertEqual(
            writes,
            [
                {"key": "TOKEN", "kind": "set", "value": SECRET},
                {"key": "OTHER", "kind": "unset"},
            ],
        )
        summary = MODULE.env_summary(writes)
        self.assertEqual(summary, "TOKEN=set, OTHER=unset")
        self.assertNotIn(SECRET, summary)

    def test_missing_doc_is_no_env(self):
        self.assertEqual(MODULE.env_writes(None), [])

    def test_unknown_kind_is_refused_without_the_value(self):
        doc = json.dumps({"entries": [{"kind": "weird", "key": "K", "value": SECRET}]})
        with self.assertRaises(MODULE.RigError) as caught:
            MODULE.env_writes(doc)
        self.assertNotIn(SECRET, str(caught.exception))

    def test_unreadable_doc_is_refused_without_the_value(self):
        with self.assertRaises(MODULE.RigError) as caught:
            MODULE.env_writes("{" + SECRET)
        self.assertNotIn(SECRET, str(caught.exception))


class ConfigureTests(unittest.TestCase):
    def test_copies_settings_and_drops_read_only_fields(self):
        params = MODULE.configure_params(host_entry(), SECRET, {})
        self.assertEqual(params["provider"], "northflank")
        self.assertEqual(params["name"], "Northflank")
        self.assertEqual(params["apiKey"], SECRET)
        self.assertEqual(params["size"], "4x8")
        self.assertEqual(params["idlePauseMinutes"], 10)
        self.assertEqual(params["projectId"], "default")
        self.assertEqual(params["plans"], {"4x8": "nf-compute-400"})
        self.assertEqual(params["image"], "ghcr.io/intent-hq/intent-node")
        self.assertEqual(params["diskGiB"], 20)
        for field in ("id", "state", "template", "sizes", "agentProviders", "checkedAt", "configuredAt", "region"):
            self.assertNotIn(field, params)

    def test_overrides_win(self):
        params = MODULE.configure_params(host_entry(), SECRET, {"size": "2x4", "idlePauseMinutes": 5})
        self.assertEqual(params["size"], "2x4")
        self.assertEqual(params["idlePauseMinutes"], 5)

    def test_e2b_keeps_its_template_project(self):
        entry = {"id": "e2b", "provider": "e2b", "name": "E2B", "size": "4x8", "templateProject": "intent"}
        params = MODULE.configure_params(entry, SECRET, {})
        self.assertEqual(params["templateProject"], "intent")

    def test_vercel_and_agent37_settings_are_copied(self):
        vercel = {"id": "vercel-1", "provider": "vercel", "name": "V", "vercel": {"teamId": "t", "projectId": "p", "image": "img"}}
        self.assertEqual(
            {k: MODULE.configure_params(vercel, SECRET, {})[k] for k in ("teamId", "projectId", "image")},
            {"teamId": "t", "projectId": "p", "image": "img"},
        )
        a37 = {"id": "agent37-1", "provider": "agent37", "name": "A", "agent37": {"instanceType": "default", "region": "us", "diskGiB": 20}}
        params = MODULE.configure_params(a37, SECRET, {})
        self.assertEqual((params["instanceType"], params["region"], params["diskGiB"]), ("default", "us", 20))

    def test_redacted_params_hide_the_key(self):
        params = MODULE.configure_params(host_entry(), SECRET, {})
        self.assertNotIn(SECRET, json.dumps(MODULE.redacted(params)))


class FingerprintTests(unittest.TestCase):
    def test_provider_checks_do_not_change_the_hash(self):
        before = MODULE.entries_fingerprint([host_entry()])
        after = MODULE.entries_fingerprint(
            [host_entry(state="unreachable", checkedAt="later", sizes=[], template="x:0.11.277")]
        )
        self.assertEqual(before, after)

    def test_a_saved_change_changes_the_hash(self):
        before = MODULE.entries_fingerprint([host_entry()])
        self.assertNotEqual(before, MODULE.entries_fingerprint([host_entry(name="Renamed")]))
        self.assertNotEqual(before, MODULE.entries_fingerprint([host_entry(), host_entry(id="other")]))

    def test_profiles_hash_follows_saved_env(self):
        profile = {"id": "p1", "name": "me", "baseProviderId": "claude-code", "settingsFingerprint": "a", "env": [{"key": "K", "masked": "***"}]}
        before = MODULE.profiles_fingerprint([profile])
        self.assertEqual(before, MODULE.profiles_fingerprint([dict(profile, updatedAt="later")]))
        self.assertNotEqual(before, MODULE.profiles_fingerprint([dict(profile, settingsFingerprint="b")]))

    def test_compare_names_each_changed_part(self):
        before = {"config": "a", "entries": "b", "profiles": "c"}
        self.assertEqual(MODULE.changed_parts(before, dict(before)), [])
        self.assertEqual(MODULE.changed_parts(before, dict(before, entries="x")), ["entries"])


class RelayTests(unittest.TestCase):
    def test_cert_name_is_the_der_sha256(self):
        der = b"\x30\x82\x01\x00fake-der-bytes"
        import base64

        pem = "-----BEGIN CERTIFICATE-----\n" + base64.encodebytes(der).decode() + "-----END CERTIFICATE-----\n"
        self.assertEqual(MODULE.cert_name(pem), "sha256-raw:" + hashlib.sha256(der).hexdigest())

    def test_derp_map_has_one_node_with_the_cert(self):
        derp = MODULE.derp_map("203.0.113.7", 18443, "sha256-raw:ab")
        node = derp["Regions"]["900"]["Nodes"][0]
        self.assertEqual(node["HostName"], "203.0.113.7")
        self.assertEqual(node["IPv4"], "203.0.113.7")
        self.assertEqual(node["DERPPort"], 18443)
        self.assertEqual(node["CertName"], "sha256-raw:ab")
        self.assertEqual(node["STUNPort"], -1)

    def test_fake_map_marks_the_node_insecure(self):
        node = MODULE.derp_map("127.0.0.1", 9, None)["Regions"]["900"]["Nodes"][0]
        self.assertTrue(node["InsecureForTests"])
        self.assertNotIn("CertName", node)


class LeftoverTests(unittest.TestCase):
    def test_northflank_tag_matches_intentd(self):
        self.assertEqual(MODULE.northflank_backend_tag("live"), "intent-backend-247610f4dedd")

    def test_each_provider_reports_only_this_backend(self):
        backend = "b1"
        self.assertEqual(
            MODULE.leftovers("e2b", [{"sandboxID": "s1", "metadata": {"intentBackendId": "b1"}}, {"sandboxID": "s2", "metadata": {"intentBackendId": "other"}}], backend),
            ["s1"],
        )
        self.assertEqual(
            MODULE.leftovers("vercel", [{"name": "v1", "status": "stopped", "tags": {"intentBackendId": "b1"}}, {"name": "v2", "tags": {}}], backend),
            ["v1"],
        )
        tag = MODULE.northflank_backend_tag(backend)
        self.assertEqual(
            MODULE.leftovers("northflank", [{"id": "n1", "tags": [tag]}, {"id": "n2", "tags": ["intent-backend-000000000000"]}], backend),
            ["n1"],
        )
        self.assertEqual(
            MODULE.leftovers(
                "agent37",
                [
                    {"id": "a1", "status": "running", "metadata": {"intentBackendId": "b1"}},
                    {"id": "a2", "status": "deleted", "metadata": {"intentBackendId": "b1"}},
                    {"id": "a3", "status": "running", "metadata": {"intentBackendId": "x"}},
                ],
                backend,
            ),
            ["a1"],
        )

    def test_an_unknown_provider_is_refused(self):
        with self.assertRaises(MODULE.RigError):
            MODULE.leftovers("mars", [], "b1")


class PagingTests(unittest.TestCase):
    def test_northflank_follows_every_page_of_services_and_volumes(self):
        pages = {
            "services": [
                {"data": {"services": [{"id": "s1"}]}, "pagination": {"hasNextPage": True, "cursor": "c2"}},
                {"data": {"services": [{"id": "s2"}]}, "pagination": {"hasNextPage": False}},
            ],
            "volumes": [{"data": {"volumes": [{"id": "v1"}]}, "pagination": {"hasNextPage": False}}],
        }
        seen = []

        def get(url, headers):
            seen.append(url)
            kind = "services" if "/services" in url else "volumes"
            return pages[kind].pop(0)

        items = MODULE.provider_items("northflank", SECRET, {"projectId": "p"}, "b1", get=get)
        self.assertEqual([i["id"] for i in items], ["s1", "s2", "v1"])
        self.assertIn("cursor=c2", seen[1])
        self.assertTrue(all(SECRET not in url for url in seen))

    def test_vercel_follows_its_next_cursor(self):
        pages = [
            {"sandboxes": [{"name": "a"}], "pagination": {"next": "n2"}},
            {"sandboxes": [{"name": "b"}], "pagination": {"next": None}},
        ]
        seen = []

        def get(url, headers):
            seen.append(url)
            return pages.pop(0)

        items = MODULE.provider_items("vercel", SECRET, {"projectId": "p", "teamId": "t"}, "b1", get=get)
        self.assertEqual([i["name"] for i in items], ["a", "b"])
        self.assertIn("cursor=n2", seen[1])


class CopyTests(unittest.TestCase):
    def test_each_copied_entry_is_recorded_before_the_next_one(self):
        class Host:
            def call(self, method, params=None, timeout=None):
                return {"providers": [
                    {"id": "e2b", "provider": "e2b", "name": "One", "size": "2x4"},
                    {"id": "e2b-2", "provider": "e2b", "name": "Two", "size": "2x4"},
                ]}

        class Rig:
            calls = 0

            def call(self, method, params=None, timeout=None):
                Rig.calls += 1
                if Rig.calls == 2:
                    raise MODULE.RigError("configure failed")
                return {"provider": {"id": "e2b", "state": "ready", "size": "2x4"}}

        recorded = []
        with tempfile.TemporaryDirectory() as root:
            secrets = Path(root) / "secrets.json"
            secrets.write_text(json.dumps({"cloudMachines.e2b.apiKey": SECRET, "cloudMachines.e2b-2.apiKey": SECRET + "2"}))
            os.environ["HOST_INTENTD_SECRETS_FILE"] = str(secrets)
            try:
                with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(MODULE.RigError):
                    MODULE.copy_entries(Host(), Rig(), "One,Two", {}, recorded.append)
            finally:
                del os.environ["HOST_INTENTD_SECRETS_FILE"]
        self.assertEqual([r["hostId"] for r in recorded], ["e2b"])


class DaemonIdTests(unittest.TestCase):
    def test_an_unreadable_database_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root) / "data"
            data.mkdir()
            (data / "intentd.db").write_bytes(b"not a database at all" * 100)
            with self.assertRaises(MODULE.RigError):
                MODULE.daemon_id(Path(root))

    def test_no_database_means_no_backend_id(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(MODULE.daemon_id(Path(root)))


class RedactTests(unittest.TestCase):
    def test_say_scrubs_registered_secrets(self):
        redactor = MODULE.Redactor()
        redactor.add(SECRET)
        redactor.add("")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            redactor.say(f"value {SECRET} and {{'apiKey': '{SECRET}'}}")
        self.assertNotIn(SECRET, out.getvalue())
        self.assertIn("***", out.getvalue())


class StateTests(unittest.TestCase):
    def test_a_second_rig_is_refused_while_one_exists(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state.json"
            MODULE.guard_no_rig(state)
            state.write_text(json.dumps({"rigDir": "/tmp/x", "supervisorPid": os.getpid()}))
            with self.assertRaises(MODULE.RigError) as caught:
                MODULE.guard_no_rig(state)
            self.assertIn("live-rig-down", str(caught.exception))

    def test_rig_env_never_inherits_the_callers_intentd_settings(self):
        env = MODULE.rig_env(
            Path("/rig"),
            {"PATH": "/bin", "INTENTD_SOCKET": "/host.sock", "INTENTD_SECRETS_FILE": "/host/.secrets.json", "INTENTD_CONFIG": "/c"},
        )
        self.assertEqual(env["PATH"], "/bin")
        self.assertEqual(env["INTENTD_DATA_DIR"], "/rig/data")
        self.assertEqual(env["INTENTD_SECRETS_FILE"], "/rig/data/secrets.json")
        self.assertNotIn("INTENTD_SOCKET", env)
        self.assertNotIn("INTENTD_CONFIG", env)

    def test_rig_config_is_loopback_only(self):
        import tomllib

        config = tomllib.loads(MODULE.rig_config(None))
        self.assertFalse(config["server"]["wsApi"]["enabled"])
        self.assertFalse(config["server"]["tunnel"]["enabled"])
        self.assertNotIn("derpUrl", config["server"]["tunnel"])
        relayed = tomllib.loads(MODULE.rig_config("http://203.0.113.7:18080/derpmap.json"))
        self.assertEqual(relayed["server"]["tunnel"]["derpUrl"], "http://203.0.113.7:18080/derpmap.json")


if __name__ == "__main__":
    unittest.main()
