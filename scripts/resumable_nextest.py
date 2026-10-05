#!/usr/bin/env python3
"""Run nextest with an opt-in, complete-tree-keyed passed-test record.

`--no-fail-fast 1` forwards `--no-fail-fast` to every `cargo nextest run` and
keeps running the remaining `--plan` selections after one fails; the exit
status is then the first non-zero plan status.

Build outputs use stable per-checkout children under Cargo's configured target
and build directories. This isolates make test/test-changed from other checkout
builds; coverage and custom bare-Cargo scripts still manage their own output ownership.

Resume identity includes the exact child RUST_MIN_STACK setting, also saved in
test-stack.json: null means unset, distinct from an empty string or explicit value.

Receipt schema 1 (independent of the tree-key schema): full runs live under
TREE/attempts/UUID; planned runs under TREE/changed/PLAN/attempts/UUID. The shared
TREE/passed.jsonl and scope-level complete markers remain mutable coordination
state. New complete markers contain the successful execution's UUID; legacy
receipts are never upgraded into synthetic historical attempts.

run.json is created before journal reads/listing and updated only by its owner.
Its null finished_at/exit_code means the runner never observed its own finish.
results are written before launching each child, with relative config, events
and JUnit paths, command, selection_index (1-based), and nullable native_exit_code
and finished_at. Native status is the Popen wait result (negative for signals);
result exit_code remains null when streaming raises, even if cleanup reaps the
child. events-N.jsonl retains stdout lines, flushed before journal updates.
listing-N.json retains nextest's inventory, including ignored/filter metadata;
selection_membership holds listed binary/test pairs, or null before discovery.
resume_candidates is the initial shared credit; resumed_tests is the credit
used after listing, or null when not resolved. Completed-resume receipts contain
no child results and point to resume_source_attempt when the marker has one.
coverage.json (coverage_schema=1) is the completion authority: active is partitioned
into executed-passed, resumed-passed, ignored, failed and unfinished, with inactive
filtered identities separate. selections retain native outcomes and retry events;
legitimate selection overlap is counted once globally but every selection must
finish. Shared journal entries add attempt (tree-relative path), selection_index,
and event_line. Only matching raw passes from compatible receipts grant resume
credit; unreferenced legacy credit is rerun, never upgraded or rewritten. Available
JUnit must agree; absent JUnit is explicitly reported and does not erase reliable
streamed passes. Old run.json counters remain native per-child diagnostic totals,
not unique coverage totals. A completed shortcut revalidates its execution source
and records that source on the report, including each selection's evidence owner.
No later invocation repairs unfinished receipts; only tree expiry removes them.
"""

from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import xml.etree.ElementTree as ET
# Cargo accepts TOML 1.1, which older stdlib tomllib versions cannot parse.
# Use the pinned parser offline, including direct-script/importlib invocation.
if __package__:
    from ._vendor import tomli as cargo_toml
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _vendor import tomli as cargo_toml

# Schema 2 isolated executables across checkouts (#6496); schema 3 also separates
# effective test policy. Schema 4 binds passes to the child's stack setting;
# earlier records cannot establish that the requested stack was tested.
SCHEMA_VERSION = 4
MAX_AGE_SECONDS = 7 * 24 * 60 * 60
KEY_RE = re.compile(r"^[0-9a-f]{64}$")
RUST_FLAG_ENV = {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS"}
RETRY_SUFFIX_RE = re.compile(r"#[0-9]+$")
DEFAULT_LABEL = "test-intentd"
TEST_OUTCOMES = ("ok", "failed", "ignored")
# Outcomes appended to passed.jsonl; a failure supersedes an earlier pass.
RECORDED_OUTCOMES = ("ok", "failed")


def run(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, check=True
    )
    return result.stdout.strip()


def worktree_tree(repo: Path) -> str:
    with tempfile.TemporaryDirectory(prefix="intent-gate-index-") as temp_dir:
        index = Path(temp_dir) / "index"
        env = os.environ.copy()
        env["GIT_INDEX_FILE"] = str(index)
        run(["git", "read-tree", "HEAD"], repo, env)
        run(["git", "add", "-A"], repo, env)
        return run(["git", "write-tree"], repo, env)


def required_hash(path: Path) -> str:
    if not path.is_file():
        raise RuntimeError(f"required tree-key input is missing: {path}")
    return run(["git", "hash-object", str(path)], path.parent)


def submodule_heads(repo_root: Path) -> list[dict[str, str]]:
    output = run(
        ["git", "config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"],
        repo_root,
    )
    heads = []
    for line in output.splitlines():
        path = line.split(maxsplit=1)[1]
        checkout = repo_root / path
        if (checkout / ".git").exists():
            head = run(["git", "rev-parse", "HEAD"], checkout)
        else:
            head = run(["git", "rev-parse", f"HEAD:{path}"], repo_root)
        heads.append({"path": path, "head": head})
    return sorted(heads, key=lambda item: item["path"])


def rust_flags() -> dict[str, str]:
    return {
        name: value
        for name, value in os.environ.items()
        if name in RUST_FLAG_ENV
        or (name.startswith("CARGO_TARGET_") and name.endswith("_RUSTFLAGS"))
    }


def cargo_configs(cwd: Path) -> dict[Path, bytes]:
    """Cargo's config search paths (legacy config wins over config.toml).

    Include external configs in resume identity as well: changing a home/parent
    rustflags setting must not reuse a completed run from the old configuration.
    """
    configs: dict[Path, bytes] = {}

    def read(path: Path, ancestors: frozenset[Path] = frozenset()) -> None:
        # Includes are relative to the logical config path Cargo opened, not
        # a symlink's destination. Canonical paths are only for cycle checks.
        path = path.absolute()
        canonical = path.resolve()
        if canonical in ancestors:
            raise RuntimeError(f"cyclic Cargo config include: {path}")
        if path in configs or not path.is_file():
            return
        configs[path] = path.read_bytes()
        # Cargo accepts a leading UTF-8 BOM; keep raw bytes above for hashing.
        data = cargo_toml.loads(configs[path].decode("utf-8-sig"))
        for include in data.get("include", []):
            name = include if isinstance(include, str) else include["path"]
            read(path.parent / name, ancestors | {canonical})

    directories = [cwd / ".cargo", *(parent / ".cargo" for parent in cwd.parents)]
    cargo_home = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
    # Cargo interprets relative CARGO_HOME from its invocation directory, which
    # differs from the runner's monorepo cwd for nextest list/run commands.
    directories.append(cwd / cargo_home)
    for directory in directories:
        legacy = directory / "config"
        read(legacy if legacy.is_file() else directory / "config.toml")
    return configs


def compact_config(cwd: Path) -> list[str]:
    """Override profiles, never Rust flags, so Cargo keeps its flag precedence.

    A caller explicitly setting -C debuginfo/incremental in Rust flags can
    defeat these profile settings. Preserve that choice instead of replacing
    RUSTFLAGS and accidentally hiding target/build flags from Cargo config.
    """
    if os.environ.get("COMPACT") != "1":
        return []
    documents = [(cwd / "Cargo.toml").read_bytes(), *cargo_configs(cwd).values()]
    packages = {"*"}
    for document in documents:
        profiles = cargo_toml.loads(document.decode("utf-8-sig")).get("profile", {})
        # test inherits dev; set both sides of every package override.
        for profile in ("dev", "test"):
            packages.update(profiles.get(profile, {}).get("package", {}))
    args = []
    for profile in ("dev", "test"):
        prefixes = [f"profile.{profile}", f"profile.{profile}.build-override"]
        prefixes.extend(f"profile.{profile}.package.{json.dumps(name)}" for name in sorted(packages))
        for prefix in prefixes:
            # debug=0 otherwise enables Cargo's implicit strip pass. Keep the
            # manifest's no-strip workaround for macOS proc-macro dylibs.
            args.extend(["--config", f"{prefix}.debug=0", "--config", f'{prefix}.strip="none"'])
    return args


def compact_env() -> dict[str, str]:
    env = os.environ.copy()
    if env.get("COMPACT") == "1":
        env["CARGO_INCREMENTAL"] = "0"
    return env


def announce_compact() -> None:
    if os.environ.get("COMPACT") == "1":
        print("[compact] COMPACT=1: CARGO_INCREMENTAL=0; dev/test debug=0 "
              "(including package/build overrides), strip=none. "
              "Caller Rust flags are unchanged; explicit debug/incremental flags take precedence.",
              flush=True)


def build_settings(cwd: Path) -> dict[str, object]:
    env = compact_env()
    return {
        "compact-config": compact_config(cwd),
        "environment": {name: value for name, value in env.items()
                        if name in {"CARGO_INCREMENTAL", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR",
                                    "CARGO_BUILD_BUILD_DIR"} or name.startswith("CARGO_PROFILE_")},
        "cargo-configs": {str(path): hashlib.sha256(data).hexdigest()
                          for path, data in cargo_configs(cwd).items()},
    }


CALLBACK_FIXTURE_ENV = "INTENT_ACP_CALLBACK_ADAPTER_FIXTURE"
CALLBACK_PACKAGES = {"intent-acp", "intent-services"}


def needs_callback_fixture(plans: list[list[str]]) -> bool:
    """Recognize the changed-test planner's selectors without compiling.

    --tests includes library unit tests in Cargo; --test NAME and --bins do not.
    Unknown flags, package globs/specs and filter expressions are conservative:
    require the fixture rather than trying to duplicate Cargo/nextest selection.
    """
    if not plans:
        return True
    for plan in plans:
        packages = set()
        targets = set()
        args = iter(plan)
        for arg in args:
            if arg.startswith("--package="):
                packages.add(arg.partition("=")[2])
            elif arg in ("-p", "--package"):
                packages.add(next(args, ""))
            elif arg in ("--test", "--bin"):
                if not next(args, ""):
                    return True
                targets.add(arg)
            elif arg in ("--lib", "--bins", "--tests"):
                targets.add(arg)
            else:
                return True
        if not packages or any(not re.fullmatch(r"[A-Za-z0-9_-]+", p) for p in packages):
            return True
        if packages & CALLBACK_PACKAGES and (
            not targets or targets & {"--lib", "--tests"}
        ):
            return True
    return False


def callback_setup_help(intentd_dir: Path) -> str:
    command = [sys.executable, "-I", "-B", "-S",
               str(intentd_dir / "scripts/prepare-acp-callback-fixture.py"),
               "--cache-dir", str(Path.home() / ".cache/intent/acp-callback-fixture")]
    lines = [
        f"Set {CALLBACK_FIXTURE_ENV} to a verified fixture (Linux x64, descriptor-pinned Node).",
        "No downloads or repairs were attempted. Prepare explicitly, then retry:",
    ]
    for description, flags in (
        ("Existing cache, offline", ["--offline"]),
        ("Local pinned bundle, offline", ["--bundle", "/path/to/pinned-bundle.tar.gz"]),
        ("Source build, network required", ["--build-from-source"]),
    ):
        lines.append(f"  {description}:")
        # Split assignment from export so a failed provisioner is not hidden by
        # export's exit status. Every path inside substitution is shell-quoted.
        lines.append(f'    {CALLBACK_FIXTURE_ENV}="$({shlex.join(command + flags)})"'
                     f" && export {CALLBACK_FIXTURE_ENV}")
    return "\n".join(lines)


def load_callback_validator(intentd_dir: Path):
    path = intentd_dir / "scripts/prepare-acp-callback-fixture.py"
    spec = importlib.util.spec_from_file_location("intent_callback_fixture", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def callback_fixture_identity(intentd_dir: Path) -> dict[str, str]:
    """Verify explicit content on every affected launch; never call prepare().

    The component owns all inventory, lock, descriptor and runtime validation.
    Validation precedes Cargo metadata and all resume reads, even fast resumes.
    """
    try:
        value = os.environ.get(CALLBACK_FIXTURE_ENV)
        if not value:
            raise RuntimeError(f"{CALLBACK_FIXTURE_ENV} is unset or empty")
        validator = load_callback_validator(intentd_dir)
        try:
            validator.platform_check()
            descriptor, manifest = validator.configuration(validator.DEFAULT_DESCRIPTOR)
            # Resolve relative inputs against the Cargo invocation directory;
            # pass the absolute path onward because nextest uses each crate cwd.
            root = intentd_dir / value
            validator.validate_fixture(root, descriptor, manifest)
            with tempfile.TemporaryDirectory(prefix="intent-callback-preflight-") as temp:
                work = Path(temp)
                node = validator.node_tool(descriptor, work, validator.environment(work))
            return {
                "root": str(root.resolve()),
                "descriptor": validator.digest(validator.DEFAULT_DESCRIPTOR),
                "manifest": descriptor["manifest"]["sha256"],
                "node": str(node),
                "node-sha256": validator.digest(node),
            }
        except validator.InvalidFixture as error:
            raise RuntimeError(str(error)) from error
    except (OSError, ImportError, RuntimeError, ValueError, KeyError,
            subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"callback fixture: {error}\n{callback_setup_help(intentd_dir)}") from error


def test_stack_identity(env: dict[str, str]) -> dict[str, object]:
    # Preserve unset (null), empty and explicit values without assuming a Rust
    # default or changing the child's setting. Version the evidence contract.
    return {"version": 1, "RUST_MIN_STACK": env.get("RUST_MIN_STACK")}


TRANSFER_FIXTURE_ENV = "TRANSFER_SELECTION_FIXTURE_ROOT"
TRANSFER_FIXTURE_PATH = "docs/protocol/fixtures/transfer-selection"


def needs_transfer_fixture(plans: list[list[str]]) -> bool:
    """Recognize planner targets; unknown Cargo selectors fail conservatively."""
    if not plans:
        return True
    for plan in plans:
        packages, targets = set(), set()
        args = iter(plan)
        for arg in args:
            if arg.startswith("--package="):
                packages.add(arg.partition("=")[2])
            elif arg in ("-p", "--package"):
                packages.add(next(args, ""))
            elif arg in ("--test", "--bin"):
                if not next(args, ""):
                    return True
                targets.add(arg)
            elif arg in ("--lib", "--bins", "--tests"):
                targets.add(arg)
            else:
                return True
        if not packages or any(not re.fullmatch(r"[A-Za-z0-9_-]+", p) for p in packages):
            return True
        # Cargo --tests includes lib tests; a named integration test does not.
        if "intent-services" in packages and (not targets or targets & {"--lib", "--tests"}):
            return True
    return False


def transfer_fixture_identity(repo_root: Path) -> dict[str, str]:
    """Validate canonical inputs before Cargo or resume; this proves integrity only."""
    canonical = repo_root / TRANSFER_FIXTURE_PATH
    value = os.environ.get(TRANSFER_FIXTURE_ENV, str(canonical))
    try:
        if not value.strip() or not Path(value).is_absolute():
            raise RuntimeError(f"{TRANSFER_FIXTURE_ENV} must be a non-empty absolute path")
        root = Path(value).resolve(strict=True)
        if root != canonical.resolve(strict=True):
            raise RuntimeError("fixtures and validator must belong to this monorepo checkout")
        checker = repo_root / "scripts/check-transfer-selection-contract.mjs"
        # Node resolves '..' lexically; validate the physical directory Rust
        # will read, while retaining the caller's spelling for child forwarding.
        result = subprocess.run(["node", str(checker), "--fixture-root", str(root)],
                                cwd=repo_root, text=True, capture_output=True, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "validator failed")
        # Include content even when the canonical directory contains symlinks,
        # whose targets are not represented by the monorepo Git tree.
        return {"root": value, "validator": required_hash(checker), **{
            name: required_hash(root / name) for name in (
                "contract.json", "public-sessions.json", "public-sessions.desktop-control-v1.json")}}
    except (OSError, RuntimeError, ValueError) as error:
        command = (f"{TRANSFER_FIXTURE_ENV}={shlex.quote(str(canonical))} "
                   + shlex.join(["make", "-C", str(repo_root), "check-transfer-selection-contract"]))
        raise RuntimeError(
            f"transfer-selection fixture: {error}\n"
            "Restore the canonical fixtures from this monorepo checkout, then validate:\n"
            f"  {command}\n"
            f"Unset {TRANSFER_FIXTURE_ENV} to use that default, or set it to the same absolute directory."
        ) from error


def tree_key(repo_root: Path, intentd_dir: Path, output_args: list[str] | None = None,
             fixture_identity: dict[str, str] | None = None,
             transfer_identity: dict[str, str] | None = None,
             *, child_env: dict[str, str] | None = None) -> str:
    intentd_dir = intentd_dir.resolve()
    inputs = {
        "source-root": str(intentd_dir),
        "cargo-outputs": output_args,
        "callback-fixture": fixture_identity,
        "transfer-fixture": transfer_identity,
        "schema": SCHEMA_VERSION,
        "root-tree": worktree_tree(repo_root),
        "intentd-tree": worktree_tree(intentd_dir),
        "submodules": submodule_heads(repo_root),
        "rust-toolchain.toml": required_hash(intentd_dir / "rust-toolchain.toml"),
        "Cargo.lock": required_hash(intentd_dir / "Cargo.lock"),
        ".config/nextest.toml": required_hash(intentd_dir / ".config/nextest.toml"),
        "rustc": run(["rustc", "-vV"], intentd_dir),
        "cargo": run(["cargo", "-V"], intentd_dir),
        "nextest": run(["cargo", "nextest", "--version"], intentd_dir),
        "rustflags": rust_flags(),
        "build-settings": build_settings(intentd_dir),
        # Canonical launchers arm the shared component wrapper before invoking
        # us. Direct runner callers keep their own environment: record that
        # exact value (including unset vs empty), never assume canonical policy.
        "test-policy": {"INTENTD_ASSERT_BOUND_CALLER": os.environ.get("INTENTD_ASSERT_BOUND_CALLER")},
        "test-stack": test_stack_identity(nextest_env() if child_env is None else child_env),
    }
    encoded = json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def prune(cache_dir: Path, now: float | None = None) -> None:
    cutoff = (time.time() if now is None else now) - MAX_AGE_SECONDS
    if not cache_dir.exists():
        return
    for entry in cache_dir.iterdir():
        if KEY_RE.fullmatch(entry.name) and entry.is_dir() and not entry.is_symlink():
            if entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry)


def load_outcomes(record: Path) -> dict[tuple[str, str], str]:
    """Latest recorded outcome per test for this tree.

    The record is append-only and shared by every run on the tree, so a later
    `failed` line supersedes an earlier pass of the same test. Lines without an
    `outcome` field predate failure recording and are passes.
    """
    outcomes: dict[tuple[str, str], str] = {}
    if not record.is_file():
        return outcomes
    with record.open(encoding="utf-8") as lines:
        for line in lines:
            try:
                item = json.loads(line)
                test = (item["binary_id"], item["test"])
                outcome = item.get("outcome", "ok")
                if not all(isinstance(value, str) and value for value in test):
                    continue
            except (json.JSONDecodeError, KeyError, TypeError, AttributeError):
                continue
            outcomes[test] = outcome
    return outcomes


def load_passed(record: Path) -> set[tuple[str, str]]:
    return {test for test, outcome in load_outcomes(record).items() if outcome == "ok"}


def exact_regex(value: str) -> str:
    return "/^" + re.escape(value).replace("/", r"\/") + "$/"


def remaining_filter(passed: set[tuple[str, str]]) -> str:
    tests_by_binary: dict[str, list[str]] = {}
    for binary, test in sorted(passed):
        tests_by_binary.setdefault(binary, []).append(test)
    terms = []
    for binary, tests in tests_by_binary.items():
        test_terms = " | ".join(f"test({exact_regex(test)})" for test in tests)
        terms.append(f"(binary_id({exact_regex(binary)}) and ({test_terms}))")
    return "not (" + " | ".join(terms) + ")"


def test_binary_ids(list_output: str) -> dict[tuple[str, str], str]:
    return inventory(list_output)[1]


def strict_json(text: str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=pairs)


def inventory(text: str):
    """Identity plus activation metadata; duplicates within a listing are invalid."""
    data = strict_json(text)
    identities, aliases = {}, {}
    for suite in data["rust-suites"].values():
        binary = suite["binary-id"]
        alias = f'{suite["package-name"]}::{suite["binary-name"]}'
        for test, metadata in suite["testcases"].items():
            identity = (binary, test)
            if not all(isinstance(value, str) and value for value in identity):
                raise ValueError("invalid test identity")
            if identity in identities or (alias, test) in aliases:
                raise ValueError("duplicate or ambiguous listed identity")
            filtering = metadata.get("filter-match", {"status": "matches"})
            match = filtering["status"]
            if match not in ("matches", "mismatch") or type(metadata.get("ignored", False)) is not bool:
                raise ValueError("unknown inventory activation metadata")
            ignored_filter = match == "mismatch" and filtering.get("reason") == "ignored"
            identities[identity] = {"active": match == "matches" or ignored_filter,
                "ignored": metadata.get("ignored", False), "annotation_known": "ignored" in metadata,
                "skipped": ignored_filter or ("filter-match" not in metadata and metadata.get("ignored", False)),
                "filter_known": "filter-match" in metadata, "alias": alias}
            aliases[alias, test] = binary
    return identities, aliases


CATEGORIES = ("executed-passed", "resumed-passed", "ignored", "failed", "unfinished")
COMPATIBILITY_FIELDS = ("tree_key", "cargo_output_args", "cargo_config_args", "test_stack",
                        "callback_fixture", "transfer_fixture")


def identity_set(rows):
    if not isinstance(rows, list):
        raise ValueError("missing identity membership")
    result = set()
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) != 2 or not all(isinstance(x, str) and x for x in row):
            raise ValueError("invalid identity membership")
        if tuple(row) in result:
            raise ValueError("duplicate identity membership")
        result.add(tuple(row))
    return result


def receipt_inventories(directory: Path, receipt: dict):
    inventories = []
    aliases = {}
    selections = receipt["selections"]
    if not selections or len(receipt["selection_membership"]) != len(selections):
        raise ValueError("missing selection membership")
    for index in range(1, len(selections) + 1):
        members, names = inventory((directory / f"listing-{index}.json").read_text())
        if set(members) != identity_set(receipt["selection_membership"][index - 1]):
            raise ValueError("listing and recorded membership differ")
        for name, binary in names.items():
            if name in aliases and aliases[name] != binary:
                raise ValueError("ambiguous identity across selections")
            aliases[name] = binary
        inventories.append(members)
    return inventories



def validate_result_config(directory: Path, receipt: dict, result: dict, resumed: set) -> None:
    index = result["selection_index"]
    for field in ("native_exit_code", "exit_code"):
        if result[field] is not None and type(result[field]) is not int:
            raise ValueError("invalid native status evidence")
    planned = receipt["plan_key"] is not None
    config = f"nextest-{index}.toml" if planned else "nextest.toml"
    junit = f"junit-{index}.xml" if planned else "junit.xml"
    if result["config"] != config or result["junit"] != junit:
        raise ValueError("result paths disagree with selection")
    expected_profile = {"inherits": "default", "junit": {"path": junit}}
    if resumed:
        expected_profile["default-filter"] = remaining_filter(resumed)
    expected = {"store": {"dir": str(directory.parent)},
                "profile": {receipt["attempt_id"]: expected_profile}}
    if cargo_toml.loads((directory / config).read_text()) != expected:
        raise ValueError("saved nextest config disagrees with receipt")
    command = ["cargo", "nextest", "run", *receipt["selections"][index - 1],
               "--build-jobs", receipt["build_jobs"], "--test-threads", receipt["test_threads"],
               "--tool-config-file", f"intent-gate:{directory / config}",
               "--profile", receipt["attempt_id"], "--message-format", "libtest-json-plus",
               "--message-format-version", "0.1", *receipt["cargo_config_args"], *receipt["cargo_output_args"]]
    if receipt["no_fail_fast"]:
        command.append("--no-fail-fast")
    if resumed:
        command.extend(["--no-tests", "pass"])
    if result["command"] != command or result["plan"] != " ".join(receipt["selections"][index - 1]):
        raise ValueError("saved command disagrees with receipt")

def selection_evidence(directory: Path, result: dict, members: dict, resumed: set):
    """Replay terminal events; retries replace failures, duplicate terminals fail closed.

    A missing JUnit is honest for interrupted children. Available JUnit must
    corroborate raw outcomes; it may additionally record a started test's abort
    after interrupted stdout ends. That is failure evidence, never pass credit.
    """
    index = result["selection_index"]
    if result["events"] != f"events-{index}.jsonl":
        raise ValueError("unexpected events path")
    aliases = {(meta["alias"], test): (binary, test)
               for (binary, test), meta in members.items()}
    suite_aliases = {meta["alias"] for meta in members.values()}
    outcomes, history, frames, summaries, started = {}, {}, {}, [], set()
    if (not (directory / result["events"]).exists() and
            all(result[field] is None for field in ("native_exit_code", "exit_code", "finished_at")) and
            not (directory / result["junit"]).exists()):
        # The receipt precedes opening stdout. Loss in that window supplies no
        # outcome for this child, but must not erase another child's raw pass.
        return {}, {}, "absent"
    with (directory / result["events"]).open() as stream:
        for line_number, line in enumerate(stream, 1):
            try:
                event = strict_json(line)
            except ValueError:
                # Abrupt loss can truncate the final line; it is never evidence.
                if not line.endswith("\n") and result.get("native_exit_code") != 0:
                    continue
                raise ValueError("malformed raw event")
            if not isinstance(event, dict):
                raise ValueError("invalid raw event")
            if event.get("type") == "suite" and event.get("event") == "started":
                metadata = event.get("nextest", {})
                alias = f'{metadata.get("crate")}::{metadata.get("test_binary")}'
                if alias not in suite_aliases:
                    raise ValueError("unknown suite frame")
                if alias in frames and not frames[alias]["closed"]:
                    raise ValueError("overlapping suite frames")
                frames[alias] = {"closed": False, "outcomes": {}}
            if event.get("type") == "suite" and event.get("event") in ("ok", "failed"):
                summary = suite_ignored_count(line)
                if summary is None or summary[0] not in suite_aliases:
                    raise ValueError("invalid terminal suite summary")
                frame = frames.setdefault(summary[0], {"closed": False, "outcomes": {}})
                if frame["closed"]:
                    raise ValueError("duplicate suite summary")
                frame["closed"] = True
                summaries.append((summary[0], event, frame["outcomes"]))
            if event.get("type") != "test":
                continue
            if event.get("event") not in (*TEST_OUTCOMES, "started"):
                raise ValueError("unknown terminal test outcome")
            name = event.get("name", "")
            alias, sep, test = name.partition("$")
            retry = RETRY_SUFFIX_RE.search(test)
            test = RETRY_SUFFIX_RE.sub("", test)
            identity = aliases.get((alias, test))
            if (not sep or identity is None or not members[identity]["active"] or
                    identity in resumed and not members[identity]["skipped"]):
                raise ValueError(f"unselected or resumed terminal event: {name}")
            frame = frames.setdefault(alias, {"closed": False, "outcomes": {}})
            if frame["closed"]:
                raise ValueError("test event outside an open suite frame")
            if event["event"] == "started":
                started.add(identity)
                continue
            if ((members[identity]["skipped"] and event["event"] != "ignored") or
                    (members[identity]["filter_known"] and not members[identity]["skipped"] and event["event"] == "ignored")):
                raise ValueError("terminal outcome disagrees with selection metadata")
            ordinal = int(retry.group()[1:]) if retry else 1
            previous = history.get(identity, [])
            if ordinal < 1 or (previous and (ordinal != previous[-1]["retry"] + 1 or previous[-1]["outcome"] != "failed")):
                raise ValueError(f"duplicate or invalid retry terminal: {name}")
            previous.append({"outcome": event["event"], "retry": ordinal, "event_line": line_number})
            history[identity] = previous
            outcomes[identity] = event["event"]
            frame["outcomes"][identity] = event["event"]
    for alias, summary, frame_outcomes in summaries:
        count = summary["ignored"]
        for field, outcome in (("passed", "ok"), ("failed", "failed")):
            if field in summary:
                observed_count = sum(value == outcome and members[identity]["alias"] == alias
                                     for identity, value in frame_outcomes.items())
                if type(summary[field]) is not int or summary[field] != observed_count:
                    raise ValueError(f"{field} suite total disagrees with raw outcomes")
        # Native suite totals count annotations, even with --run-ignored all or
        # expression filters. Only selection metadata identifies skipped tests.
        annotated = {identity for identity, meta in members.items() if meta["alias"] == alias and meta["ignored"]}
        legacy_observed = {identity for identity, outcome in outcomes.items()
                          if outcome == "ignored" and members[identity]["alias"] == alias and not members[identity]["annotation_known"]}
        if count != len(annotated | legacy_observed):
            raise ValueError("ignored summary cannot be reconciled to exact identities")
        ignored = {identity for identity, meta in members.items()
                   if meta["alias"] == alias and meta["active"] and meta["skipped"]}
        for identity in ignored:
            if identity in outcomes and outcomes[identity] != "ignored":
                raise ValueError("ignored inventory disagrees with execution")
            outcomes[identity] = "ignored"
    junit_path = directory / result["junit"]
    if result["junit"] not in ("junit.xml", f"junit-{index}.xml"):
        raise ValueError("unexpected JUnit path")
    junit_status = "absent"
    if junit_path.exists():
        xml = ET.parse(junit_path).getroot()
        if xml.tag not in ("testsuites", "testsuite"):
            raise ValueError("invalid JUnit root")
        junit, aborted = {}, set()
        for suite in xml.iter("testsuite"):
            for case in suite.findall("testcase"):
                identity = (suite.get("name"), case.get("name"))
                if identity not in members or identity in junit:
                    raise ValueError("unknown or duplicate JUnit identity")
                junit[identity] = ("failed" if case.find("failure") is not None or case.find("error") is not None
                                   else "ignored" if case.find("skipped") is not None else "ok")
                if any(node.get("type") == "test abort" for node in case.findall("failure") + case.findall("error")):
                    aborted.add(identity)
        if len(list(xml.iter("testcase"))) != len(junit):
            raise ValueError("unmapped JUnit cases")
        # nextest may finish cancellation bookkeeping after stdout capture was
        # interrupted. Preserve corroborated passes and expose those failures
        # explicitly, without inventing a terminal event or successful child.
        extra = junit.keys() - outcomes.keys()
        if extra:
            if (result["native_exit_code"] in (None, 0) or result["exit_code"] == 0 or
                    not extra <= aborted & started or any(
                        not members[i]["active"] or members[i]["skipped"] or i in resumed for i in extra)):
                raise ValueError("unexplained JUnit outcomes absent from raw events")
            outcomes.update({identity: "failed" for identity in extra})
        # Nextest omits ignored cases in JUnit; either omission or explicit skipped is valid.
        expected = {identity: outcome for identity, outcome in outcomes.items() if outcome != "ignored"}
        if {i: o for i, o in junit.items() if o != "ignored"} != expected or any(
                outcomes.get(i) != o for i, o in junit.items()):
            raise ValueError("JUnit and raw outcomes disagree")
        junit_status = "validated-partial" if extra else "validated"
    return outcomes, history, junit_status


class Evidence:
    """One invocation's memoized validation of direct execution references."""
    def __init__(self, tree: Path, current: dict):
        self.tree, self.current = tree, current
        self.cache = {}

    def read(self, reference: str):
        if reference in self.cache:
            value = self.cache[reference]
            if isinstance(value, Exception):
                # Do not grow a cached exception's traceback once per test.
                raise ValueError(str(value)) from None
            return value
        try:
            value = self._read(reference)
        except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError, ET.ParseError) as error:
            self.cache[reference] = error
            raise
        self.cache[reference] = value
        return value

    def _read(self, reference: str):
        parts = Path(reference).parts
        if not (len(parts) == 2 and parts[0] == "attempts" or
                len(parts) == 4 and parts[0] == "changed" and KEY_RE.fullmatch(parts[1]) and parts[2] == "attempts"):
            raise ValueError("invalid attempt reference")
        if not re.fullmatch(r"[0-9a-f]{32}", parts[-1]):
            raise ValueError("invalid attempt ID")
        directory = self.tree / reference
        if directory.resolve() != directory.absolute():
            raise ValueError("attempt reference follows a symlink")
        receipt = strict_json((directory / "run.json").read_text())
        if type(receipt.get("receipt_schema")) is not int or receipt["receipt_schema"] != 1 or receipt.get("attempt_id") != directory.name:
            raise ValueError("unsupported or mismatched receipt")
        if receipt.get("exit_code") is not None and type(receipt["exit_code"]) is not int:
            raise ValueError("invalid receipt exit status")
        if receipt.get("kind") != "execution" or any(
                field not in receipt or receipt[field] != self.current[field] for field in COMPATIBILITY_FIELDS):
            raise ValueError("incompatible attempt evidence")
        expected_plan = parts[1] if len(parts) == 4 else None
        if receipt["plan_key"] != expected_plan or (expected_plan is not None and
                plan_key(receipt["selections"]) != expected_plan) or (
                expected_plan is None and receipt["selections"] != [["--workspace"]]):
            raise ValueError("mismatched plan identity")
        if strict_json((directory / "test-stack.json").read_text()) != receipt["test_stack"]:
            raise ValueError("stack evidence disagrees with receipt")
        inventories = receipt_inventories(directory, receipt)
        resumed = identity_set(receipt["resumed_tests"])
        results = {}
        for result in receipt["results"]:
            index = result["selection_index"]
            if type(index) is not int or index in results or not 1 <= index <= len(inventories):
                raise ValueError("duplicate or invalid result selection")
            validate_result_config(directory, receipt, result, resumed)
            outcomes, history, junit = selection_evidence(directory, result, inventories[index - 1], resumed)
            results[index] = (outcomes, history, junit)
        return receipt, inventories, results

    def credit(self, row: dict):
        receipt, inventories, results = self.read(row["attempt"])
        identity = (row["binary_id"], row["test"])
        if type(row["selection_index"]) is not int or type(row["event_line"]) is not int:
            raise ValueError("invalid event reference")
        outcomes, history, _ = results[row["selection_index"]]
        last_index = max(index for index, (outcomes, _, _) in results.items()
                         if identity in outcomes and outcomes[identity] != "ignored")
        if row["selection_index"] != last_index:
            raise ValueError("pass reference was superseded in this attempt")
        if outcomes.get(identity) != "ok" or history[identity][-1]["event_line"] != row["event_line"]:
            raise ValueError("pass reference does not identify a final raw pass")
        return identity


def eligible_credits(record: Path, evidence: Evidence):
    latest, errors, references = {}, [], set()
    if record.exists():
        for line in record.read_text().splitlines():
            try:
                row = strict_json(line)
                identity = (row["binary_id"], row["test"])
                if not all(isinstance(x, str) and x for x in identity):
                    raise ValueError("invalid journal identity")
                if "attempt" in row:
                    reference = (row["attempt"], row["selection_index"], row["event_line"])
                    if reference in references:
                        raise ValueError("duplicate journal event reference")
                    references.add(reference)
                latest[identity] = row
            except (ValueError, KeyError, TypeError, AttributeError):
                # Unknown malformed records could hide a later failure. Drop
                # earlier credit, but allow fresh evidence appended afterwards.
                latest.clear()
                errors.append("malformed or duplicate shared journal record")
                continue
    credits = {}
    for identity, row in latest.items():
        if row.get("outcome", "ok") != "ok":
            continue
        try:
            if evidence.credit(row) != identity:
                raise ValueError("journal identity mismatch")
            credits[identity] = row
        except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError, ET.ParseError) as error:
            errors.append(f"{identity}: {error}")
    return credits, errors


def coverage_report(directory: Path, receipt: dict, credits: dict):
    categories = {name: set() for name in CATEGORIES}
    report = {"coverage_schema": 1, "attempt_id": receipt["attempt_id"],
              "tree_key": receipt["tree_key"], "plan_key": receipt["plan_key"], "kind": "execution",
              "membership_complete": False, "complete": False, "errors": [], "active": [], "inactive_filtered": [],
              "categories": {}, "resume_sources": [], "selections": []}
    active, inactive, executed, failed, ignored, unfinished = (set() for _ in range(6))
    try:
        inventories = receipt_inventories(directory, receipt)
        report["membership_complete"] = True
        resumed = identity_set(receipt["resumed_tests"])
        for members in inventories:
            active.update(i for i, meta in members.items() if meta["active"])
            inactive.update(i for i, meta in members.items() if not meta["active"])
        if not resumed <= active or not resumed <= credits.keys():
            raise ValueError("resumed membership has no eligible pass reference")
        results = {result["selection_index"]: result for result in receipt["results"]}
        if len(results) != len(receipt["results"]) or not set(results) <= set(range(1, len(inventories) + 1)):
            raise ValueError("duplicate or invalid result selection")
        all_obligations = True
        for index, members in enumerate(inventories, 1):
            selected = {i for i, meta in members.items() if meta["active"]}
            outcomes, history, junit = {}, {}, "absent"
            result = results.get(index)
            if result is not None:
                try:
                    validate_result_config(directory, receipt, result, resumed)
                    outcomes, history, junit = selection_evidence(directory, result, members, resumed)
                except (OSError, ValueError, KeyError, TypeError, AttributeError, ET.ParseError) as error:
                    report["errors"].append(f"selection {index}: {error}")
            executed.update(i for i, o in outcomes.items() if o == "ok")
            failed.update(i for i, o in outcomes.items() if o == "failed")
            ignored.update(i for i, o in outcomes.items() if o == "ignored")
            missing = selected - outcomes.keys() - resumed
            unfinished.update(missing)
            if (missing or result is None or result["native_exit_code"] != 0 or
                    result["exit_code"] != 0 or not result["finished_at"]):
                all_obligations = False
            report["selections"].append({"selection_index": index, "evidence_attempt": receipt["attempt_id"], "active": sorted(selected),
                "unfinished": sorted(missing), "native_exit_code": result["native_exit_code"] if result else None,
                "junit": junit, "outcomes": [{"identity": identity, "outcome": outcome,
                "source": "raw" if identity in history else "junit" if outcome == "failed" else "suite-summary",
                "events": history.get(identity, [])} for identity, outcome in sorted(outcomes.items())]})
        categories["failed"] = failed
        categories["unfinished"] = unfinished - failed
        categories["executed-passed"] = executed - failed - unfinished
        categories["resumed-passed"] = resumed - failed - executed - unfinished
        categories["ignored"] = ignored - failed - executed - resumed - unfinished
        report["resume_sources"] = [credits[i] for i in sorted(resumed)]
        report["complete"] = all_obligations and not failed and not report["errors"] and receipt["exit_code"] == 0 and bool(receipt["finished_at"])
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError, ET.ParseError) as error:
        report["errors"].append(str(error))
        # Discovery itself may be interrupted. Preserve the identities we can
        # still prove; membership_complete=false distinguishes unknown remainder.
        if not report["membership_complete"]:
            for index in range(1, len(receipt["selections"]) + 1):
                try:
                    members, _ = inventory((directory / f"listing-{index}.json").read_text())
                    if set(members) != identity_set(receipt["selection_membership"][index - 1]):
                        continue
                    active.update(i for i, meta in members.items() if meta["active"])
                    inactive.update(i for i, meta in members.items() if not meta["active"])
                except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError):
                    continue
    categories["unfinished"].update(active - set().union(*categories.values()))
    report.update(active=sorted(active), inactive_filtered=sorted(inactive - active),
                  categories={name: sorted(rows) for name, rows in categories.items()})
    return report


def parse_recorded_event(
    line: str, binary_ids: dict[tuple[str, str], str]
) -> tuple[str, str, str] | None:
    """Return (binary_id, test, outcome) for a pass or failure event, else None."""
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict) or event.get("type") != "test":
        return None
    outcome = event.get("event")
    if outcome not in RECORDED_OUTCOMES:
        return None
    suite, separator, test = event.get("name", "").partition("$")
    if not separator or not suite or not test:
        raise RuntimeError(f"unexpected nextest test identifier: {event.get('name')!r}")
    test = RETRY_SUFFIX_RE.sub("", test)
    binary_id = binary_ids.get((suite, test))
    if binary_id is None:
        raise RuntimeError(f"nextest test identifier was not listed: {event.get('name')!r}")
    return binary_id, test, outcome


def record_line(binary_id: str, test: str, outcome: str) -> str:
    item: dict[str, str] = {"binary_id": binary_id, "test": test}
    if outcome != "ok":
        item["outcome"] = outcome
    return json.dumps(item) + "\n"


def test_outcome(line: str) -> tuple[str, str] | None:
    """Return (test identifier without retry suffix, outcome) for a final test event."""
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict) or event.get("type") != "test":
        return None
    outcome = event.get("event")
    if outcome not in TEST_OUTCOMES:
        return None
    return RETRY_SUFFIX_RE.sub("", event.get("name", "")), outcome


def suite_ignored_count(line: str) -> tuple[str, int] | None:
    """Read a completed libtest-json-plus suite's ignored total and identity."""
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict) or event.get("type") != "suite":
        return None
    if event.get("event") not in ("ok", "failed"):
        return None
    metadata = event.get("nextest")
    ignored = event.get("ignored")
    if not isinstance(metadata, dict) or type(ignored) is not int or ignored < 0:
        return None
    crate, binary = metadata.get("crate"), metadata.get("test_binary")
    if not isinstance(crate, str) or not crate or not isinstance(binary, str) or not binary:
        return None
    return f"{crate}::{binary}", ignored


def tally(
    outcomes: dict[str, str], suite_ignored: dict[str, int] | None = None
) -> dict[str, int]:
    counts = {"passed": 0, "failed": 0, "ignored": 0}
    individual_ignored: dict[str, int] = {}
    for name, outcome in outcomes.items():
        counts["passed" if outcome == "ok" else outcome] += 1
        if outcome == "ignored":
            suite = name.partition("$")[0]
            individual_ignored[suite] = individual_ignored.get(suite, 0) + 1
    # Nextest can omit individual ignored events. Fill only the shortfall for
    # each completed suite; unfinished suites keep their individual counts.
    # filtered_out (including resumed tests) is deliberately not an ignored count.
    for suite, ignored in (suite_ignored or {}).items():
        counts["ignored"] += max(0, ignored - individual_ignored.get(suite, 0))
    return counts


def split_plans(plans: list[str] | None) -> list[list[str]]:
    return [shlex.split(plan) for plan in plans or []]


def plan_key(plans: list[list[str]]) -> str:
    encoded = json.dumps([" ".join(plan) for plan in plans]).encode()
    return hashlib.sha256(encoded).hexdigest()


def summary_line(label: str, counts: dict[str, int], resumed: int) -> str:
    return (
        f"[{label}] summary: {counts['passed']} passed, {counts['failed']} failed, "
        f"{counts['ignored']} skipped/ignored, {resumed} resumed "
        "(tests already passed for this tree)"
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_atomic(path: Path, text: str) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def write_tool_config(
    path: Path,
    cache_dir: Path,
    profile: str,
    passed: set[tuple[str, str]],
    junit: str = "junit.xml",
) -> None:
    lines = [
        "[store]",
        f"dir = {json.dumps(str(cache_dir))}",
        f"[profile.{profile}]",
        'inherits = "default"',
    ]
    if passed:
        lines.append(f"default-filter = {json.dumps(remaining_filter(passed))}")
    lines.extend([f"[profile.{profile}.junit]", f"path = {json.dumps(junit)}", ""])
    write_atomic(path, "\n".join(lines))


def nextest_env() -> dict[str, str]:
    env = os.environ.copy()
    env["NEXTEST_EXPERIMENTAL_LIBTEST_JSON"] = "1"
    # nextest draws its progress bar on stderr whenever stderr is a TTY; under a
    # PTY-backed script runner that fills the captured output with redraws.
    env.setdefault("NEXTEST_HIDE_PROGRESS_BAR", "1")
    return env


def invalidate_completion_markers(run_dir: Path) -> None:
    """Remove the tree-level `complete` and every planned `changed/*/complete`.

    A marker only proves that the tests it covered passed on this tree as far as
    the shared passed.jsonl records them. Once a failure is observed, or once the
    journal is about to be truncated, that evidence is gone for every run on the
    tree, so no marker may outlive it.
    """
    (run_dir / "complete").unlink(missing_ok=True)
    changed = run_dir / "changed"
    if changed.is_dir():
        for marker in changed.glob("*/complete"):
            marker.unlink(missing_ok=True)


def stream_nextest(
    command: list[str],
    cwd: Path,
    env: dict[str, str],
    binary_ids: dict[tuple[str, str], str],
    descriptor: int,
    outcomes: dict[str, str],
    suite_ignored: dict[str, int],
    run_dir: Path,
    events,
    result: dict[str, object],
) -> int:
    process = subprocess.Popen(command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE)
    assert process.stdout is not None
    try:
        for line_number, line in enumerate(process.stdout, 1):
            events.write(line)
            events.flush()
            sys.stdout.write(line)
            sys.stdout.flush()
            outcome = test_outcome(line)
            if outcome is not None:
                outcomes[outcome[0]] = outcome[1]
            ignored = suite_ignored_count(line)
            if ignored is not None:
                suite_ignored[ignored[0]] = ignored[1]
            recorded = parse_recorded_event(line, binary_ids)
            if recorded is not None:
                if recorded[2] != "ok":
                    # Persist the invalidation at the moment of failure, before the
                    # journal line, so an interrupt cannot leave a marker resting on
                    # a pass this failure has just superseded.
                    invalidate_completion_markers(run_dir)
                row = json.loads(record_line(*recorded))
                row.update(attempt=str(Path(events.name).parent.relative_to(run_dir)),
                           selection_index=result["selection_index"], event_line=line_number)
                os.write(descriptor, (json.dumps(row) + "\n").encode())
        status = process.wait()
        result.update(native_exit_code=status, finished_at=utc_now())
        return status
    except BaseException:
        process.terminate()
        result.update(native_exit_code=process.wait(), finished_at=utc_now())
        raise


def completed_attempt(record_dir: Path) -> str | None:
    """Only new markers point to receipts; legacy markers have no attempt ID."""
    value = (record_dir / "complete").read_text(encoding="utf-8").strip()
    return value if re.fullmatch(r"[0-9a-f]{32}", value) else None



class Terminated(BaseException):
    """Raised by the SIGTERM handler so `finally` blocks run before the runner exits."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"terminated by signal {signum}")
        self.signum = signum


@contextlib.contextmanager
def terminate_on_signal():
    if threading.current_thread() is not threading.main_thread():
        yield
        return

    def handler(signum, _frame):
        raise Terminated(signum)

    previous = signal.signal(signal.SIGTERM, handler)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


HANDLED_ERROR_EXIT = 2


def failure_exit_code(error: BaseException) -> int:
    """The process exit code an exception escaping the nextest phase produces."""
    if isinstance(error, subprocess.CalledProcessError):
        return error.returncode
    if isinstance(error, KeyboardInterrupt):
        return 130
    if isinstance(error, Terminated):
        return 128 + error.signum
    if isinstance(error, (OSError, RuntimeError)):
        return HANDLED_ERROR_EXIT
    # Anything else propagates unhandled, which exits the interpreter with 1.
    return 1


def isolated_output_args(cwd: Path, config: list[str], env: dict[str, str]) -> list[str]:
    """Keep another checkout's Cargo writer out of this gate's executable paths.

    Resolve both output roots through Cargo so config includes and environment
    precedence remain Cargo's responsibility. Keep the chosen storage volumes,
    but use a stable per-checkout child for warm builds across repeated gates.
    A separate build-dir must be isolated too: it contains the test executables.
    """
    metadata = json.loads(run(
        ["cargo", "metadata", "--no-deps", "--format-version", "1", *config], cwd, env
    ))
    owner = hashlib.sha256(os.fsencode(cwd.resolve())).hexdigest()
    def owned(key: str) -> str:
        path = metadata[key]
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise RuntimeError(f"Cargo metadata returned an invalid {key}: {path!r}")
        root = Path(path).resolve()
        # Reusing a printed output path must not keep nesting intent-gates.
        if root.parent.name == "intent-gates" and KEY_RE.fullmatch(root.name):
            root = root.parent.parent
        return str(root / "intent-gates" / owner)
    target = owned("target_directory")
    build = owned("build_directory") if "build_directory" in metadata else target
    return ["--target-dir", target, "--config", f"build.build-dir={json.dumps(build, ensure_ascii=False)}"]


def run_nextest(args: argparse.Namespace) -> int:
    label = args.label
    no_fail_fast = args.no_fail_fast == "1"
    repo_root = Path(args.repo_root).resolve()
    intentd_dir = (repo_root / args.intentd_dir).resolve()
    cache_dir = Path(args.cache_dir).expanduser().resolve()
    plans = split_plans(args.plan)
    fixture_identity = callback_fixture_identity(intentd_dir) if needs_callback_fixture(plans) else None
    transfer_identity = transfer_fixture_identity(repo_root) if needs_transfer_fixture(plans) else None
    cargo_config = compact_config(intentd_dir)
    announce_compact()
    prune(cache_dir)
    env = nextest_env()
    if fixture_identity is not None:
        env[CALLBACK_FIXTURE_ENV] = fixture_identity["root"]
    if transfer_identity is not None:
        env[TRANSFER_FIXTURE_ENV] = transfer_identity["root"]
    if cargo_config:
        env["CARGO_INCREMENTAL"] = "0"
    # Resolve before accepting resume evidence: unchanged config text can expand
    # to different paths (Cargo home templates or retargeted output symlinks).
    try:
        with terminate_on_signal():
            output_args = isolated_output_args(intentd_dir, cargo_config, env)
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError,
            KeyboardInterrupt, Terminated) as error:
        print(f"[{label}] ERROR: resolving Cargo outputs: {error}", file=sys.stderr, flush=True)
        return failure_exit_code(error)
    key = tree_key(repo_root, intentd_dir, output_args, fixture_identity,
                   transfer_identity=transfer_identity, child_env=env)
    run_dir = cache_dir / key
    run_dir.mkdir(parents=True, exist_ok=True)
    os.utime(run_dir)
    if plans:
        plan_identity = plan_key(plans)
        scope_dir = run_dir / "changed" / plan_identity
        selections = plans
        scope = "every planned test"
    else:
        plan_identity = None
        scope_dir = run_dir
        selections = [["--workspace"]]
        scope = "the complete suite"
    # Receipt schema is independent of the resume fingerprint. Never migrate or
    # alias old per-plan files: they remain evidence of exactly what was saved.
    # Only this invocation writes its attempt; pruning still expires whole trees.
    profile = uuid.uuid4().hex
    store_dir = scope_dir / "attempts"
    record_dir = store_dir / profile
    record_dir.mkdir(parents=True)
    complete = scope_dir / "complete"
    results: list[dict[str, object]] = []
    resumed: set[tuple[str, str]] = set()
    run_record = {
        "receipt_schema": 1, "attempt_id": profile, "kind": "execution",
        "label": label, "base": args.base, "plans": [" ".join(plan) for plan in plans],
        "tree_key": key, "plan_key": plan_identity,
        "started_at": utc_now(), "finished_at": None, "exit_code": None,
        "cargo_output_args": output_args, "cargo_config_args": cargo_config,
        "resume_requested": args.resume == "1", "force": args.force == "1",
        "no_fail_fast": no_fail_fast, "build_jobs": args.build_jobs,
        "test_threads": args.test_threads, "test_stack": test_stack_identity(env),
        "callback_fixture": fixture_identity, "transfer_fixture": transfer_identity,
        "resume_source_attempt": None, "resume_candidates": [], "resumed_tests": None,
        "selection_membership": [None for _ in selections],
        "selections": selections, "results": results,
        "skipped_resumed": 0, "passed": 0, "failed": 0, "ignored": 0,
    }

    def save_receipt() -> None:
        write_atomic(record_dir / "run.json", json.dumps(run_record, indent=2) + "\n")

    save_receipt()

    credits = {}

    def finalize(status: int | None) -> int | None:
        totals = {"passed": 0, "failed": 0, "ignored": 0}
        for result in results:
            for name in totals:
                totals[name] += int(result[name])
        run_record.update(totals, finished_at=utc_now(), exit_code=status,
                          skipped_resumed=len(resumed))
        if status != 0:
            partial = coverage_report(record_dir, run_record, credits)
            cancellation_rows = []
            for selection in partial["selections"]:
                for outcome in selection["outcomes"]:
                    if outcome["source"] == "junit" and outcome["outcome"] == "failed":
                        binary, test = outcome["identity"]
                        cancellation_rows.append({"binary_id": binary, "test": test, "outcome": "failed",
                            "failure_evidence": {"attempt": str(record_dir.relative_to(run_dir)),
                                "selection_index": selection["selection_index"], "source": "junit"}})
            if cancellation_rows:
                # These are failure-only invalidations, not raw pass references.
                # Append to the shared journal; historical attempts stay untouched.
                invalidate_completion_markers(run_dir)
                with (run_dir / "passed.jsonl").open("a", encoding="utf-8") as journal:
                    for row in cancellation_rows:
                        journal.write(json.dumps(row) + "\n")
        # Re-read at the decision point: a failure or damaged source observed
        # during execution must not leave a marker based on initial credit.
        try:
            final_credits, _ = eligible_credits(run_dir / "passed.jsonl", Evidence(run_dir, run_record))
        except OSError:
            final_credits = {}
        proof = coverage_report(record_dir, run_record, final_credits)
        if proof["complete"] and not set(map(tuple, proof["categories"]["executed-passed"])) <= final_credits.keys():
            proof["complete"] = False
            proof["errors"].append("executed passes no longer have current journal evidence")
        write_atomic(record_dir / "coverage.json", json.dumps(proof, indent=2) + "\n")
        if status == 0 and not proof["complete"]:
            status = HANDLED_ERROR_EXIT
            run_record["exit_code"] = status
            print(f"[{label}] ERROR: coverage evidence is incomplete or inconsistent", file=sys.stderr, flush=True)
        save_receipt()
        if status == 0 and proof["complete"]:
            write_atomic(complete, profile + "\n")
            if resumed:
                print(f"resumed: skipped {len(resumed)} tests already passed for this tree", flush=True)
        summary = summary_line(label, totals, len(resumed))
        write_atomic(record_dir / "summary.txt", summary + "\n")
        print(summary, flush=True)
        print(f"[{label}] record: {record_dir}", flush=True)
        return status

    # From the first `cargo nextest list` onwards every exit — failure,
    # KeyboardInterrupt or SIGTERM — leaves the summary/record lines and files.
    try:
        with terminate_on_signal():
            write_atomic(record_dir / "test-stack.json", json.dumps(test_stack_identity(env), indent=2) + "\n")
            project_config = intentd_dir / ".config/nextest.toml"
            if project_config.is_file():
                (record_dir / "project-nextest.toml").write_bytes(project_config.read_bytes())
            record = run_dir / "passed.jsonl"
            outcomes_by_test = load_outcomes(record)
            recorded = {test for test, outcome in outcomes_by_test.items() if outcome == "ok"}
            failed_on_tree = len(outcomes_by_test) - len(recorded)
            resuming = args.resume == "1" and args.force != "1"
            resumed = recorded if resuming else set()
            run_record["resume_candidates"] = sorted(resumed)
            save_receipt()
            evidence = Evidence(run_dir, run_record)
            credits, rejected = eligible_credits(record, evidence) if resuming else ({}, [])
            resumed = set(credits)
            run_record["resume_candidates"] = sorted(resumed)
            run_record["rejected_resume_evidence"] = rejected
            if complete.is_file() and not failed_on_tree and resuming:
                try:
                    source_id = completed_attempt(scope_dir)
                    if source_id is None:
                        raise ValueError("legacy marker has no verifiable receipt")
                    source_dir = scope_dir / "attempts" / source_id
                    source, _, _ = evidence.read(str(source_dir.relative_to(run_dir)))
                    if source["selections"] != selections:
                        raise ValueError("completion selection arguments differ")
                    proof = coverage_report(source_dir, source, credits)
                    passed = set(map(tuple, proof["categories"]["executed-passed"])) | set(map(tuple, proof["categories"]["resumed-passed"]))
                    if not proof["complete"] or not passed <= credits.keys():
                        raise ValueError("completion evidence no longer validates")
                    for index in range(1, len(selections) + 1):
                        (record_dir / f"listing-{index}.json").write_bytes((source_dir / f"listing-{index}.json").read_bytes())
                    proof.update(attempt_id=profile, kind="completed-resume", source_attempt=str(source_dir.relative_to(run_dir)))
                    proof["categories"]["executed-passed"] = []
                    proof["categories"]["resumed-passed"] = sorted(passed)
                    proof["resume_sources"] = [credits[i] for i in sorted(passed)]
                    write_atomic(record_dir / "coverage.json", json.dumps(proof, indent=2) + "\n")
                    run_record.update(kind="completed-resume", resume_source_attempt=source_id,
                                      resumed_tests=sorted(passed), selection_membership=source["selection_membership"],
                                      skipped_resumed=len(passed), finished_at=utc_now(), exit_code=0)
                    save_receipt()
                    print(f"resumed: skipped {len(passed)} tests already passed for this tree", flush=True)
                    print(f"[{label}] record: {record_dir}", flush=True)
                    return 0
                except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError, ET.ParseError):
                    pass
            # Failed/interrupted listing cannot leave a stale completion marker.
            complete.unlink(missing_ok=True)
            print(f"[{label}] isolated Cargo outputs: {shlex.join(output_args)}", flush=True)
            write_atomic(record_dir / "cargo-outputs.json", json.dumps({
                "source_root": str(intentd_dir), "args": output_args,
            }, indent=2) + "\n")
            binary_ids: dict[tuple[str, str], str] = {}
            for index, selection in enumerate(selections, start=1):
                list_output = run(
                    [
                        "cargo", "nextest", "list", *selection,
                        "--build-jobs", args.build_jobs,
                        "--message-format", "json",
                        *cargo_config, *output_args,
                    ],
                    intentd_dir,
                    env,
                )
                write_atomic(record_dir / f"listing-{index}.json", list_output + "\n")
                selected_ids = test_binary_ids(list_output)
                run_record["selection_membership"][index - 1] = sorted(
                    {(binary_id, test) for (_, test), binary_id in selected_ids.items()})
                save_receipt()
                for identity, binary in selected_ids.items():
                    if identity in binary_ids and binary_ids[identity] != binary:
                        raise RuntimeError("ambiguous nextest identity across selections")
                    binary_ids[identity] = binary
            known_tests = set().union(*({i for i, meta in inventory((record_dir / f"listing-{n}.json").read_text())[0].items()
                                        if meta["active"] and not meta["skipped"]} for n in range(1, len(selections) + 1)))
            # Shared credit applies only to this invocation's active selection.
            resumed &= known_tests
            run_record["resumed_tests"] = sorted(resumed)
            save_receipt()
            configs = []
            for index, _ in enumerate(selections, start=1):
                if plans:
                    config = record_dir / f"nextest-{index}.toml"
                    write_tool_config(
                        config, store_dir, profile, resumed, f"junit-{index}.xml"
                    )
                else:
                    config = record_dir / "nextest.toml"
                    write_tool_config(config, store_dir, profile, resumed)
                configs.append(config)

            if not resumed and not plans:
                # Truncating the shared journal discards the passes every marker on
                # this tree rests on; drop them first so an interrupted full run
                # cannot leave a marker with no evidence behind it.
                invalidate_completion_markers(run_dir)
                record.write_text("", encoding="utf-8")

            if args.resume == "1" and args.force == "1":
                print(f"[{label}] GATE_FORCE=1: running {scope}", flush=True)
            elif args.resume == "1" and not resumed:
                print(
                    f"[{label}] no passed-test record for this tree; running {scope}",
                    flush=True,
                )

            status: int | None = None
            first_failure: int | None = None
            descriptor = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                for index, (selection, config) in enumerate(zip(selections, configs), start=1):
                    command = [
                        "cargo", "nextest", "run", *selection,
                        "--build-jobs", args.build_jobs,
                        "--test-threads", args.test_threads,
                        "--tool-config-file", f"intent-gate:{config}",
                        "--profile", profile,
                        "--message-format", "libtest-json-plus",
                        "--message-format-version", "0.1",
                        *cargo_config, *output_args,
                    ]
                    if no_fail_fast:
                        command.append("--no-fail-fast")
                    if resumed:
                        command.extend(["--no-tests", "pass"])
                    outcomes: dict[str, str] = {}
                    suite_ignored: dict[str, int] = {}
                    result: dict[str, object] = {
                        "plan": " ".join(selection), "selection_index": index,
                        "command": command, "config": config.name,
                        "junit": f"junit-{index}.xml" if plans else "junit.xml",
                        "events": f"events-{index}.jsonl", "started_at": utc_now(),
                        "finished_at": None, "exit_code": None, "native_exit_code": None,
                        "passed": 0, "failed": 0, "ignored": 0,
                    }
                    results.append(result)
                    status = None
                    save_receipt()
                    try:
                        with (record_dir / result["events"]).open("x", encoding="utf-8") as events:
                            status = stream_nextest(
                                command, intentd_dir, env, binary_ids, descriptor, outcomes,
                                suite_ignored, run_dir, events, result
                            )
                    finally:
                        result.update(tally(outcomes, suite_ignored), exit_code=status)
                        save_receipt()
                    if status != 0:
                        if not no_fail_fast:
                            break
                        if first_failure is None:
                            first_failure = status
            finally:
                os.close(descriptor)
            if first_failure is not None:
                status = first_failure
    except subprocess.CalledProcessError as error:
        print(f"[{label}] ERROR: {error}", file=sys.stderr, flush=True)
        exit_code = failure_exit_code(error)
        finalize(exit_code)
        return exit_code
    except (KeyboardInterrupt, Terminated) as error:
        print(f"[{label}] ERROR: interrupted: {error}", file=sys.stderr, flush=True)
        exit_code = failure_exit_code(error)
        finalize(exit_code)
        return exit_code
    except BaseException as error:
        finalize(failure_exit_code(error))
        raise
    assert status is not None
    return finalize(status)


def main() -> int:
    if sys.argv[1:2] == ["--check-callback-fixture"]:
        parser = argparse.ArgumentParser()
        parser.add_argument("--check-callback-fixture", type=Path, required=True)
        args = parser.parse_args()
        try:
            callback_fixture_identity(args.check_callback_fixture.resolve())
            return 0
        except RuntimeError as error:
            print(f"[gate] ERROR: {error}", file=sys.stderr)
            return HANDLED_ERROR_EXIT
    if sys.argv[1:2] == ["--check-transfer-fixture"]:
        try:
            if len(sys.argv) != 3:
                raise RuntimeError("usage: --check-transfer-fixture REPO_ROOT")
            transfer_fixture_identity(Path(sys.argv[2]).resolve())
            return 0
        except (OSError, RuntimeError, ValueError) as error:
            print(f"[gate] ERROR: {error}", file=sys.stderr)
            return HANDLED_ERROR_EXIT
    if sys.argv[1:2] == ["--compact-cargo"]:
        try:
            command = sys.argv[2:]
            index = command.index("--") if "--" in command else len(command)
            command[index:index] = compact_config(Path.cwd())
            announce_compact()
            os.execvpe("cargo", command, compact_env())
        except (OSError, RuntimeError, ValueError) as error:
            print(f"[compact] ERROR: {error}", file=sys.stderr)
            return HANDLED_ERROR_EXIT
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--intentd-dir", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--resume", choices=("0", "1"), default="0")
    parser.add_argument("--force", choices=("0", "1"), default="0")
    parser.add_argument(
        "--no-fail-fast",
        choices=("0", "1"),
        default="0",
        help="1 forwards --no-fail-fast to cargo nextest run and keeps running the "
        "remaining --plan selections after one fails (default: %(default)s)",
    )
    parser.add_argument("--build-jobs", required=True)
    parser.add_argument("--test-threads", required=True)
    parser.add_argument(
        "--label", default=DEFAULT_LABEL, help="log prefix (default: %(default)s)"
    )
    parser.add_argument(
        "--plan",
        action="append",
        metavar="ARGS",
        help="nextest target selection, e.g. '-p alpha --test one'; repeatable, "
        "run in order instead of --workspace",
    )
    parser.add_argument("--base", metavar="REF", help="base ref recorded in run.json")
    args = parser.parse_args()
    try:
        return run_nextest(args)
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"[{args.label}] ERROR: {error}", file=sys.stderr)
        return HANDLED_ERROR_EXIT


if __name__ == "__main__":
    raise SystemExit(main())
