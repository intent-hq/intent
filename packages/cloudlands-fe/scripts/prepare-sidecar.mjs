// Build the sibling `intentd` daemon (release) and stage it as a Tauri sidecar.
//
// Tauri resolves an `externalBin` entry `binaries/intentd` to a file named
// `binaries/intentd-<target-triple>` (plus `.exe` on Windows). This script
// compiles `packages/intentd` and copies the resulting binary into place so
// `pnpm tauri dev` / `pnpm tauri build` can bundle it.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const feRoot = resolve(here, "..");
const intentdRoot = resolve(feRoot, "..", "intentd");
const binariesDir = join(feRoot, "src-tauri", "binaries");

function hostTargetTriple() {
  // `rustc -Vv` prints a `host: <triple>` line.
  const out = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  if (!line) throw new Error("could not determine host target triple from `rustc -Vv`");
  return line.slice("host:".length).trim();
}

function main() {
  if (!existsSync(join(intentdRoot, "Cargo.toml"))) {
    throw new Error(`intentd workspace not found at ${intentdRoot}`);
  }

  const triple = hostTargetTriple();
  const isWindows = triple.includes("windows");
  const exeSuffix = isWindows ? ".exe" : "";

  console.log(`[sidecar] building intentd (release) in ${intentdRoot}`);
  execFileSync("cargo", ["build", "--release", "-p", "intentd"], {
    cwd: intentdRoot,
    stdio: "inherit",
  });

  const built = join(intentdRoot, "target", "release", `intentd${exeSuffix}`);
  if (!existsSync(built)) {
    throw new Error(`expected built binary not found at ${built}`);
  }

  mkdirSync(binariesDir, { recursive: true });
  const dest = join(binariesDir, `intentd-${triple}${exeSuffix}`);
  copyFileSync(built, dest);
  if (!isWindows) chmodSync(dest, 0o755);

  console.log(`[sidecar] staged ${built} -> ${dest}`);
}

main();
