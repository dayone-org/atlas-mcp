# `_log.md`

`_log.md` is chronological. It is an append-only record of what happened and when.

## Rules

- `# <Project Name> Log`
- append-only
- one entry per meaningful operation
- each entry starts with:
  - `## [YYYY-MM-DD] <action> | <label>`
- keep the body as a short paragraph, not a rigid field template
- mention knowledge pages, source files, and `_project.md` only when useful
- newest entries must be appended at the end
- never insert new entries at the top or reorder existing entries
- the heading format should stay parseable with simple tools such as:
  - `grep "^## \\[" _log.md | tail -5`
