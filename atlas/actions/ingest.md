# Action: Ingest

Use ingest when the request wants Atlas to write, refine, capture, correct, or save project knowledge — whether that is a durable artifact or a short operational update to the current project state.

## Input classification

Classify every input before running the workflow. A single request may carry both kinds and should be handled in both branches.

- **Source input** — a file, artifact, or longer-form knowledge that belongs in `sources/` or `knowledge/`. Examples: meeting transcripts, decks, reports, or updates to an existing knowledge page.
- **Operational update** — a short, stateful change to how the project is being run right now. Examples: a new todo, a new blocker, an owner change, a near-term next step, a status shift.

If classification is ambiguous, ask the user before writing.

## Workflow — source input

1. Resolve the target client and project.
2. Read `_client.md`, `_project.md`, `_state.md`, and `_index.md` for the target project.
3. Inspect existing knowledge pages before creating a new one.
4. For each input file or source artifact, decide whether to update an evidence page, a maintained knowledge object, or both.
5. Extract the source artifact into working markdown when needed. Prefer `[../scripts/extract_to_markdown.py](../scripts/extract_to_markdown.py)` for supported document formats.
6. Review the extracted content and decide whether it is good enough to support a real knowledge update.
7. Store the exact source artifact in `sources/` when appropriate.
8. Create or update the relevant page or pages in `knowledge/`.
9. Refresh `_index.md` if the catalog changed.
10. Refresh `_state.md` if the operational picture changed, including unresolved operational signal found in the source.
11. Refresh `_project.md` only if a stable fact (background, constraint, key actor, scope boundary, standing decision) changed.
12. Update `_client.md` or `_atlas.md` only if the change materially affects that layer.
13. Append an entry to the end of `_log.md` describing the final set of changes.

## Workflow — operational update

1. Resolve the target client and project.
2. Read `_project.md`, `_state.md`, and the last 5 `_log.md` entries for context.
3. Update `_state.md` with the new item, following the [`_state.md` contract](../references/file-state.md).
4. Update `_client.md` or `_atlas.md` only if the change materially affects that layer.
5. Append an entry to the end of `_log.md` describing the final set of changes.
6. Do not create or update `sources/`, `knowledge/`, `_index.md`, or `_project.md` for an operational update.

## Decision workflow (source input)

For each source input, make these decisions in order:

1. Evidence page or maintained knowledge object?
  - For a substantial bounded source, create or update a source-centered evidence page when the source is useful in its own right.
  - Update an existing maintained knowledge object when the new evidence materially changes durable project understanding.
  - Create a new topic-centered maintained knowledge object only when the threshold below is met.
2. Exact source artifact available or not?
  - If yes, store it in `sources/`.
  - If no, write the knowledge page with explicit provenance.
3. Operational state changed or not?
  - If the source contains todos, blockers, owner changes, active work, or near-term next steps that are not explicitly resolved or clearly obsolete, refresh `_state.md`.
  - Do not skip `_state.md` only because the source is a historical export; unresolved operational signal still belongs in the live operating picture.
  - If no current operational signal is present, leave `_state.md` unchanged.
4. Stable project context changed or not?
  - If yes, refresh `_project.md`.
  - If no, leave `_project.md` unchanged.

## Ingest contract

Ingest must change durable project state.

Source inputs:

- every input file or source artifact must result in at least one knowledge page being created or updated
- storing a source artifact in `sources/` alone is not a successful ingest
- successful parsing or conversion is not, by itself, a successful ingest
- unresolved todos, blockers, owner changes, active work, or near-term next steps found in a source input must be reflected in `_state.md`
- if extraction cannot produce enough usable content to update `knowledge/`, alert the user explicitly

Operational updates:

- every operational update must result in `_state.md` being updated
- when an operational update is a todo or action task, write it exactly as `- [ ] (Owner) Task`
- when no owner is provided for a todo or action task, write `(Unassigned)` and do not infer an owner
- appending to `_log.md` alone is not a successful operational update
- appending to `_log.md` means adding the newest entry after all existing entries; never insert a new entry at the top
- operational updates do not require a knowledge page or a source artifact
- do not write operational updates into `_project.md` — that file holds stable context only

General:

- if one or more inputs could not be ingested, report the ingest as partial or incomplete
- name the specific inputs that could not be ingested
- append `_log.md` only after the other writes are complete, so the log entry reflects the final state of the ingest

Default extraction behavior (source inputs only):

- for `.pdf`, `.docx`, `.pptx`, `.xlsx`, and similar supported formats, prefer `extract_to_markdown.py`
- `extract_to_markdown.py` requires the `markitdown` Python package; if the dependency is unavailable, use another reliable extraction path or report that extraction is blocked
- treat the extracted markdown as working material for the knowledge page
- only proceed when the extracted content is good enough to support a real knowledge update
- if extraction is weak, incomplete, empty, or obviously low-signal, do not silently continue to `sources/`-only storage

## Source artifact storage

- Store exact raw artifacts under `sources/`.
- Use kebab-case filenames, preserve the original extension, and include the source date only when it is inherent to the artifact or useful for disambiguation.
- If the source has no filename, derive one from the source date when known and a short source label, such as `2026-04-05-kickoff-call-transcript.md`.
- Do not overwrite an existing source file unless it is clearly the same artifact. If a filename collides with different content, add a short disambiguator or numeric suffix.
- Reference every stored source artifact from at least one knowledge page.

## Page selection rules

- Prefer updating an existing page when the new material clearly belongs there.
- Prefer updating an existing page over creating a near-duplicate.
- Use source-centered evidence pages for substantial single-source ingests. Typical examples:
  - kickoff call transcript -> `conversation`
  - workshop notes -> `conversation`
  - research deck -> `report`
  - interview synthesis -> `research`
- Treat `conversation`, `report`, and `research` pages as evidence capture surfaces. They preserve provenance, structure, and first-pass synthesis; they are not the whole maintained knowledge model.
- Treat `topic` and `decision` pages as maintained knowledge objects. These are the durable synthesis pages where cross-source understanding should accumulate.
- Update affected maintained knowledge objects when new evidence materially changes them.
- Create a new `topic` page only when at least 2 meaningful sources contribute to the same area, or when the user explicitly requests a durable topic page.
- Create a new `decision` page when a decision is durable enough to maintain over time and does not already have a clear home.
- Do not create placeholder pages speculatively.

Filename guidance:

- use kebab-case
- name pages for the thing being tracked
- avoid date-prefixed filenames unless the page is inherently date-bound or a collision must be resolved

## Specialized page references

- For meetings, calls, workshops, interviews, and thread-based exchanges, use [../references/type-conversation.md](../references/type-conversation.md).
- For everything else, follow the generic [../references/knowledge-pages.md](../references/knowledge-pages.md) contract and let the source and project needs determine the page shape.

## Completion checks

Before finishing:

- every source input resulted in at least one knowledge page creation or update
- every source artifact stored in `sources/` is referenced by at least one knowledge page
- unresolved operational signal from source inputs is reflected in `_state.md`, or explicitly identified as resolved/obsolete before leaving `_state.md` unchanged
- every operational update is reflected in `_state.md`
- `_index.md` reflects the current knowledge pages (source-input branch only)
- `_log.md` includes the operation as the newest entry at the end
- written files agree with each other
- any input that could not be ingested is explicitly called out to the user

If any input did not lead to its expected write, ingest is incomplete.
