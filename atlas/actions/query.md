# Action: Query

Use query when the request is read-only.

Query must not write files.

## Scope resolution

Resolve the narrowest scope that can answer the question:

1. `project`
   Read `_project.md`, then `_state.md`, then `_index.md`, then relevant `knowledge/` pages, and consult `sources/` only when needed.

2. `client`
   Read `_client.md`, then search across that client's projects. For current-state questions, read the relevant project `_state.md` files.

3. `global`
   Read `_atlas.md`, then widen into clients and projects only as needed. For current-state questions, widen to the relevant project `_state.md` files.

Widen scope only if:
- the answer is missing at the current scope
- the user explicitly asks for comparison across projects or clients

## Reading workflow

1. Resolve scope first.
2. Start with the relevant context file (`_project.md`, `_client.md`, or `_atlas.md`).
3. For project scope, read `_state.md` for the current operating picture, then `_index.md` before opening individual knowledge pages.
4. For client or global current-state questions, collect current operating details from project `_state.md` files rather than from `_client.md` or `_atlas.md`.
5. Open the pages most likely to answer the question.
6. Consult `_log.md` when history, recency, evolution, or maintenance context may affect the answer.
7. Consult `sources/` only when the original artifact, a quote, or higher-fidelity evidence is needed.
8. Stop reading once the answer is well-supported.

## Query rules

- Treat the context file (`_project.md`, `_client.md`, or `_atlas.md`) as the first orientation layer for stable context.
- Treat `_state.md` as the first orientation layer for the current operating picture at the project level.
- Do not expect `_atlas.md` or `_client.md` to contain current project operating details; they are stable context and graph connectors.
- Treat `_index.md` as the primary navigation surface.
- Treat maintained knowledge objects as the default synthesis answer surface.
- Use evidence pages, page provenance, and source references to verify claims when needed.
- Use internal links as signals for where to drill in next.
- Make clear when a conclusion is inferred from multiple files rather than stated directly.
- Do not treat missing structure as evidence.

If a useful answer should become durable project knowledge, suggest ingesting it, but do not write anything unless the user explicitly asks.
