---
name: atlas
description: Works with Atlas knowledge workspaces by routing requests into ingest, query, or lint workflows. Use when capturing durable project knowledge, recording operational updates such as todos, blockers, owners, and next steps, answering read-only questions from the knowledge layer, or maintaining project knowledge structure.
---

## What Atlas is

Atlas is middleware between fragmented software systems and LLM chat: a file-based knowledge layer that maintains synthesized understanding for companies, clients, and projects. Its job is to turn scattered signal (meetings, documents, conversations, operational updates) into a persistent, current, source-grounded representation that any agent can read before a question is asked.

The filesystem is the delivery surface. Enduring context, current operational state, episodic history, navigation, and raw sources each live in their own file so that facts with different decay rates stay structurally separated:

- **Stable context** lives in `_atlas.md`, `_client.md`, `_project.md`.
- **Current state** lives in `_state.md`.
- **Episodic history** lives in `_log.md`.
- **Navigation** lives in `_index.md`.
- **Evidence pages and maintained knowledge objects** live in `knowledge/`.
- **Immutable evidence** lives in `sources/`.

Agents read these files to boot into a project; Atlas workflows (`ingest`, `query`, `lint`) keep them accurate, current, and internally consistent over time.

## Example Calls

- `store ./notes/kickoff-call.md into website-refresh`
- `lint website-refresh`
- `what are the current blockers in website-refresh`
- `save our last conversation into website-refresh`
- `save a new todo for website-refresh in acme: plan a meeting with Anna`
- `compare active risks across acme projects`

## Action routing

Route the user request into one of three actions: `ingest`, `query`, or `lint`.


| If the user wants to...                                                                | Route to | Then use                                                               |
| -------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| add, ingest, save, file, capture, refine, or correct durable project knowledge         | `ingest` | [actions/ingest.md](actions/ingest.md) — source-input branch           |
| record an operational update such as a new todo, blocker, owner change, or next step   | `ingest` | write to `_state.md`, then append `_log.md` — see below                |
| ask a read-only question, compare projects, verify a claim, or summarize current state | `query`  | [actions/query.md](actions/query.md)                                   |
| health-check, audit, maintain, or repair structural drift in the knowledge layer       | `lint`   | [actions/lint.md](actions/lint.md)                                     |
| signal intent unclear, scope unresolved, or routing ambiguous                          | ask user | confirm before routing                                                 |


- After routing, follow the corresponding action file for the detailed workflow and behavior.
- If intent cannot be inferred with confidence, ask the user before routing.

## Operational update minimum path

An operational update is a new todo, new blocker, owner change, or near-term next step. Follow this path even if the full action file is not loaded:

1. Resolve the target client and project.
2. Read `_project.md` and `_state.md`.
3. **Update `_state.md` with the new item.** Todos and action tasks must always use the exact format `- [ ] (Owner) Task`.
4. Append a short entry to the end of `_log.md` describing the update.

Guardrails:

- `_log.md` alone is not a valid operational update. Step 3 is mandatory.
- Do not treat "record", "log", "save", or "capture" as synonyms for "append to `_log.md`". The primary write is always `_state.md`; `_log.md` is the chronological mirror.
- If the user does not provide an owner for a todo or action task, use `(Unassigned)`. Do not invent an owner.
- Append means add the newest entry after all existing log entries. Do not insert new entries at the top or reorder old entries.
- Do not write operational updates into `_project.md`. `_project.md` holds stable project context; `_state.md` holds the live operating picture.
- Do not create a knowledge page, a source file, or an `_index.md` entry for a bare operational update.
- If `_state.md` does not exist yet, create the minimum structure (see [references/file-state.md](references/file-state.md)) before writing.

## Workspace architecture

All paths below are relative to the Atlas workspace root.

```text
[workspace-root]/
  _atlas.md
  clients/
    [client]/
      _client.md
      projects/
        [project]/
          _project.md
          _state.md
          _index.md
          _log.md
          sources/
          knowledge/
```

### Workspace root resolution

Before resolving clients or projects, find the Atlas workspace root:

1. Use the nearest ancestor directory that contains both `_atlas.md` and `clients/`.
2. If the user provides an explicit workspace path, validate that path has the Atlas workspace shape before writing.
3. If no workspace root can be found, or multiple matching client/project paths could satisfy the request, ask the user to choose the scope.

### Layer semantics

- `_atlas.md` holds company-wide enduring facts and links to client nodes.
- `_client.md` holds enduring client relationship facts and links to project nodes.
- `_project.md` holds stable project context — background, constraints, key actors, scope boundaries, standing decisions.
- `_state.md` holds the live operating picture — active work, blockers, owners, near-term next steps.
- `_index.md` catalogs the project knowledge layer with required `## Core Pages` and `## Knowledge Pages` sections.
- `_log.md` records project knowledge operations chronologically and holds episodic memory.
- `sources/` holds exact raw artifacts.
- `knowledge/` holds the evolving markdown knowledge layer for that project: source-grounded evidence pages and maintained knowledge objects.

### Knowledge model

Atlas distinguishes two knowledge-page roles:

- **Evidence pages** preserve and structure important bounded inputs, such as conversations, reports, and research. They keep provenance and first-pass synthesis close to the originating material.
- **Maintained knowledge objects** hold durable synthesized understanding that should absorb evidence from multiple systems and remain current over time. `topic` and `decision` pages are the default maintained knowledge object types.

New evidence should update the relevant maintained knowledge object whenever one exists. Atlas is not only storing material for later retrieval; it is maintaining project understanding continuously.

### Design principles

- Use `sources/` for immutable raw evidence.
- Use `knowledge/` for evolving markdown pages that Atlas maintains over time.
- Use `_atlas.md`, `_client.md`, and `_project.md` as concise stable orientation and graph connector files, not as live-state rollups or the whole knowledge layer.
- Use `_index.md` as the first navigation file for project retrieval.
- Use `_log.md` as the append-only record of ingests, queries, and maintenance.
- Prefer traceability when possible: if a raw source exists, store it and reference it.
- Create source-centered evidence pages for substantial single-source ingests when useful. Create topic-centered maintained knowledge objects only when real evidence justifies them, usually at least 2 meaningful sources or an explicit user request.
- When new evidence affects an existing maintained knowledge object, update that object as part of ingest.
- When linking, always use markdown links.

### Project resolution

Before reading or writing within Atlas:

1. Resolve the narrowest client and project scope that can satisfy the request.
2. For project work, read `_client.md`, then `_project.md`, then `_state.md`, then `_index.md` if it exists.
3. Read last 5 `_log.md` entries for historical context.

## References

Read these references as needed:

- `_atlas.md` contract: [references/file-atlas.md](references/file-atlas.md)
- `_client.md` contract: [references/file-client.md](references/file-client.md)
- `_project.md` contract: [references/file-project.md](references/file-project.md)
- `_state.md` contract: [references/file-state.md](references/file-state.md)
- `_index.md` contract: [references/file-index.md](references/file-index.md)
- `_log.md` contract: [references/file-log.md](references/file-log.md)
- knowledge-page contract: [references/knowledge-pages.md](references/knowledge-pages.md)
- `conversation` page type: [references/type-conversation.md](references/type-conversation.md)
