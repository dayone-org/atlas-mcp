# `_state.md`

`_state.md` is the live operating picture at the project level. It holds the current operational state — active work, blockers, owners, and near-term next steps — and is the destination for operational updates.

`_state.md` is evolving, not append-only: stale items should be removed or rewritten as the project moves. `_log.md` owns the chronological record of changes; `_state.md` owns only what is true right now.

`_state.md` should read like a current handover, not a historical dump.

## Backlinking

- Must link back to `_project.md` and to `_log.md`.

## Shape

- `# {Project Name} State`
- short orienting paragraph is optional
- one or more topical groupings that reflect how the project is actually being run (for example: active workstreams, blockers, owners, upcoming milestones)
- `## Project` — links to `[_project](_project.md)`.
- `## Log` — links to `[_log](_log.md)`.

## Content rules

- Keep the section groupings that already exist; do not impose rigid sub-sections.
- When an operational update arrives, merge it into the most fitting group rather than creating a new group by default.
- Todo items and action tasks must always use the exact format `- [ ] (Owner) Task`, matching the convention in [type-conversation.md](type-conversation.md#recommended-shape).
- If no owner is provided, use `(Unassigned)`. Do not infer an owner from context unless the source explicitly states one.
- Keep entries terse. Deeper context belongs in `knowledge/` or `sources/`, linked from here when useful.
- Prune or rewrite stale items instead of letting them accumulate — `_log.md` preserves the history.
- Do not put enduring project context (background, constraints, standing decisions) here. That belongs in `_project.md`.

## Lint expectations

Lint should flag at least:

- ownerless tasks
- stale next steps
- blockers contradicted by newer knowledge
- background or enduring context that leaked into `_state.md`
