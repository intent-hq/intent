> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.58 Push relay linking.

## 5.58 Push relay linking (prepared)

The push relay (`push.intentapp.dev`, repository `intent-hq/intent-push`) keeps the iOS
agent Live Activity current and sends agent alerts while the app is closed. The daemon
publishes signed facts about each workspace to the relay. A phone links itself to this
daemon with a one-time token from `push.createLink`, then talks to the relay directly.

This is a **prepared** contract: the `push.relayEnabled` setting (§5.12) is `false` by
default, and no client offers the feature yet. An older daemon answers `-32601` for all
three methods; clients treat that as "not supported".

| Method | Params | Result |
| --- | --- | --- |
| push.createLink | — | `{ linkToken, expiresAt, daemonId, relayUrl }` |
| push.revokeLink | — | `{ revoked }` |
| push.status | — | `{ enabled, relayUrl, daemonId: string \| null, linked }` |

### Callers

All three methods act on the caller's own link and take no parameters. The owner and
host members may call them. A link shows every ordinary workspace on the machine, which
is what a host member can already see. Guests and agents get `-32003 Forbidden`.

### `push.createLink`

1. Refused with `-32602` while `push.relayEnabled` is `false`.
2. On first use the daemon creates an Ed25519 key in its secret store. `daemonId` is the
   base64url SHA-256 of the raw 32-byte public key.
3. The daemon registers the key with the relay (`POST /v1/daemons`) when it has not done
   so for this relay origin, then asks for a link (`POST /v1/daemons/:daemonId/links`).
   The link `subject` is derived from the caller's principal, so the daemon can revoke
   it later without learning device ids.
4. `linkToken` is single use and expires at `expiresAt` (ISO 8601, ten minutes).
   `relayUrl` is the relay origin the phone must register with.
5. A relay failure is `-32603` with the message `push relay request failed: …`.

### `push.revokeLink`

Revokes the caller's subject at the relay (`DELETE /v1/daemons/:daemonId/links/:subject`),
which unlinks every phone the caller linked. `revoked: false` means the relay was not
reached; the daemon keeps the revocation and retries with backoff. When a principal's
credentials are revoked (`principal.revokeSelf`, host member removal), the daemon revokes
that principal's subject the same way.

### `push.status`

`enabled` mirrors `push.relayEnabled`. `linked` is whether the caller holds a link.
`daemonId` is `null` while the relay is off and the caller holds no link.

### Published facts

Only while `push.relayEnabled` is `true` and at least one link exists, the daemon sends
each workspace's state to the relay, coalesced to at most one update per workspace per
second, and the full set on start and after the relay was unreachable. Archived, retired
and deleted workspaces publish `{ state: null }`. The state carries the title, status
message, `running`, `displayStatus`, `attention`, the active agent's id and name, the
last activity time and an optional notice. It never carries note or transcript content.

A notice is attached when:

| Kind | When |
| --- | --- |
| `done` | An agent goes idle and the app's alert suppression passes: the agent is not background, not muted, not waiting on sub-agents, and no other unmuted agent in the workspace is active. |
| `needs_attention` | `displayStatus` becomes `needs_attention` or `blocked`. |
| `review_required` | `attention` becomes `review_required`. |
