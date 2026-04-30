# Knowledge-page

## Baseline contract

Project knowledge pages are flexible, but they should share a light contract:

- markdown only
- evolving, not append-only
- a clear page title
- light YAML frontmatter
- internal knowledge links such as `[other-page](other-page.md)` when relationships matter
- link to source files or source context when available

## Page roles

Atlas knowledge pages have two main roles:

- **Evidence pages** preserve and structure important bounded inputs. `conversation`, `report`, and `research` pages are the common evidence page types.
- **Maintained knowledge objects** hold durable synthesized understanding that should remain current over time. `topic` and `decision` pages are the common maintained knowledge object types.

Evidence pages keep provenance, source structure, and first-pass synthesis available. Maintained knowledge objects are the pages where cross-source understanding should accumulate as new evidence arrives.

## Frontmatter

Baseline frontmatter:

```yaml
---
type: conversation
summary: Kickoff call covering scope, owners, and early risks.
source_files:
  - sources/2026-04-05-kickoff-call-transcript.md
source_date: 2026-04-05
---
```

Recommended fields:

- `type`
- `summary`
- `source_files`
- `source_date`

Use `type` as a flexible string. Prefer this starter vocabulary:

- `conversation`
- `topic`
- `decision`
- `report`
- `research`
- `artifact`

Type normalization rules:

- Prefer existing types already used in the project.
- Avoid near-synonyms when a preferred type is close enough.
- Introduce a new type only when there is a clear structural reason.

Do not add unnecessary metadata.

## Path conventions

- In frontmatter, `source_files` entries are project-root-relative paths such as `sources/kickoff-call.md`.
- In Markdown body links, use paths relative to the file containing the link.
- From `knowledge/*.md`, link to source files as `[source](../sources/file.ext)`.
- From `knowledge/*.md`, link to sibling knowledge pages as `[other-page](other-page.md)`.
- In `_index.md`, link to knowledge pages from the project root as `[page-name](knowledge/page-name.md)`.

## Page creation modes

Use source-centered evidence pages when a substantial single source is useful in its own right:

- kickoff call transcript -> `conversation`
- workshop notes -> `conversation`
- research deck -> `report`
- interview synthesis -> `research`

Use topic-centered maintained knowledge objects when Atlas needs a durable synthesis surface:

- create a `topic` page only when at least 2 meaningful sources contribute to the same area, or when the user explicitly requests a durable topic page
- create a `decision` page when a decision is durable enough to maintain over time and does not already have a clear home
- update an existing maintained knowledge object whenever new evidence materially changes it

Do not create topic pages for single weak mentions or speculative clusters.

## Body expectations

Knowledge pages should usually include:

- a clear `# Title`
- a short orienting paragraph
- structured sections that fit the source or topic
- internal links to related pages when useful
- link to source files or source context when available

## Source-dense artifacts

For source-dense artifacts such as reports and slide decks, keep the primary summary in an evidence page and link to the raw artifact in `sources/`. If preserving an exact-parse is useful, append it to the knowledge page. If the artifact changes an existing maintained knowledge object, update that object too.
