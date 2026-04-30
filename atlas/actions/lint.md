# Action: Lint

Use lint when the request wants Atlas to maintain, normalize, or health-check a project knowledge layer.

Lint is project-scoped by default because the project is Atlas’s primary knowledge boundary.

## Lint modes

- **Report-only mode**: Use for audit, health-check, review, check, or "what is wrong" requests. Do not write files or append `_log.md`; report findings and suggested fixes.
- **Repair mode**: Use when the user asks to lint, maintain, normalize, repair, fix, clean up, or otherwise clearly permits maintenance writes. Apply low-risk fixes and append `_log.md`.
- If write intent is unclear, ask before modifying files.

## Workflow

1. Resolve the target project or project set.
2. Read `_project.md`, `_state.md`, `_index.md`, and the contents of `knowledge/`. Catalog `sources/` filenames, and inspect source contents only when needed to verify provenance, contradictions, or source-backed claims.
3. For multi-project lint, also read the relevant `_client.md` files and `_atlas.md`.
4. Check structural integrity:
   - expected system files exist
   - expected context file links exist (`_atlas.md`, `_client.md`, `_project.md`)
   - `_atlas.md` and `_client.md` follow their reference contracts
   - `_project.md` links to `_state.md`, `_index.md`, and `_log.md`
   - `_index.md` has required `## Core Pages` and `## Knowledge Pages` sections
   - `_index.md` matches actual knowledge pages
   - source references resolve
   - internal Markdown knowledge links resolve
5. Check knowledge-layer health:
   - orphan pages
   - duplicate or near-duplicate pages
   - weak or missing cross-links
   - `_project.md` drift against maintained knowledge
   - `_state.md` drift — ownerless tasks, stale next steps, resolved blockers, blockers contradicted by newer knowledge, old owners, superseded next steps
   - operational items leaking into `_project.md` that should have been written to `_state.md`
   - background or enduring context leaking into `_state.md` that should have been written to `_project.md` or `knowledge/`
   - knowledge page type drift, especially near-synonyms for preferred or already-used page types
   - stale or superseded claims
   - contradictions between pages
   - missing provenance where traceability should exist
6. In repair mode, apply low-risk fixes directly. In report-only mode, list the fixes that would be safe to apply.
7. Flag high-risk semantic issues instead of silently rewriting them.
8. In repair mode, append a lint entry to `_log.md` after all fixes are complete. In report-only mode, do not append `_log.md`.
9. Report what changed, what remains unresolved, and any suggested next steps.

## Safe fixes

Apply these low-risk fixes during repair-mode lint:

- create `_index.md` if it is missing and the project already has knowledge pages
- create `_state.md` if it is missing and operational state needs a home
- create `_log.md` if it is missing and the lint pass needs to be recorded
- refresh `_index.md` so it has the required sections and matches actual project pages
- add missing `_index.md` entries
- remove dead `_index.md` entries
- add missing downward context file links when the intended target is clear and within scope
- repair obvious broken Markdown knowledge links when there is one clear target
- normalize provenance when a page already clearly cites a source file
- normalize knowledge page types when a near-synonym clearly maps to a preferred or already-used type without changing page meaning
- refresh `_project.md` when stable context is clearly out of sync with maintained knowledge
- refresh `_state.md` when the current operating picture is clearly out of sync with recent `_log.md` entries or maintained knowledge
- move operational items out of `_project.md` into `_state.md` when they were written to the wrong file
- append the lint pass to `_log.md`

## Flag instead of rewriting

Report these issues rather than resolve them aggressively:

- contradictory claims where source priority is unclear
- ambiguous page merges or splits
- major taxonomy changes
- speculative creation of new synthesis pages
- unclear authorship or provenance
- cases where a semantic rewrite would change meaning rather than maintain structure

Do not delete knowledge pages just because they look redundant. Flag likely duplicates unless one is clearly obsolete and empty.

## Completion checks

Before finishing:
- confirm which project or projects were linted
- state whether the pass made edits or only produced findings
- in repair mode, make sure `_index.md`, `_project.md`, `_state.md`, and `_log.md` agree with the current knowledge state after safe fixes
- in report-only mode, report any disagreement among `_index.md`, `_project.md`, `_state.md`, and `_log.md`
- make sure structural fixes were low-risk and justified
- if report-only mode was used, confirm that no files were modified
- call out unresolved semantic issues explicitly
- suggest ingest only when the gap cannot be solved through maintenance alone
