# Owner-backend Keychain contract (v1)

The desktop app and iOS companion share one synchronizable generic-password
item per owner backend, under service `com.cloudlands.intent.backends` and shared
access-group suffix `dev.intentapp.backends` (prefixed by the signing team).
The account is the host, trimmed and lowercased, followed by `:` and the port.
The JSON payload version is **1**. This contract is separate from the daemon
JSON-RPC version and excludes the desktop guest-sessions service.

The [canonical corpus](./fixtures/backend-keychain/v1/corpus.json) contains
synthetic credentials and hand-reviewed expected results. It describes existing
behavior, including differences; it does not change production codecs, identity
rules, conflict resolution, or retry state machines.

## Payload and identity

| Field | Read behavior |
| --- | --- |
| `v` | Required JSON number, never a boolean. Values greater than 1 return `newer-version` before other fields are inspected. Existing readers also accept numeric versions less than 1. |
| `label` | Required string; blank is accepted. |
| `host` | Required nonblank string. Stored spelling is retained; account identity trims and lowercases it. |
| `port` | Required number on desktop; iOS requires an exactly representable `Int`. Fractional ports are a documented incompatibility below. |
| `fingerprint` | Required string; blank is accepted for legacy records. Machine identity uses a nonblank trimmed, uppercase fingerprint. |
| `updatedAt` | Required number, milliseconds since the Unix epoch; last-writer-wins clock. |
| `hosts` | Array of strings, including an empty array; absent or wrongly typed values default to `[host]`. |
| `hostname` | String or null; other values become null. |
| `detectHosts` | Boolean; other values default to true. Numeric 0/1 are not booleans. |
| `token` | String; other values become empty. All parsed tombstones scrub it to empty. |
| `tcAddress` | Opaque, case-sensitive tunnel route. Absent, null, empty, whitespace-only, or nonstring values become null. Nonblank surrounding whitespace differs by reader, below. |
| `deleted` | Only JSON true makes a tombstone; absent/false/other types are live. |
| `deletedAt` | Tombstone TTL anchor in milliseconds; absent or nonnumeric values fall back to `updatedAt`. Ignored on live records. |
| Desktop metadata | Desktop reads `accent` (default `blue`), `detectedDeviceKind` (default null), and `deviceIcon` (default `auto`). Invalid explicitly supplied accent rejects the desktop payload. iOS does not put these fields in its decoded record. |
| Other fields | Unknown fields are tolerated on read. Preservation depends on the write operation, below. |

Malformed JSON, nonobject roots, or missing/wrongly typed required fields return
`invalid`. Null required fields are invalid. No production token, iCloud account,
real Keychain entitlement, or live backend is needed by the corpus tests.

Machine identity is `fp:<trimmed uppercase fingerprint>` when present, otherwise
`addr:<account>`. The prefix is the iOS registry-key spelling; desktop implements
the same matching decision inside reconcile. Desktop tests must exercise that
production matching with injected stores, not recreate a fingerprint normalizer
and call the result a test. Account normalization must never lowercase `tcAddress`
in the payload. A tunnel-only publisher uses its route as the required `host`
identity and an empty `hosts` list. iOS import excludes that route from LAN/DNS
candidates while retaining the exact route and token.

Tombstones retain identity and routing fields but scrub tokens, on both parse and
desktop serialization. They expire when
`(deletedAt ?? updatedAt) + 2592000000 <= nowMs`, including the exact boundary.
The reader's expiry rule is not permission to resurrect a deletion: iOS pairing
publication still considers expired tombstones when selecting a winner.

## Existing operation-specific behavior

The audit used desktop commit
`1f2be8ad5c7419b96de14f58ff446c5a648ec03f` and iOS commit
`39b57325ade72ecdafc1c9600c1e4890f5bb136f`, the actual iOS `origin/main` after
[iOS PR 493](https://github.com/intent-hq/ios/pull/493), rather than the older
monorepo iOS pin. Relevant code is desktop `keychain-sync.ts` and iOS
`SyncedBackendRegistry.swift`, `SyncedBackendConnectionMerge.swift`, and
`SyncedBackendPublisher.swift`.

| Operation / case | Desktop | iOS |
| --- | --- | --- |
| Parse `route-padded` | Retains the surrounding tab/newline/spaces in the nonblank route. | Trims surrounding whitespace, retains route case. |
| Parse `port-fractional` | Accepts 8843.5 and keys the account with that literal number. | Rejects the record; never truncates to 8843. |
| Parse `accent-invalid` | Rejects explicit numeric accent. | Ignores that desktop-owned field and reads the record. |
| Decode unknown metadata | Keeps recognized desktop metadata, discards arbitrary unknown keys. | Typed record contains only shared fields, discards arbitrary unknown keys. |
| Desktop `serializeRecord` | Writes recognized fields and metadata defaults; discards arbitrary extra fields. Live records omit removal fields. | No equivalent general-purpose typed-record encoder. |
| iOS pairing/re-pair publication | Covered by desktop serialization separately. | Starts from the winning raw dictionary; preserves desktop and unknown metadata, hostname, detectHosts, and a known shared route if no local route is known. Replaces pairing-owned fields, merges hosts, removes removal markers. A new item supplies `v: 1`, null hostname, true detectHosts, and null route when unknown. |
| iOS route publication | Existing desktop reconciliation suites retain ownership of their conflict cases. | Patches the winning raw dictionary's hosts/route/clock only; preserves credentials and metadata. Cannot create a missing backend or revive a tombstone. |
| iOS import | Desktop reconciler delivers the parsed record to its adapter. | Trims surrounding fingerprint whitespace when constructing a saved connection; retains fingerprint case. Route-less remote records do not clear a known local route. |
| Invalid/future record at the target account | Reconcile freezes it: no local apply, upsert, or delete, even when a newer local record exists. | Pair publication returns retry without writing; the pending durable edit survives. |

These differences have operational effects: a padded route is not a universal
cross-client round-trip, fractional-port records cannot import on iOS, and malformed
desktop accent metadata can make a row readable only on iOS. The corpus makes each
result explicit. Tests must not trim routes, coerce ports, lowercase addresses, or
drop shared fields to manufacture agreement. The expected record dictionaries are
complete for their stated operation, not a broad per-client field exemption.
Existing component conflict, durability, retry, and route-merge tests remain in
place; this corpus complements them.

## Fixture format

`fixtureFormatVersion: 1` describes this test format; `payloadVersion: 1` describes
the production payload. These versions are independent. `corpus.json` contains:

| Array | Input and expected result |
| --- | --- |
| `parseCases` | `id`, literal `payload` string (including malformed JSON), complete `desktop` and `ios` parse expectations: `{kind: invalid\|newer-version}` or `{kind: record, record: {...}}`. Desktop live records omit deleted/deletedAt; iOS typed records explicitly have false/null. Null represents Swift nil, without trimming/coercing any actual value. |
| `identityCases` | Raw host/port/fingerprint and independent expected accountKey/registryKey. Use real account/registry APIs and desktop reconciliation for fingerprint pairing. |
| `serializeCases` | Desktop record input and complete expected JSON payload object. Compare parsed serialization to the expected object; do not generate expected output with the codec. |
| `expiryCases` | Reference to a `parseCases` record, fixed `nowMs`, and expected expired boolean. Desktop can observe purge through reconcile; Swift uses its expiry/registry behavior with an injected date. |
| `iosPublishCases` | `pair` or `routes`, existing raw account/payload rows, explicit local connection inputs, expected outcome and complete captured writes. Use an injected Keychain writer. |
| `iosImportCases` | Reference to a parsed record and exact hosts/port/fingerprint/token/tcAddress of the connection imported into an empty store. |
| `noWriteCases` | Reference to an invalid/future raw payload at an explicit account, newer desktop localRecord/iOS connection, fixed nowMs, and zero-write/apply/delete expectations. Assert the stored bytes remain unchanged too. |

Connection inputs map label to the saved connection's displayName, hosts/port/
fingerprint/tcAddress to its server, token to the saved credential, and pending
fields to the existing publication types. Unrelated generated IDs or pairing dates
are not fixture assertions. Publication `writes` contains account and decoded JSON
payload; object key ordering is not a production serialization requirement.

All fixture files themselves use UTF-8, two-space JSON indentation, one final
newline, and no duplicate keys. `manifest.json` is exactly:

```json
{
  "fixtureFormatVersion": 1,
  "payloadVersion": 1,
  "files": {
    "corpus.json": "<64 lowercase hex characters: SHA-256 of exact corpus.json bytes>"
  }
}
```

The manifest never hashes itself or embeds its own commit. The corpus digest is
the SHA-256 of the exact `corpus.json` bytes. The separate consumer lock hashes
both corpus and manifest and holds the immutable source commit.

## Distribution and verification

Canonical source repository: `intent-hq/intent`. Canonical source path:
`docs/protocol/fixtures/backend-keychain/v1`. The mirror files are exactly
`corpus.json` and `manifest.json`, byte-for-byte copies.

| Component | Mirror directory (relative to component root) | Lock (outside mirror directory) |
| --- | --- | --- |
| cloudlands-fe | `tests/fixtures/backend-keychain/v1` | `tests/fixtures/backend-keychain.lock.json` |
| ios | `IntentTests/Fixtures/backend-keychain/v1` | `IntentTests/Fixtures/backend-keychain.lock.json` |

The lock is canonical JSON with exactly `lockVersion: 1`,
`sourceRepository: "intent-hq/intent"`, `sourcePath` as above, `sourceCommit` (full
40-character lowercase Git commit), `corpusSha256`, and `files` mapping
`corpus.json` and `manifest.json` to their exact-byte SHA-256 hashes. Both consumers
use the same lock content. No branches, abbreviated revisions, timestamps, local
paths, or self-referential manifest hashes occur in it.

Select one committed source revision explicitly. From that monorepo checkout:

```bash
node scripts/backend-keychain-contract.mjs validate
node scripts/backend-keychain-contract.mjs export \
  --source-root /path/to/intent --source-commit "$SOURCE_SHA" \
  --component cloudlands-fe --component-root /path/to/cloudlands-fe
node scripts/backend-keychain-contract.mjs verify \
  --source-root /path/to/intent --source-commit "$SOURCE_SHA" \
  --component cloudlands-fe --component-root /path/to/cloudlands-fe
```

For iOS use `--component ios --component-root /path/to/ios`. Export reads only
the committed canonical bytes, validates them, and writes deterministic mirrors
and locks. Source HEAD must equal the supplied SHA, and source working-tree bytes
must equal that commit's blobs. Verification also compares the locked hashes and
the actual mirror bytes; editing a mirror and its declared hash together cannot
pass against the selected canonical checkout. Commands fail nonzero on bad input.

Standalone local component tests read their checked-in copies offline and fail
on missing/empty/invalid fixtures. iOS bundles the fixtures as test resources;
tests must not search for a sibling monorepo or a developer's source checkout.
Required component CI must:

1. Read and validate the lock's full source commit; reject floating references.
2. Check out **intent-hq/intent** at exactly that SHA (never fall back to main).
   Sparse checkout needs `scripts/backend-keychain-contract.mjs` and
   `docs/protocol/fixtures/backend-keychain/v1/`; Git objects for those blobs must
   be available. No npm dependencies or submodule initialization are required.
3. Run the checked-out canonical script's `verify` command with explicit roots,
   component name, and the locked SHA. The successful log names source SHA and
   corpus digest. Checkout or comparison failure fails the gate, never skips it.
4. Execute production conformance tests, including captured no-write behavior.
   Run native iOS tests through `scripts/xcodebuild.sh` on macOS. Required gates
   must cover PR and merge-queue builds.

`make check-backend-keychain-contract` (also in `make consumer-checks`) always
validates the canonical corpus, without compiling native components. It inspects
each initialized component's mirror/lock when either exists; partial adoption,
corruption, or differing adopted source commits/digests fails. A pinned component
with neither file is reported as **pre-adoption**, and uninitialized checkouts
(including private optional iOS) as **uninspected**, never as conformance passes.
This monorepo check checks integrity and agreement; exact-source provenance is
the component CI gate above. Older matching adopted pins remain valid while new
canonical docs lead a later adoption.

Publish the canonical docs/checks first, then let both consumers adopt the same
immutable source. Development can share one candidate commit; after the canonical
PR lands, repin both component locks to its actual landed SHA and rerun component
gates before their merge. Automatic submodule updates own gitlink advancement.

Tooling regression tests: `node --test scripts/backend-keychain-contract.test.mjs`.
They exercise real temporary Git sources, standalone export/verification, malformed
corpus coverage, source drift, self-rehashed copies, and conflicting adopted locks.
