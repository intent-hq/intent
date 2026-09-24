import importlib.util
from pathlib import Path
import tempfile
import tomllib
import unittest


SCRIPT = Path(__file__).with_name("seed_dev_providers.py")
SPEC = importlib.util.spec_from_file_location("seed_dev_providers", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class SeedDevProvidersTests(unittest.TestCase):
    def test_seeds_preferences_and_only_absolute_paths(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source = root_path / "prod.toml"
            dev = root_path / "dev"
            absolute = str(root_path / "bin/codex")
            source.write_text(
                "[providers]\n"
                'active = "auggie"\n'
                'enabled = { auggie = true, codex = false }\n'
                f'paths = {{ codex = "{absolute}", auggie = "relative/bin" }}\n',
                encoding="utf-8",
            )

            result = MODULE.seed(dev, source)

            self.assertIn("seeded provider preferences", result)
            providers = tomllib.loads((dev / "config.toml").read_text())["providers"]
            self.assertEqual(providers["active"], "auggie")
            self.assertEqual(providers["enabled"], {"auggie": True, "codex": False})
            self.assertEqual(providers["paths"], {"codex": absolute})

    def test_second_run_never_overwrites_dev_edits(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source = root_path / "prod.toml"
            dev = root_path / "dev"
            source.write_text('[providers]\nactive = "auggie"\nenabled = { codex = true }\n')
            MODULE.seed(dev, source)
            edited = '[providers]\nactive = "codex"\nenabled = { codex = false }\n'
            (dev / "config.toml").write_text(edited)
            source.write_text('[providers]\nactive = "grok"\nenabled = { grok = true }\n')

            result = MODULE.seed(dev, source)

            self.assertIn("existing dev seat", result)
            self.assertEqual((dev / "config.toml").read_text(), edited)

    def test_missing_source_is_a_clean_noop(self):
        with tempfile.TemporaryDirectory() as root:
            dev = Path(root) / "dev"

            result = MODULE.seed(dev, Path(root) / "missing.toml")

            self.assertIn("not found", result)
            self.assertFalse(dev.exists())

    def test_existing_default_config_is_not_modified(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source = root_path / "prod.toml"
            dev = root_path / "dev"
            dev.mkdir()
            existing = "[providers]\npaths = {}\n"
            (dev / "config.toml").write_text(existing)
            source.write_text('[providers]\nactive = "auggie"\n')

            MODULE.seed(dev, source)

            self.assertEqual((dev / "config.toml").read_text(), existing)


if __name__ == "__main__":
    unittest.main()