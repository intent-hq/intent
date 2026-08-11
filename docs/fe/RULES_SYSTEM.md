# Rules System Architecture

The rules system is assembled in the backend by `InstructionService` and sourced from TypeScript instruction modules, end-user overrides, workspace overrides, project rule files, and optional skills catalogs.

## System Prompt Layers

`buildSystemPrompt()` assembles **9 layers** in this order:

| Order | Layer | Source | Notes |
|------|-------|--------|-------|
| 1 | Base system prompt | `base-system-prompt.ts` + end-user base override | Identity and tool guidance for interactive agents |
| 2 | Specialization rules | `getSpecializationRules()` | `common` + `workspace` + specific instruction ID |
| 3 | User rules | `CLAUDE.md`, `AGENTS.md`, `.augment/guidelines.md`, `.augment/rules/*.md` | Project conventions from the workspace |
| 4 | Skills catalog | skills loaders | `.agents/skills`, `.augment/skills`, `~/.claude/skills` |
| 5 | Behavior prompt | `behaviorPrompt` parameter | Specialist-specific behavior text |
| 6 | Parent-only orchestration | team/knobs/specialists/branch preference helpers | Skipped for sub-agents |
| 7 | Workspace context | `workspaceContext` parameter | Open panels + linked references; skipped for sub-agents |
| 8 | Runtime context | `contextReferences` parameter | Per-launch dynamic context |
| 9 | Mandatory footer | `getMandatoryActionsFooter()` | Keeps role reminder at the end for recency |

Sub-agents skip the parent-only orchestration layers and workspace-context layer to keep delegated prompts lighter.

## Prompt Builder Inputs

### Public `buildSystemPrompt()` config fields

- `agentType`
- `workspacePath`
- `contextReferences`
- `behaviorPrompt`
- `specialistName`
- `roleReminder`
- `workspaceContext`
- `workspaceTitle`
- `isInitialAgent`
- `isSubAgent`

### Internal controls that also affect the final prompt

- `prefetchedSkillsCatalog` - internal prefetch/cache optimization used when hashing prompt cache keys

## Specialization Resolution

`getSpecializationRules()` uses a 3-tier fallback:

1. **End-user overrides** from `EndUserRulesManager` (`electron-store`)
2. **Workspace overrides** from `.augment/agent-rules/{agentType}.md`
3. **Bundled TypeScript instructions** via `getInstructionWithCommon()`

## What `getInstructionWithCommon()` Actually Returns

| Instruction kind | Result |
|------|--------|
| `common` | `common` only |
| `workspace` | `common + workspace` |
| Regular interactive/task/workspace instruction | `common + workspace + specific` |
| Non-interactive background instruction (`code-review`, `code-walkthrough`, `commit-message`, `pr-description`) | specific instruction only |

## Key Files

| File | Purpose |
|------|---------|
| `src/features/agent/main/instruction-service.ts` | Builds complete prompts, manages caches, and assembles prompt layers |
| `src/features/agent/main/instructions/index.ts` | Source of truth for instruction IDs, aliases, and helper exports |
| `src/features/agent/main/instructions/common.ts` | Shared instruction layer prepended to most agents |
| `src/features/agent/main/instructions/workspace.ts` | Shared workspace-operating guidance |
| `src/features/agent/main/instructions/base-system-prompt.ts` | Base system prompt content |
| `src/features/agent/main/rules-loader.ts` | Loads project rule files from the workspace |
| `src/features/rules/user-rules.service.ts` | Stores end-user rule overrides by type |

## Exported Helpers from `instructions/index.ts`

- `getInstructionById()`
- `getInstructionWithCommon()`
- `getAvailableInstructionIds()`
- `getAgentTypesWithMetadata()`
- `isUtilityAgent()`

## Current Instruction IDs

These are the IDs returned by `getAvailableInstructionIds()` or exported from `instructions/index.ts`.

### Interactive and shared instructions

| ID | Purpose |
|----|---------|
| `chat` | Conversational agent for Q&A and general discussion |
| `common` | Shared instruction layer used during specialization assembly |
| `debug` | General debugging and error investigation |
| `workspace` | Shared workspace-operating guidance |
| `setup-script-generator` | Generates worktree/setup scripts |
| `task-breakdown` | Breaks large tasks into smaller steps |
| `task-debug` | Debugging agent for task flows |
| `task-focused` | Focused on one assigned task |
| `task-loop` | Iterative task agent using a task note |
| `ralph-loop` | Coordinator-style planning/delegation loop |
| `workspace-agent` | Manages workspace operations via MCP |
| `notes-system-guide` | Documentation-oriented instruction about the notes system |

### Background instruction IDs

| ID | Purpose |
|----|---------|
| `code-review` | Background review of code changes |
| `code-walkthrough` | Background narrated walkthrough of staged changes |
| `commit-message` | Background conventional commit generation |
| `pr-description` | Background PR description generation |

## Typed Agent IDs

`src/shared/types/agent.types.ts` currently defines these runtime-validated `AgentTypeId` values:

- `chat`
- `code-walkthrough`
- `common`
- `debug`
- `workspace`
- `setup-script-generator`
- `task-breakdown`
- `task-debug`
- `task-focused`
- `task-loop`
- `ralph-loop`
- `workspace-agent`
- `code-review`
- `commit-message`
- `pr-description`

## Aliases

`getInstructionById()` currently supports these aliases:

- `fix` → `debug`
- `review` → `code-review`
- `walkthrough` → `code-walkthrough`

## Workspace Rule Loading

`loadUserRules()` checks project rule sources in this order:

1. optional custom rules path
2. `CLAUDE.md`
3. `AGENTS.md`
4. `.augment/guidelines.md`
5. `.augment/rules/*.md` (sorted, concatenated, frontmatter-aware)

Rule files in `.augment/rules/` may declare YAML frontmatter with `type: always_apply` or `type: agent_requested`.

## Customizing Rules

### User-level

- `EndUserRulesManager` stores rules per type in `electron-store`
- Rule types include `base-system-prompt` and instruction-specific IDs
- Legacy imports using `system` are migrated internally

### Workspace-level

- Create `.augment/agent-rules/{agentType}.md` to override bundled specialization rules for a workspace

### Project-level

- Add `CLAUDE.md`, `AGENTS.md`, `.augment/guidelines.md`, or `.augment/rules/*.md`

## Caching

`InstructionService` maintains multiple caches:

| Cache | TTL / Limit | Purpose |
|-------|-------------|---------|
| Specialization rules cache | 5 minutes, max 100 entries (LRU) | Caches resolved specialization content per agent type/workspace |
| Full system prompt cache | 30 seconds, max 20 entries | Reuses fully assembled prompts for repeated launches |
| File watchers | invalidates on change | Clears workspace-derived specialization entries when watched files change |

Prompt caching is disabled when runtime context or workspace context is present, and the cache key also incorporates behavior prompt, role reminder, workspace-title status, sub-agent state, and the hashed skills catalog content.
