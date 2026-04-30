# `_project.md`

`_project.md` is the stable context file at the project level. It is the boot file for new conversations. It holds enduring project orientation — background, constraints, key actors, scope boundaries, and standing decisions — and links to the other project system files.

`_state.md` owns the live operating picture. `_index.md` owns the exhaustive page list. `_log.md` owns the append-only timeline.

## Backlinking

- Must link to `_state.md`, `_index.md`, and `_log.md`.

## Shape

- `# {Project Name} Context`
- `## Context` — stable project background, constraints, key actors, scope boundaries, and standing decisions.
- `## State` — links to `[_state](_state.md)`.
- `## Index` — links to `[_index](_index.md)`.
- `## Log` — links to `[_log](_log.md)`.

## Content rules

- Keep `_project.md` enduring. `## Context` must only contain stable project orientation.
- Do not write todos, blockers, active work status, active owners, or near-term next steps into `_project.md`. Those are operational updates — write them to `_state.md`.
- If a fact changes often (weekly or faster), it belongs in `_state.md`, not here.
- Keep entries terse. Deeper context belongs in `knowledge/` or `sources/`, linked from here when useful.
