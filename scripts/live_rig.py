#!/usr/bin/env python3
"""Throwaway intentd rig for live cloud and relay checks.

`make live-rig` (a long-running service) starts an isolated intentd on its own
data folder (UDS only, no TCP listener, no tunnel), optionally a temporary
relay (a fake that only answers relay checks, or a real derper) with its DERP
map, and copies chosen provider profiles and cloud entries from the host
daemon. `make live-rig-down` removes the cloud entries (stopping their
agents), waits until each provider lists no sandbox of the rig, stops every
rig process, deletes the rig folder with the copied secrets, and checks that
the host daemon's config is unchanged.

Secret values are read from the host secrets file in this process and sent
only over the rig daemon's socket. They never go into argv, logs, the state
file or output; everything this script prints passes a redactor.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = Path(__file__).resolve().parents[1]
STATE_DIR = REPO / ".dev" / "live-rig"
STATE = STATE_DIR / "state.json"
CACHE = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "intent-live-rig"
DERPER_VERSION = "v1.104.7"
RELAY_REGION = 900
DAEMON_ID_KEY = "executor.daemonId"
# Fields of a host cloud entry that describe its saved configuration; the
# others (state, checkedAt, sizes, template) change on every provider check.
ENTRY_FIELDS = (
    "id", "provider", "name", "size", "idlePauseMinutes", "pausedDeleteDays",
    "configuredAt", "templateProject", "northflank", "agent37", "vercel",
)
# Provider-only settings `cloudMachines.configure` accepts, per provider.
PROVIDER_SETTINGS = {
    "e2b": (),
    "northflank": ("projectId", "plans", "image", "diskGiB"),
    "agent37": ("instanceType", "region", "diskGiB"),
    "vercel": ("teamId", "projectId", "image"),
}
API = {
    "e2b": "https://api.e2b.app",
    "northflank": "https://api.northflank.com/v1",
    "agent37": "https://api.agent37.com/v1",
    "vercel": "https://api.vercel.com",
}


class RigError(Exception):
    pass


class Redactor:
    """Prints `[live-rig]` lines with every registered secret replaced."""

    def __init__(self) -> None:
        self.secrets: set[str] = set()

    def add(self, value: str | None) -> None:
        if value and len(value) >= 4:
            self.secrets.add(value)

    def scrub(self, text: str) -> str:
        for secret in sorted(self.secrets, key=len, reverse=True):
            text = text.replace(secret, "***")
        return text

    def say(self, message: str, *, err: bool = False) -> None:
        stream = sys.stderr if err else sys.stdout
        print(f"[live-rig] {self.scrub(message)}", file=stream, flush=True)


OUT = Redactor()


# ---------------------------------------------------------------- pure helpers


def select(items: list[dict], wanted: str, kind: str) -> list[dict]:
    """Pick items by id or case-insensitive name from a comma list."""
    picked: list[dict] = []
    for choice in (c.strip() for c in wanted.split(",")):
        if not choice:
            continue
        matches = [i for i in items if i.get("id") == choice]
        if not matches:
            matches = [i for i in items if str(i.get("name", "")).lower() == choice.lower()]
        if len(matches) > 1:
            raise RigError(f"{kind} {choice!r} names {len(matches)} items; use its id")
        if not matches:
            known = ", ".join(f"{i.get('name')} ({i.get('id')})" for i in items) or "none"
            raise RigError(f"no host {kind} {choice!r}; the host has: {known}")
        if matches[0] not in picked:
            picked.append(matches[0])
    return picked


def env_writes(doc: str | None) -> list[dict]:
    """A stored profile env document as `EnvEntryWrite` entries."""
    if not doc:
        return []
    try:
        entries = json.loads(doc).get("entries", [])
    except (ValueError, AttributeError):
        raise RigError("the host profile env is not readable JSON") from None
    writes = []
    for entry in entries:
        kind, key = entry.get("kind"), entry.get("key")
        if kind == "set" and isinstance(entry.get("value"), str):
            writes.append({"key": key, "kind": "set", "value": entry["value"]})
        elif kind == "unset":
            writes.append({"key": key, "kind": "unset"})
        else:
            raise RigError(f"the host profile env has an entry of kind {kind!r} for {key!r}")
    return writes


def env_summary(writes: list[dict]) -> str:
    return ", ".join(f"{w['key']}={w['kind']}" for w in writes) or "no env"


def configure_params(entry: dict, api_key: str, overrides: dict) -> dict:
    """`cloudMachines.configure` params that create a copy of a host entry."""
    provider = entry["provider"]
    if provider not in PROVIDER_SETTINGS:
        raise RigError(f"cloud provider {provider!r} is not known to the rig")
    params = {"provider": provider, "name": entry["name"], "apiKey": api_key}
    for field in ("size", "idlePauseMinutes", "pausedDeleteDays", "templateProject"):
        if field in entry:
            params[field] = entry[field]
    settings = entry.get(provider) or {}
    for field in PROVIDER_SETTINGS[provider]:
        if field in settings:
            params[field] = settings[field]
    params.update({k: v for k, v in overrides.items() if v is not None})
    return params


def redacted(params: dict) -> dict:
    return {k: ("***" if k == "apiKey" else v) for k, v in params.items()}


def digest(value: object) -> str:
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest()


def entries_fingerprint(providers: list[dict]) -> str:
    return digest([{k: p[k] for k in ENTRY_FIELDS if k in p} for p in providers])


def profiles_fingerprint(profiles: list[dict]) -> str:
    keep = ("id", "name", "baseProviderId", "backup", "settingsFingerprint")
    return digest([{k: p.get(k) for k in keep} for p in profiles])


def changed_parts(before: dict, after: dict) -> list[str]:
    return [part for part in before if before[part] != after.get(part)]


def cert_name(pem: str) -> str:
    body = "".join(
        line for line in pem.splitlines() if line and not line.startswith("-----")
    )
    return "sha256-raw:" + hashlib.sha256(base64.b64decode(body)).hexdigest()


def derp_map(host: str, port: int, cert: str | None) -> dict:
    node = {"Name": f"{RELAY_REGION}a", "RegionID": RELAY_REGION, "HostName": host,
            "DERPPort": port, "STUNPort": -1}
    if all(part.isdigit() for part in host.split(".")) and host.count(".") == 3:
        node["IPv4"] = host
    if cert:
        node["CertName"] = cert
    else:
        node["InsecureForTests"] = True
    return {"Regions": {str(RELAY_REGION): {
        "RegionID": RELAY_REGION, "RegionCode": "rig", "RegionName": "Live rig relay",
        "Nodes": [node],
    }}}


def northflank_backend_tag(backend_id: str) -> str:
    return "intent-backend-" + hashlib.sha256(backend_id.encode()).hexdigest()[:12]


def leftovers(provider: str, items: list[dict], backend_id: str) -> list[str]:
    """Ids of listed sandboxes (services, instances) that belong to `backend_id`."""
    if provider == "e2b":
        return [i["sandboxID"] for i in items if (i.get("metadata") or {}).get("intentBackendId") == backend_id]
    if provider == "vercel":
        return [i["name"] for i in items if (i.get("tags") or {}).get("intentBackendId") == backend_id]
    if provider == "northflank":
        tag = northflank_backend_tag(backend_id)
        return [i["id"] for i in items if tag in (i.get("tags") or [])]
    if provider == "agent37":
        return [
            i["id"] for i in items
            if (i.get("metadata") or {}).get("intentBackendId") == backend_id and i.get("status") != "deleted"
        ]
    raise RigError(f"cloud provider {provider!r} is not known to the rig")


def guard_no_rig(state_path: Path) -> None:
    if state_path.exists():
        raise RigError(
            f"a rig is already recorded in {state_path}; run 'make live-rig-down' first "
            "(its folder may still hold copied secrets)"
        )


def rig_env(rig_dir: Path, base: dict) -> dict:
    env = {k: v for k, v in base.items() if not k.startswith("INTENTD_")}
    data = rig_dir / "data"
    env.update({
        "INTENTD_DATA_DIR": str(data),
        "INTENTD_SECRETS_FILE": str(data / "secrets.json"),
        "INTENTD_WORKSPACES_DIR": str(data / "workspaces"),
        "INTENTD_USER_SPECIALISTS_DIR": str(data / "specialists"),
        "INTENTD_LEGACY_IMPORT_ROOTS": "",
    })
    return env


def rig_config(derp_url: str | None) -> str:
    lines = [
        "# Written by scripts/live_rig.py: UDS only, no TCP listener, no tunnel.",
        "[server]",
        'bindAddress = "127.0.0.1"',
        "",
        "[server.wsApi]",
        "enabled = false",
        "",
        "[server.tunnel]",
        "enabled = false",
    ]
    if derp_url:
        lines.append(f"derpUrl = {json.dumps(derp_url)}")
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------ host side


def host_data_dir() -> Path:
    if os.environ.get("HOST_INTENTD_DATA_DIR"):
        return Path(os.environ["HOST_INTENTD_DATA_DIR"])
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/intentd"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "intentd"


def host_socket() -> Path:
    return Path(os.environ.get("HOST_INTENTD_SOCKET") or host_data_dir() / "intentd.sock")


def host_secrets_path() -> Path:
    return Path(os.environ.get("HOST_INTENTD_SECRETS_FILE") or Path.home() / "intent" / ".secrets.json")


def read_secrets(path: Path, accounts: list[str]) -> dict[str, str | None]:
    """Selected accounts from a secrets file; values are registered for redaction."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError):
        raise RigError(f"cannot read the secrets file {path}") from None
    found = {}
    for account in accounts:
        value = data.get(account) or None
        OUT.add(value)
        if value and account.endswith(".env"):
            try:
                for entry in json.loads(value).get("entries", []):
                    OUT.add(entry.get("value"))
            except (ValueError, AttributeError):
                pass
        found[account] = value
    return found


def host_fingerprint(rpc: "Rpc") -> dict:
    config = host_data_dir() / "config.toml"
    listed = rpc.call("cloudMachines.list")
    profiles = rpc.call("providers.profiles.list")
    return {
        "config": digest(config.read_bytes()) if config.exists() else "absent",
        "entries": entries_fingerprint(listed.get("providers", [])),
        "profiles": profiles_fingerprint(profiles.get("profiles", [])),
    }


# ------------------------------------------------------------------------ RPC


class Rpc:
    """Newline-delimited JSON-RPC over an intentd UDS socket."""

    def __init__(self, path: Path, timeout: float = 120) -> None:
        self.path = path
        self.timeout = timeout
        self.next_id = 0

    def call(self, method: str, params: dict | None = None, timeout: float | None = None) -> dict:
        self.next_id += 1
        request = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(timeout or self.timeout)
            try:
                sock.connect(str(self.path))
            except OSError as error:
                raise RigError(f"{method}: cannot reach {self.path} ({error.strerror})") from None
            stream = sock.makefile("rwb")
            stream.write((json.dumps(request) + "\n").encode())
            stream.flush()
            while True:
                try:
                    line = stream.readline()
                except socket.timeout:
                    raise RigError(f"{method}: no answer within {timeout or self.timeout:.0f}s") from None
                if not line:
                    raise RigError(f"{method}: the daemon closed the connection")
                reply = json.loads(line)
                if reply.get("id") != self.next_id:
                    continue
                if "error" in reply:
                    error = reply["error"]
                    code = (error.get("data") or {}).get("code") if isinstance(error.get("data"), dict) else None
                    raise RigError(OUT.scrub(f"{method}: {error.get('message')}" + (f" ({code})" if code else "")))
                return reply.get("result") or {}

    def accepts(self) -> bool:
        try:
            with socket.socket(socket.AF_UNIX) as sock:
                sock.settimeout(0.5)
                sock.connect(str(self.path))
            return True
        except OSError:
            return False


# ---------------------------------------------------------------------- state


def load_state() -> dict | None:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    tmp.replace(STATE)


def alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        status = Path(f"/proc/{pid}/stat").read_text().split()[2]
        return status != "Z"
    except (OSError, IndexError):
        return True


def stop_group(pid: int | None, grace: float = 20) -> bool:
    """SIGTERM a process group, then SIGKILL after `grace`; True once it is gone."""
    if not alive(pid):
        return True
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 5)):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            return True
        except PermissionError:
            os.kill(pid, sig)
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            if not alive(pid):
                return True
            time.sleep(0.2)
    return not alive(pid)


def daemon_id(rig_dir: Path) -> str | None:
    db = rig_dir / "data" / "intentd.db"
    if not db.exists():
        return None
    try:
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5) as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (DAEMON_ID_KEY,)).fetchone()
    except sqlite3.Error:
        return None
    return json.loads(row[0]) if row else None


# ------------------------------------------------------------------ binaries


def build_intentd(args: argparse.Namespace) -> Path:
    if args.intentd_bin:
        path = Path(args.intentd_bin).resolve()
        if not os.access(path, os.X_OK):
            raise RigError(f"INTENTD_BIN {path} is not an executable file")
        OUT.say(f"using INTENTD_BIN {path} (no build)")
        return path
    source = Path(args.intentd_dir).resolve()
    if not (source / "Cargo.toml").exists():
        raise RigError(f"no intentd checkout at {source} (set RIG_INTENTD_DIR or INTENTD_BIN)")
    profile_dir, flags = ("release", ["--release"]) if args.build_profile == "release" else ("debug", [])
    target = Path(os.environ.get("INTENTD_TARGET_DIR") or source / "target")
    branch = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True, text=True,
    ).stdout.strip()
    OUT.say(f"building intentd from {source} ({branch or 'unknown branch'}, {args.build_profile} profile)")
    built = subprocess.run(
        ["cargo", "build", "-p", "intentd", "--manifest-path", str(source / "Cargo.toml"),
         "--jobs", str(args.build_jobs), *flags],
        env={**os.environ, "CARGO_TARGET_DIR": str(target)},
    )
    if built.returncode != 0:
        raise RigError(f"cargo build failed (exit {built.returncode})")
    return target / profile_dir / "intentd"


def find_tailcat(intentd_bin: Path, explicit: str | None) -> Path:
    candidates = [Path(explicit)] if explicit else []
    candidates += [intentd_bin.parent / "libexec" / "tailcat", intentd_bin.parent / "tailcat"]
    versions = host_data_dir() / "sitter" / "versions"
    if versions.is_dir():
        installed = sorted(
            (v for v in versions.iterdir() if all(x.isdigit() for x in v.name.split("."))),
            key=lambda v: [int(x) for x in v.name.split(".")],
        )
        candidates += [v / "libexec" / "tailcat" for v in reversed(installed)]
    candidates.append(Path("/Applications/Intent.app/Contents/Resources/tailcat/tailcat"))
    on_path = shutil.which("tailcat")
    if on_path:
        candidates.append(Path(on_path))
    for candidate in candidates:
        if os.access(candidate, os.X_OK):
            return candidate
    raise RigError("no tailcat binary found; set TAILCAT_BIN (an installed intentd ships one in libexec/)")


def go_toolchain() -> Path:
    found = shutil.which("go")
    if found:
        return Path(found)
    cached = sorted(CACHE.glob("go*/go/bin/go"))
    if cached:
        return cached[-1]
    osname = {"linux": "linux", "darwin": "darwin"}.get(sys.platform)
    arch = {"x86_64": "amd64", "amd64": "amd64", "arm64": "arm64", "aarch64": "arm64"}.get(os.uname().machine)
    if not osname or not arch:
        raise RigError("no Go toolchain and no download for this platform; set DERPER_BIN")
    with urllib.request.urlopen("https://go.dev/dl/?mode=json", timeout=30) as reply:
        releases = json.load(reply)
    release = next(r for r in releases if r.get("stable"))
    file = next(f for f in release["files"] if f["os"] == osname and f["arch"] == arch and f["kind"] == "archive")
    dest = CACHE / release["version"]
    dest.mkdir(parents=True, exist_ok=True)
    archive = dest / file["filename"]
    OUT.say(f"downloading {release['version']} to {dest} (needed once to build derper)")
    urllib.request.urlretrieve(f"https://go.dev/dl/{file['filename']}", archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != file["sha256"]:
        archive.unlink()
        raise RigError("the Go download does not match its published sha256")
    with tarfile.open(archive) as tar:
        tar.extractall(dest, filter="data")
    archive.unlink()
    return dest / "go" / "bin" / "go"


def derper_bin(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    built = CACHE / f"derper-{DERPER_VERSION}" / "derper"
    if os.access(built, os.X_OK):
        return built
    go = go_toolchain()
    OUT.say(f"building derper {DERPER_VERSION} into {built.parent} (cached for later rigs)")
    env = {**os.environ, "GOBIN": str(built.parent), "GOPATH": str(CACHE / "gopath"),
           "CGO_ENABLED": "0", "PATH": f"{go.parent}:{os.environ.get('PATH', '')}"}
    done = subprocess.run([str(go), "install", f"tailscale.com/cmd/derper@{DERPER_VERSION}"], env=env)
    if done.returncode != 0 or not os.access(built, os.X_OK):
        raise RigError("building derper failed; set DERPER_BIN to a derper binary")
    return built


# --------------------------------------------------------------------- relay


class Answer(http.server.BaseHTTPRequestHandler):
    body = b"{}"

    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *_args) -> None:
        pass


def serve(bind: str, port: int, body: bytes) -> http.server.ThreadingHTTPServer:
    handler = type("Handler", (Answer,), {"body": body})
    server = http.server.ThreadingHTTPServer((bind, port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Relay:
    """A relay node (fake HTTP answerer or derper) and its DERP map server."""

    def __init__(self, args: argparse.Namespace, rig_dir: Path) -> None:
        self.kind = args.relay
        self.host = args.relay_host or ("127.0.0.1" if self.kind == "fake" else "")
        if not self.host:
            raise RigError("RELAY=derper needs RELAY_HOST: the public IP or name sandboxes can reach")
        self.port = args.relay_port
        self.map_port = args.relay_map_port
        self.dir = rig_dir / "relay"
        self.dir.mkdir(mode=0o700)
        self.node: http.server.ThreadingHTTPServer | None = None
        self.process: subprocess.Popen | None = None
        self.cert: str | None = None
        self.derper = derper_bin(args.derper_bin) if self.kind == "derper" else None
        if self.kind == "derper":
            self.cert = self.make_cert()
        else:
            self.up()
        bind = self.host if self.kind == "fake" else "0.0.0.0"
        self.map = serve(bind, self.map_port, json.dumps(derp_map(self.host, self.port, self.cert)).encode())
        self.map_port = self.map.server_address[1]
        self.url = f"http://{self.host}:{self.map_port}/derpmap.json"

    def make_cert(self) -> str:
        crt, key = self.dir / f"{self.host}.crt", self.dir / f"{self.host}.key"
        san = f"IP:{self.host}" if self.host.replace(".", "").isdigit() else f"DNS:{self.host}"
        made = subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
             "-nodes", "-days", "7", "-subj", f"/CN={self.host}", "-addext", f"subjectAltName={san}",
             "-keyout", str(key), "-out", str(crt)],
            capture_output=True, text=True,
        )
        if made.returncode != 0:
            raise RigError(f"openssl could not make the relay certificate: {made.stderr.strip()}")
        return cert_name(crt.read_text())

    def up(self) -> int | None:
        if self.kind == "fake":
            if self.node is None:
                self.node = serve(self.host, self.port, b"")
                self.port = self.node.server_address[1]
            return None
        if self.process is None or self.process.poll() is not None:
            log = open(self.dir / "derper.log", "ab")
            self.process = subprocess.Popen(
                [str(self.derper), "-c", str(self.dir / "derper.json"), "-hostname", self.host,
                 "-certmode", "manual", "-certdir", str(self.dir),
                 "-a", f":{self.port}", "-http-port", "-1", "-stun=false"],
                stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True,
            )
            time.sleep(2)
            if self.process.poll() is not None:
                tail = (self.dir / "derper.log").read_text(errors="replace").strip().splitlines()[-3:]
                raise RigError(f"derper exited with status {self.process.returncode}: {' | '.join(tail)}")
        return self.process.pid

    def down(self) -> None:
        if self.node is not None:
            self.node.shutdown()
            self.node.server_close()
            self.node = None
        if self.process is not None:
            stop_group(self.process.pid, grace=5)
            self.process = None

    def close(self) -> None:
        self.down()
        self.map.shutdown()
        self.map.server_close()


# -------------------------------------------------------------------- daemon


def start_daemon(intentd: Path, env: dict, rig_dir: Path, orchestrator: bool) -> subprocess.Popen:
    log = open(rig_dir / "intentd.log", "ab")
    argv = [str(intentd), "serve"] + (["--orchestrator"] if orchestrator else [])
    return subprocess.Popen(argv, env=env, cwd=rig_dir, stdout=log, stderr=log,
                            stdin=subprocess.DEVNULL, start_new_session=True)


def wait_ready(rpc: Rpc, process: subprocess.Popen | None, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RigError(f"intentd exited with status {process.returncode}; see its log in the rig folder")
        if rpc.accepts():
            try:
                return rpc.call("system.status", timeout=10)
            except RigError:
                pass
        time.sleep(0.5)
    raise RigError(f"intentd was not ready within {timeout:.0f}s")


def stop_daemon(intentd: Path, env: dict, pid: int | None) -> bool:
    if alive(pid):
        subprocess.run([str(intentd), "stop"], env=env, capture_output=True, timeout=60)
    return stop_group(pid)


# -------------------------------------------------------------------- copying


def copy_profiles(host: Rpc, rig: Rpc, wanted: str) -> list[dict]:
    listed = host.call("providers.profiles.list")
    picked = select(listed.get("profiles", []), wanted, "profile")
    remote = {}
    remote_path = host_data_dir() / "provider-remote-compatible.json"
    if remote_path.exists():
        remote = json.loads(remote_path.read_text()).get("profiles", {})
    accounts = [f"providerProfiles.{p['id']}.env" for p in picked]
    secrets = read_secrets(host_secrets_path(), accounts)
    copied = []
    for profile in picked:
        writes = env_writes(secrets[f"providerProfiles.{profile['id']}.env"])
        made = rig.call("providers.profiles.create", {
            "baseProviderId": profile["baseProviderId"], "name": profile["name"], "env": writes,
            "remoteCompatible": remote.get(profile["id"], True),
        })["profile"]
        OUT.say(f"profile {profile['name']} ({profile['id']}) -> rig {made['providerRef']} [{env_summary(writes)}]")
        copied.append({"hostId": profile["id"], "name": profile["name"], "providerRef": made["providerRef"]})
    return copied


def copy_entries(host: Rpc, rig: Rpc, wanted: str, overrides: dict) -> list[dict]:
    entries = host.call("cloudMachines.list").get("providers", [])
    picked = select(entries, wanted, "cloud entry")
    accounts = [f"cloudMachines.{e['id']}.apiKey" for e in picked]
    secrets = read_secrets(host_secrets_path(), accounts)
    copied = []
    for entry in picked:
        key = secrets[f"cloudMachines.{entry['id']}.apiKey"]
        if not key:
            raise RigError(f"the host has no saved key for cloud entry {entry['id']}")
        params = configure_params(entry, key, overrides)
        made = rig.call("cloudMachines.configure", params, timeout=180)["provider"]
        OUT.say(f"cloud entry {entry['name']} ({entry['id']}) -> rig {made['id']} "
                f"[{made['state']}, {made.get('template')}, size {made.get('size')}]")
        copied.append({"hostId": entry["id"], "rigId": made["id"], "provider": entry["provider"],
                       "name": entry["name"], "settings": entry.get(entry["provider"]) or {}})
    return copied


# ------------------------------------------------------------------------ up


def cmd_up(args: argparse.Namespace) -> int:
    guard_no_rig(STATE)
    host = Rpc(host_socket(), timeout=60)
    baseline = host_fingerprint(host)
    intentd = build_intentd(args)
    tailcat = find_tailcat(intentd, args.tailcat_bin)
    root = Path(args.rig_root or os.environ.get("TMPDIR") or "/tmp")
    rig_dir = Path(tempfile.mkdtemp(prefix="intent-live-rig.", dir=root))
    if len(str(rig_dir / "data" / "intentd.sock")) > 100:
        shutil.rmtree(rig_dir)
        rig_dir = Path(tempfile.mkdtemp(prefix="intent-live-rig.", dir="/tmp"))
    os.chmod(rig_dir, 0o700)
    (rig_dir / "data").mkdir(mode=0o700)
    env = rig_env(rig_dir, os.environ)
    env["INTENTD_TAILCAT_BIN"] = str(tailcat)
    state = {
        "rigDir": str(rig_dir), "intentdBin": str(intentd), "tailcatBin": str(tailcat),
        "supervisorPid": os.getpid(), "orchestrator": args.orchestrator, "hostBaseline": baseline,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "entries": [], "profiles": [],
    }
    save_state(state)
    relay = daemon = None
    stop = threading.Event()
    toggle = threading.Event()
    park = threading.Event()

    def on_stop(*_args) -> None:
        stop.set()
        if not state.get("ready"):
            raise RigError("stopped before the rig was ready")

    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGINT, on_stop)
    signal.signal(signal.SIGUSR1, lambda *_: toggle.set())
    signal.signal(signal.SIGUSR2, lambda *_: park.set())
    try:
        if args.relay:
            relay = Relay(args, rig_dir)
            state["relay"] = {"kind": relay.kind, "mapUrl": relay.url, "pid": relay.up(), "up": True,
                              "node": f"{relay.host}:{relay.port}"}
            OUT.say(f"relay ({relay.kind}) node {relay.host}:{relay.port}, map {relay.url}")
        (rig_dir / "data" / "config.toml").write_text(rig_config(relay.url if relay else None))
        daemon = start_daemon(intentd, env, rig_dir, args.orchestrator)
        state["daemonPid"] = daemon.pid
        save_state(state)
        rpc = Rpc(rig_dir / "data" / "intentd.sock")
        status = wait_ready(rpc, daemon, args.ready_timeout)
        state["version"] = status.get("version")
        overrides = {"size": args.size or None,
                     "idlePauseMinutes": int(args.idle_pause) if args.idle_pause else None}
        state["profiles"] = copy_profiles(host, rpc, args.profiles)
        save_state(state)
        state["entries"] = copy_entries(host, rpc, args.cloud, overrides)
        state["ready"] = True
        save_state(state)
        OUT.say(f"ready: intentd {state['version']} in {rig_dir} (state {STATE.relative_to(REPO)})")
        OUT.say("drive it with: make live-rig-call METHOD=<method> PARAMS='<json>'; remove it with: make live-rig-down")
        while not stop.is_set():
            if park.is_set() and daemon is not None:
                # live-rig-down removes the rig; exiting would let a service
                # manager restart this command and copy the secrets again.
                if relay is not None:
                    relay.close()
                    relay = None
                stop_daemon(intentd, env, daemon.pid)
                daemon = None
                current = load_state() or state
                current.update({"parked": True, "daemonPid": None, "ready": False})
                if current.get("relay"):
                    current["relay"].update({"pid": None, "up": False})
                save_state(current)
                OUT.say("the rig was removed by make live-rig-down; stop this service")
            if daemon is None:
                stop.wait(1)
                continue
            if toggle.is_set() and relay:
                toggle.clear()
                current = load_state() or state
                want = current.get("relay", {}).get("want", "up")
                if want == "down":
                    relay.down()
                else:
                    current["relay"]["pid"] = relay.up()
                current["relay"]["up"] = want != "down"
                save_state(current)
                OUT.say(f"relay is {want}")
            if daemon.poll() is not None:
                OUT.say(f"intentd exited with status {daemon.returncode}; run 'make live-rig-down' to clean up", err=True)
                return 1
            stop.wait(1)
        OUT.say("stopping; the rig folder and its copied secrets stay until 'make live-rig-down'")
        return 0
    except RigError as error:
        OUT.say(f"ERROR: {error}", err=True)
        OUT.say("run 'make live-rig-down' to remove what was started", err=True)
        return 1
    finally:
        if daemon is not None:
            stop_daemon(intentd, env, daemon.pid)
        if relay is not None:
            relay.close()
        current = load_state()
        if current and not current.get("parked"):
            current.update({"supervisorPid": None, "ready": False})
            save_state(current)


# ---------------------------------------------------------------------- down


def provider_items(provider: str, key: str, settings: dict, backend: str) -> list[dict]:
    def get(url: str, headers: dict) -> dict | list:
        request = urllib.request.Request(url, headers={**headers, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as reply:
                return json.load(reply)
        except urllib.error.HTTPError as error:
            raise RigError(f"{provider} list failed: HTTP {error.code}") from None
        except urllib.error.URLError as error:
            raise RigError(f"{provider} list failed: {error.reason}") from None

    bearer = {"Authorization": f"Bearer {key}"}
    if provider == "e2b":
        query = urllib.parse.urlencode({"metadata": f"intentBackendId={backend}", "state": "running,paused", "limit": 100})
        return get(f"{API['e2b']}/v2/sandboxes?{query}", {"X-API-Key": key})
    if provider == "vercel":
        query = urllib.parse.urlencode({"project": settings.get("projectId", ""), "teamId": settings.get("teamId", ""),
                                        "tags": f"intentBackendId:{backend}", "limit": 100})
        return get(f"{API['vercel']}/v2/sandboxes?{query}", bearer).get("sandboxes", [])
    if provider == "northflank":
        project = urllib.parse.quote(settings.get("projectId", ""))
        items = []
        for kind in ("services", "volumes"):
            items += get(f"{API['northflank']}/projects/{project}/{kind}?per_page=100", bearer).get("data", {}).get(kind, [])
        return items
    if provider == "agent37":
        return get(f"{API['agent37']}/instances", bearer).get("data", [])
    raise RigError(f"cloud provider {provider!r} is not known to the rig")


def wait_no_sandboxes(entries: list[dict], backend: str | None, timeout: float) -> dict[str, list[str]]:
    if not entries:
        return {}
    if backend is None:
        OUT.say("the rig daemon never minted a backend id, so it never started a sandbox")
        return {e["rigId"]: [] for e in entries}
    keys = read_secrets(host_secrets_path(), [f"cloudMachines.{e['hostId']}.apiKey" for e in entries])
    deadline = time.monotonic() + timeout
    while True:
        found, failed = {}, []
        for entry in entries:
            key = keys.get(f"cloudMachines.{entry['hostId']}.apiKey")
            if not key:
                failed.append(f"{entry['hostId']}: the host key is gone, cannot list")
                continue
            try:
                items = provider_items(entry["provider"], key, entry.get("settings") or {}, backend)
                found[entry["rigId"]] = leftovers(entry["provider"], items, backend)
            except RigError as error:
                failed.append(str(error))
        if failed:
            raise RigError("; ".join(failed))
        if not any(found.values()) or time.monotonic() >= deadline:
            return found
        time.sleep(10)


def cmd_down(args: argparse.Namespace) -> int:
    state = load_state()
    if state is None:
        OUT.say("no rig is recorded; nothing to remove")
        return 0
    rig_dir = Path(state["rigDir"])
    intentd = Path(state["intentdBin"])
    env = rig_env(rig_dir, os.environ)
    env["INTENTD_TAILCAT_BIN"] = state.get("tailcatBin", "")
    rpc = Rpc(rig_dir / "data" / "intentd.sock")
    report: list[tuple[str, bool, str]] = []
    temp = None
    removal_ok = True
    if state.get("entries"):
        if not rpc.accepts() and rig_dir.exists() and os.access(intentd, os.X_OK):
            OUT.say("the rig daemon is not running; starting it to remove its cloud entries")
            temp = start_daemon(intentd, env, rig_dir, state.get("orchestrator", False))
            state["daemonPid"] = temp.pid
            save_state(state)
        try:
            wait_ready(rpc, temp, args.ready_timeout)
            listed = rpc.call("cloudMachines.list")
            machines = [m.get("cloud", {}).get("sandboxId") for m in listed.get("machines", [])]
            unconfirmed = []
            for entry in state["entries"]:
                done = rpc.call("cloudMachines.remove", {"cloudMachineId": entry["rigId"], "stopAgents": True}, timeout=240)
                unconfirmed += done.get("unconfirmedStops", [])
            report.append(("cloud entries removed with stopAgents", True,
                           f"{len(state['entries'])} entries, {len(machines)} live machines, unconfirmed stops {unconfirmed or 'none'}"))
        except RigError as error:
            removal_ok = False
            report.append(("cloud entries removed with stopAgents", False, str(error)))
    backend = daemon_id(rig_dir) or state.get("backendId")
    if backend:
        state["backendId"] = backend
        save_state(state)
    sandboxes_ok = True
    try:
        found = wait_no_sandboxes(state.get("entries", []), backend, args.sandbox_timeout)
        left = {k: v for k, v in found.items() if v}
        sandboxes_ok = not left
        detail = ", ".join(f"{k}: {len(v)}" for k, v in found.items()) or "no cloud entries"
        report.append(("providers list no rig sandboxes", sandboxes_ok,
                       detail + (f"; left: {left}" if left else "")))
    except RigError as error:
        sandboxes_ok = False
        report.append(("providers list no rig sandboxes", False, str(error)))

    supervisor = state.get("supervisorPid")
    parked = not alive(supervisor)
    if not parked:
        # Park, not stop: a service manager restarts a supervisor that exits.
        os.kill(supervisor, signal.SIGUSR2)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and alive(supervisor):
            if (load_state() or {}).get("parked"):
                parked = True
                break
            time.sleep(0.5)
        parked = parked or not alive(supervisor)
    state = load_state() or state
    daemon_gone = stop_daemon(intentd, env, state.get("daemonPid"))
    relay_gone = stop_group((state.get("relay") or {}).get("pid"))
    supervisor_note = "gone" if not alive(supervisor) else "parked (stop its service)" if parked else "ALIVE"
    report.append(("rig processes stopped", daemon_gone and relay_gone and parked,
                   f"intentd {'gone' if daemon_gone else 'ALIVE'}, relay {'gone' if relay_gone else 'ALIVE'}, "
                   f"supervisor {supervisor_note}"))

    keep = not (sandboxes_ok and removal_ok) and not args.force
    if keep:
        report.append(("rig folder deleted", False,
                       f"kept {rig_dir}: sandboxes may remain; rerun make live-rig-down, or FORCE=1 to delete anyway"))
    else:
        shutil.rmtree(rig_dir, ignore_errors=True)
        report.append(("rig folder deleted (copied secrets included)", not rig_dir.exists(), str(rig_dir)))

    try:
        after = host_fingerprint(Rpc(host_socket(), timeout=60))
        changed = changed_parts(state["hostBaseline"], after)
        report.append(("host daemon config unchanged", not changed,
                       f"config {after['config'][:12]}, entries {after['entries'][:12]}, profiles {after['profiles'][:12]}"
                       + (f"; changed: {', '.join(changed)}" if changed else "")))
    except RigError as error:
        report.append(("host daemon config unchanged", False, str(error)))

    ok = all(passed for _, passed, _ in report)
    OUT.say("| Claim | Result | Detail |")
    OUT.say("|---|---|---|")
    for claim, passed, detail in report:
        OUT.say(f"| {claim} | {'PASS' if passed else 'FAIL'} | {detail} |")
    evidence = STATE_DIR / f"down-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json"
    evidence.write_text(json.dumps({"ok": ok, "rigDir": str(rig_dir), "backendId": backend,
                                    "checks": [{"claim": c, "pass": p, "detail": d} for c, p, d in report]}, indent=2) + "\n")
    OUT.say(f"evidence: {evidence.relative_to(REPO)}")
    if not keep:
        STATE.unlink(missing_ok=True)
    return 0 if ok else 1


# ------------------------------------------------------------- status, call


def rig_rpc() -> tuple[dict, Rpc]:
    state = load_state()
    if state is None:
        raise RigError("no rig is recorded; start one with make live-rig")
    return state, Rpc(Path(state["rigDir"]) / "data" / "intentd.sock")


def cmd_status(_args: argparse.Namespace) -> int:
    state = load_state()
    if state is None:
        print(json.dumps({"running": False}))
        return 0
    rpc = Rpc(Path(state["rigDir"]) / "data" / "intentd.sock")
    view = {k: v for k, v in state.items() if k != "hostBaseline"}
    view["running"] = rpc.accepts()
    view["supervisorAlive"] = alive(state.get("supervisorPid"))
    if view["running"]:
        try:
            listed = rpc.call("cloudMachines.list", timeout=30)
            view["machines"] = [
                {"id": m.get("id"), "name": m.get("name"), **{k: m.get("cloud", {}).get(k) for k in ("cloudMachineId", "sandboxId", "state", "relayUrl")}}
                for m in listed.get("machines", [])
            ]
        except RigError as error:
            view["machinesError"] = str(error)
    view["backendId"] = daemon_id(Path(state["rigDir"])) or state.get("backendId")
    view["env"] = {"INTENTD_DATA_DIR": str(Path(state["rigDir"]) / "data"), "intentd": state["intentdBin"]}
    print(OUT.scrub(json.dumps(view, indent=2)))
    return 0


def cmd_call(args: argparse.Namespace) -> int:
    _state, rpc = rig_rpc()
    params = json.loads(args.params) if args.params else {}
    print(OUT.scrub(json.dumps(rpc.call(args.method, params, timeout=args.timeout), indent=2)))
    return 0


def cmd_relay(args: argparse.Namespace) -> int:
    state = load_state()
    if not state or not state.get("relay"):
        raise RigError("no rig relay is running (start the rig with RELAY=fake or RELAY=derper)")
    if not alive(state.get("supervisorPid")):
        raise RigError("the rig supervisor is not running")
    state["relay"]["want"] = args.action
    save_state(state)
    os.kill(state["supervisorPid"], signal.SIGUSR1)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if (load_state() or {}).get("relay", {}).get("up") == (args.action == "up"):
            OUT.say(f"relay is {args.action}")
            return 0
        time.sleep(0.3)
    raise RigError(f"the relay did not go {args.action} within 30s")


# --------------------------------------------------------------------- smoke


def conversation_text(rpc: Rpc, agent_id: str, workspace_id: str) -> tuple[list[dict], bool]:
    reply = rpc.call("agent.getConversation", {"agentId": agent_id, "workspaceId": workspace_id, "limit": 20})
    return reply.get("messages", []), bool(reply.get("turnInFlight"))


def cmd_smoke(args: argparse.Namespace) -> int:
    state, rpc = rig_rpc()
    entries = state.get("entries", [])
    entry = select([{"id": e["rigId"], "name": e["name"]} for e in entries], args.cloud_entry or (entries[0]["rigId"] if entries else ""), "rig cloud entry")
    if not entry:
        raise RigError("the rig has no cloud entry; start it with CLOUD=<host entry>")
    profiles = state.get("profiles", [])
    profile = None
    if args.profile or profiles:
        wanted = args.profile or profiles[0]["hostId"]
        profile = next((p for p in profiles if wanted in (p["hostId"], p["name"], p["providerRef"])), None)
        if profile is None:
            raise RigError(f"the rig has no copied profile {wanted!r}")
    rig_dir = Path(state["rigDir"])
    repo = rig_dir / "repo"
    if not repo.exists():
        repo.mkdir()
        git = ["git", "-C", str(repo), "-c", "user.name=live-rig", "-c", "user.email=live-rig@localhost"]
        subprocess.run([*git, "init", "-q", "-b", "main"], check=True)
        (repo / "README.md").write_text("Scratch repository for live rig checks.\n")
        subprocess.run([*git, "add", "README.md"], check=True)
        subprocess.run([*git, "commit", "-q", "-m", "init"], check=True)
    timings: dict[str, float] = {}
    t0 = time.monotonic()
    workspace = rpc.call("workspace.create", {"name": f"live-rig smoke {time.strftime('%H%M%S')}",
                                              "repositoryPath": str(repo), "skipIsolation": True})["workspace"]
    create = {"workspaceId": workspace["id"], "name": "live-rig-smoke",
              "placement": {"target": "cloud", "cloudMachineId": entry[0]["id"]}}
    if profile:
        create["provider"] = profile["providerRef"]
    agent = rpc.call("agent.create", create, timeout=300)["agent"]
    state["backendId"] = daemon_id(rig_dir) or state.get("backendId")
    save_state(state)
    timings["agentCreateSeconds"] = round(time.monotonic() - t0, 1)
    a, b = int(time.time()) % 9000 + 1000, os.getpid() % 9000 + 1000
    expected = str(a + b)
    t1 = time.monotonic()
    rpc.call("agent.sendMessage", {"agentId": agent["id"], "workspaceId": workspace["id"],
                                   "content": f"What is {a} + {b}? Reply with only the number."}, timeout=300)
    deadline = t1 + args.timeout
    answer = None
    while time.monotonic() < deadline:
        messages, _busy = conversation_text(rpc, agent["id"], workspace["id"])
        replies = [m for m in messages if m.get("role") == "assistant" and expected in json.dumps(m.get("contentBlocks") or m.get("content"))]
        if replies:
            answer = replies[-1]
            break
        current = rpc.call("agent.get", {"agentId": agent["id"], "workspaceId": workspace["id"]})["agent"]
        if current.get("status") == "error":
            failure = current.get("placementError") or {}
            OUT.say(f"ERROR: the agent failed: {failure.get('code', 'error')}: {failure.get('detail', '')}", err=True)
            break
        time.sleep(2)
    timings["sendToReplySeconds"] = round(time.monotonic() - t1, 1)
    machines = [m for m in rpc.call("cloudMachines.list").get("machines", []) if m.get("cloud", {}).get("agentId") == agent["id"]]
    cloud = machines[0].get("cloud", {}) if machines else {}
    result = {"ok": answer is not None, "entry": entry[0]["id"], "provider": profile["providerRef"] if profile else None,
              "workspaceId": workspace["id"], "agentId": agent["id"], "expected": expected,
              "sandboxId": cloud.get("sandboxId"), "relayUrl": cloud.get("relayUrl"), **timings}
    evidence = STATE_DIR / f"smoke-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json"
    evidence.write_text(json.dumps(result, indent=2) + "\n")
    OUT.say(json.dumps(result))
    OUT.say(f"evidence: {evidence.relative_to(REPO)}")
    if answer is None:
        OUT.say(f"ERROR: no reply with {expected} within {args.timeout:.0f}s", err=True)
        return 1
    return 0


# ---------------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    up = sub.add_parser("up", help="start the rig and supervise it until stopped")
    up.add_argument("--intentd-bin", default="")
    up.add_argument("--intentd-dir", default=str(REPO / "packages" / "intentd"))
    up.add_argument("--build-profile", choices=("dev", "release"), default="dev")
    up.add_argument("--build-jobs", default="-2")
    up.add_argument("--tailcat-bin", default="")
    up.add_argument("--profiles", default="", help="host profiles to copy (ids or names)")
    up.add_argument("--cloud", default="", help="host cloud entries to copy (ids or names)")
    up.add_argument("--size", default="")
    up.add_argument("--idle-pause", default="")
    up.add_argument("--relay", choices=("", "fake", "derper"), default="")
    up.add_argument("--relay-host", default="")
    up.add_argument("--relay-port", type=int, default=0)
    up.add_argument("--relay-map-port", type=int, default=0)
    up.add_argument("--derper-bin", default="")
    up.add_argument("--orchestrator", action="store_true")
    up.add_argument("--rig-root", default="")
    up.add_argument("--ready-timeout", type=float, default=120.0)
    down = sub.add_parser("down", help="remove the rig and prove the cleanup")
    down.add_argument("--force", action="store_true")
    down.add_argument("--sandbox-timeout", type=float, default=240.0)
    down.add_argument("--ready-timeout", type=float, default=120.0)
    sub.add_parser("status", help="print the rig state as JSON")
    call = sub.add_parser("call", help="one JSON-RPC call to the rig daemon")
    call.add_argument("method")
    call.add_argument("params", nargs="?")
    call.add_argument("--timeout", type=float, default=120)
    relay = sub.add_parser("relay", help="take the rig relay node down or bring it back")
    relay.add_argument("action", choices=("down", "up"))
    smoke = sub.add_parser("smoke", help="one cloud agent, one turn, timings as evidence")
    smoke.add_argument("--cloud-entry", default="")
    smoke.add_argument("--profile", default="")
    smoke.add_argument("--timeout", type=float, default=300.0)
    args = parser.parse_args(argv)
    if args.command == "up" and args.relay == "derper":
        args.relay_port = args.relay_port or 18443
        args.relay_map_port = args.relay_map_port or 18080
    handlers = {"up": cmd_up, "down": cmd_down, "status": cmd_status, "call": cmd_call,
                "relay": cmd_relay, "smoke": cmd_smoke}
    try:
        return handlers[args.command](args)
    except RigError as error:
        OUT.say(f"ERROR: {error}", err=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
