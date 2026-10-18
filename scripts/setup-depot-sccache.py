#!/usr/bin/env python3
"""Install pinned sccache without Actions caching and select a WebDAV backend.

When INTENT_SCCACHE_ENDPOINT is set, the self-hosted cache is used with
INTENT_SCCACHE_TOKEN and INTENT_SCCACHE_MODE (READ_WRITE by default). It
overwrites the SCCACHE_WEBDAV_* values Depot runners inject. Without a token
(for example fork pull requests) compilation is uncached; a Depot token is
never sent to the self-hosted endpoint. When the variable is unset, Depot
supplies its job-scoped endpoint, and other runners may supply DEPOT_TOKEN
through DEPOT_SCCACHE_TOKEN. Missing credentials leave compilation uncached.
"""
import hashlib
import os
from pathlib import Path
import platform
import socket
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request

VERSION = "0.17.0"
ASSETS = {
    ("Linux", "x86_64"): ("x86_64-unknown-linux-musl", "67c4a96dd237c1f518f6b36083f270f9976d516f1e57fce891755ea782e50006"),
    ("Linux", "aarch64"): ("aarch64-unknown-linux-musl", "821a86343191aa1cbab74bd42f9e93c9a63bf85e4742945f40d3ae84193c1c77"),
    ("Darwin", "arm64"): ("aarch64-apple-darwin", "0c560bfba31aef5bdfb4fb3d2677f6e61d71c5c00952f2a83344f47aa31f00f1"),
    ("Darwin", "x86_64"): ("x86_64-apple-darwin", "c2144cafbfe3d22e34ae637f9974ce53613543ac19477fdb287df22ea3668261"),
    ("Windows", "AMD64"): ("x86_64-pc-windows-msvc", "caf1932d76a909c909b7a2e41443cdfe3c79a49a380da1a22fa422e1d00d3ca7"),
}


DEPOT_ENDPOINT = "https://cache.depot.dev"
MODES = ("READ_WRITE", "READ_ONLY")
# Inherited Depot values that would otherwise leak into the self-hosted
# configuration. Present ones are blanked; the endpoint and token are replaced.
INHERITED_WEBDAV = ("SCCACHE_WEBDAV_KEY_PREFIX", "SCCACHE_WEBDAV_USERNAME", "SCCACHE_WEBDAV_PASSWORD")
WRAPPER = {"SCCACHE_GHA_ENABLED": "false", "CARGO_INCREMENTAL": "0", "RUSTC_WRAPPER": "sccache"}


def is_depot(endpoint):
    host = urllib.parse.urlsplit(endpoint).hostname or ""
    return host == "depot.dev" or host.endswith(".depot.dev")


def self_hosted_endpoint(env):
    endpoint = (env.get("INTENT_SCCACHE_ENDPOINT") or "").strip()
    if not endpoint:
        return ""
    parts = urllib.parse.urlsplit(endpoint)
    loopback = parts.hostname in ("127.0.0.1", "localhost", "::1")
    if not parts.hostname or not (parts.scheme == "https" or (parts.scheme == "http" and loopback)):
        raise ValueError("INTENT_SCCACHE_ENDPOINT must be an https:// URL")
    if is_depot(endpoint):
        raise ValueError("INTENT_SCCACHE_ENDPOINT must not point at Depot; unset it to use Depot Cache")
    return endpoint


def select(env):
    """Return (backend, mode, values); backend is self-hosted, depot or uncached."""
    endpoint = self_hosted_endpoint(env)
    if endpoint:
        token = (env.get("INTENT_SCCACHE_TOKEN") or "").strip()
        if not token:
            return "uncached-self-hosted", None, {}
        mode = (env.get("INTENT_SCCACHE_MODE") or "READ_WRITE").strip().upper()
        if mode not in MODES:
            raise ValueError("INTENT_SCCACHE_MODE must be READ_WRITE or READ_ONLY")
        result = {key: "" for key in INHERITED_WEBDAV if key in env}
        result.update(SCCACHE_WEBDAV_ENDPOINT=endpoint, SCCACHE_WEBDAV_TOKEN=token, SCCACHE_WEBDAV_RW_MODE=mode)
        result.update(WRAPPER)
        return "self-hosted", mode, result
    result = {}
    endpoint = env.get("SCCACHE_WEBDAV_ENDPOINT")
    token = env.get("SCCACHE_WEBDAV_TOKEN") or env.get("DEPOT_SCCACHE_TOKEN")
    if not endpoint and token:
        result["SCCACHE_WEBDAV_ENDPOINT"] = DEPOT_ENDPOINT
        endpoint = result["SCCACHE_WEBDAV_ENDPOINT"]
    if not endpoint:
        return "uncached", None, {}
    # The Depot organization token is only ever paired with a Depot endpoint.
    if token and not env.get("SCCACHE_WEBDAV_TOKEN") and is_depot(endpoint):
        result["SCCACHE_WEBDAV_TOKEN"] = token
    result.update(WRAPPER)
    return "depot", None, result


def configuration(env):
    return select(env)[2]


def install(directory):
    target, checksum = ASSETS[(platform.system(), platform.machine())]
    stem = f"sccache-v{VERSION}-{target}"
    suffix = ".exe" if platform.system() == "Windows" else ""
    binary = directory / ("sccache" + suffix)
    directory.mkdir(parents=True, exist_ok=True)
    # Keep downloads on the runner job volume; Windows system temp may be
    # on a different, nearly full drive than RUNNER_TEMP.
    with tempfile.TemporaryDirectory(dir=directory.parent) as scratch:
        archive = Path(scratch) / "sccache.tar.gz"
        urllib.request.urlretrieve(f"https://github.com/mozilla/sccache/releases/download/v{VERSION}/{stem}.tar.gz", archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            raise RuntimeError("sccache release checksum mismatch")
        with tarfile.open(archive) as tar:
            member = tar.extractfile(f"{stem}/sccache{suffix}")
            if member is None:
                raise RuntimeError("sccache binary missing from release")
            binary.write_bytes(member.read())
        binary.chmod(0o755)
    subprocess.run([str(binary), "--version"], check=True)
    return directory


def main():
    backend, mode, values = select(os.environ)
    # The local WebDAV fixture smoke test needs the pinned binary even without
    # managed credentials. It supplies its own isolated cache configuration.
    directory = install(Path(os.environ["RUNNER_TEMP"]) / "intent-sccache")
    with open(os.environ["GITHUB_PATH"], "a", encoding="utf-8") as output:
        output.write(str(directory) + "\n")
    if backend == "uncached-self-hosted":
        print("::notice::INTENT_SCCACHE_ENDPOINT is set but INTENT_SCCACHE_TOKEN is empty "
              "(for example a fork pull request); Rust compilation is uncached.")
        return
    if not values:
        print("::notice::No Depot cache credentials configured; Rust compilation is uncached.")
        return
    # A self-hosted machine may already have an unrelated sccache server.
    # Isolate this job so it cannot inherit that server's backend or token.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        values["SCCACHE_SERVER_PORT"] = str(listener.getsockname()[1])
    # The idle timer measures time since the last request, even while rustc
    # is compiling. Long crates must not lose the server mid-request.
    # GitHub runners clean up job-owned processes at the end of the job.
    values["SCCACHE_IDLE_TIMEOUT"] = "0"
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as output:
        for key, value in values.items():
            if "\n" in value or "\r" in value:
                raise ValueError("Invalid cache configuration")
            output.write(f"{key}={value}\n")
    if backend == "self-hosted":
        host = urllib.parse.urlsplit(values["SCCACHE_WEBDAV_ENDPOINT"]).hostname
        print(f"Rust compilation uses self-hosted sccache at {host} ({mode}).")
        return
    print("Rust compilation uses Depot managed sccache.")


if __name__ == "__main__":
    main()
