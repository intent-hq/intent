> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.46 Semantic codebase map.

## 5.46 Semantic codebase map — `map.*`

Introduced in protocol v9.12.

The semantic map groups workspace-relative files into named regions. Every method requires
`workspaceId`. A curated manifest is stored in the newest note tagged `semantic-map`; when no
such note exists, `map.get` derives a deterministic structural manifest from the worktree.

### Shapes

```ts
type MapSource = "curated" | "structural";
type AssignmentConfidence = "curated" | "unsorted";
type ClassifyPath = string | { path: string; gitRootId?: string };
type MapActivityKind = "read" | "edit" | "create" | "delete" | "move" | "tool" | "thinking";

interface Manifest {
  version: 1;
  regions: Array<{
    id: string; label: string; responsibility: string;
    parent?: string; anchor: [number, number]; paths: string[]; color?: string;
  }>;
  crossings?: Array<{ from: string; to: string; label: string }>;
}
```

Anchors contain two finite numbers in the inclusive range `0..1`. Region `paths` use gitignore
patterns; later matching regions win. A path matching no region is assigned to `unsorted` with
confidence `unsorted`. Optional fields are omitted, never `null`.

### Methods

| Method | Params | Result |
| --- | --- | --- |
| `map.get` | `workspaceId` (req) | `{ manifest: Manifest, source: MapSource, coverage: { matched, total } }` |
| `map.setManifest` | `workspaceId` (req), `json` (req; object or JSON string) | `{ ok: true, noteId }` |
| `map.classify` | `workspaceId` (req), `paths: ClassifyPath[]` (req) | `Array<{ regionId, confidence }>` in request order |
| `map.activity` | `workspaceId` (req), `sinceTs?`, `minutesAgo?`, `agentId?`, `kinds?: MapActivityKind[]`, `limit?` | `MapActivity[]` |
| `map.route` | `workspaceId` (req), exactly one of `agentId` / `taskNoteId`, `sinceTs?` | `{ visits: string[], transitions: RouteTransition[] }` |

`map.setManifest` validates the whole manifest before creating or updating the tagged note. Invalid
JSON, an unsupported version, malformed regions, or out-of-range anchors return `-32602` and leave
the existing note unchanged. `map.get` reports coverage over the scanned worktree files; `matched`
counts assignments whose confidence is not `unsorted`.

Paths without `gitRootId` are workspace-root-relative. When `gitRootId` identifies a registered
secondary root, the daemon rebases `path` beneath that root before applying manifest patterns.

`map.activity` projects durable `file:changed`, `file:created`, `file:deleted`, `file:renamed`,
`agent:tool:call`, and `agent:stream:activity` events. `sinceTs` takes precedence when both time
filters are supplied. `limit` defaults to 50 and is clamped to `1..500`. Unknown `kinds` values are
`-32602`. Each returned item has this shape:

```ts
interface MapActivity {
  id: string;
  regionId?: string; agentId?: string; agentName?: string; path?: string;
  kind: MapActivityKind; ts: string;
}
```

`id` is required and opaque to clients. The daemon derives it from the durable source event's
identity, so it is unique within the workspace activity stream and stable when the same activity
is replayed by later `map.activity` calls; clients must not derive meaning from its format.

At persistence time, the daemon projects each eligible durable source event into one transient
`map:activity` event (§6.5), whose `data` is that event's `MapActivity`. `map.activity` replays
projected activities and does not itself emit live events. The same source event has the same
`MapActivity.id` in its live frame and later replay; clients combining them must deduplicate by
`MapActivity.id`.

`map.route` reads at most 500 source events. An `agentId` selects that agent; a `taskNoteId` selects
all agents currently assigned to that task note. No assigned agents yields an empty route. Visits
contain each encountered region once, in chronological encounter order. A transition is:

```ts
interface RouteTransition {
  from: string; to: string; count: number; evidence: string[]; label?: string;
}
```

`label` comes from a matching manifest crossing. Evidence contains distinct paths observed on that
transition. Activity from different agents never creates a cross-agent transition.