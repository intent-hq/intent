#!/usr/bin/env python3
"""Install pinned sccache without Actions caching and select Depot's WebDAV backend.

Depot supplies its job-scoped endpoint. Other runners may supply DEPOT_TOKEN
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
import urllib.request

VERSION = "0.17.0"
ASSETS = {
    ("Linux", "x86_64"): ("x86_64-unknown-linux-musl", "67c4a96dd237c1f518f6b36083f270f9976d516f1e57fce891755ea782e50006"),
    ("Linux", "aarch64"): ("aarch64-unknown-linux-musl", "821a86343191aa1cbab74bd42f9e93c9a63bf85e4742945f40d3ae84193c1c77"),
    ("Darwin", "arm64"): ("aarch64-apple-darwin", "0c560bfba31aef5bdfb4fb3d2677f6e61d71c5c00952f2a83344f47aa31f00f1"),
    ("Darwin", "x86_64"): ("x86_64-apple-darwin", "c2144cafbfe3d22e34ae637f9974ce53613543ac19477fdb287df22ea3668261"),
    ("Windows", "AMD64"): ("x86_64-pc-windows-msvc", "caf1932d76a909c909b7a2e41443cdfe3c79a49a380da1a22fa422e1d00d3ca7"),
}


def configuration(env):
    result = {}
    endpoint = env.get("SCCACHE_WEBDAV_ENDPOINT")
    token = env.get("SCCACHE_WEBDAV_TOKEN") or env.get("DEPOT_SCCACHE_TOKEN")
    if not endpoint and token:
        result["SCCACHE_WEBDAV_ENDPOINT"] = "https://cache.depot.dev"
        endpoint = result["SCCACHE_WEBDAV_ENDPOINT"]
    if not endpoint:
        return {}
    if token and not env.get("SCCACHE_WEBDAV_TOKEN"):
        result["SCCACHE_WEBDAV_TOKEN"] = token
    result.update(SCCACHE_GHA_ENABLED="false", CARGO_INCREMENTAL="0", RUSTC_WRAPPER="sccache")
    return result


def install(directory):
    target, checksum = ASSETS[(platform.system(), platform.machine())]
    stem = f"sccache-v{VERSION}-{target}"
    suffix = ".exe" if platform.system() == "Windows" else ""
    binary = directory / ("sccache" + suffix)
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
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
    values = configuration(os.environ)
    # The local WebDAV fixture smoke test needs the pinned binary even without
    # managed credentials. It supplies its own isolated cache configuration.
    directory = install(Path(os.environ["RUNNER_TEMP"]) / "intent-sccache")
    with open(os.environ["GITHUB_PATH"], "a", encoding="utf-8") as output:
        output.write(str(directory) + "\n")
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
    print("Rust compilation uses Depot managed sccache.")


if __name__ == "__main__":
    main()
