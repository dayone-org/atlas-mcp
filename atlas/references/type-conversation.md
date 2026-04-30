# Knowledge Page Type: Conversation

Use this reference when the knowledge page is a `conversation` evidence page.

Typical inputs:

- meeting notes
- call transcripts
- workshop captures
- interviews
- thread-based discussions

## Core Rule

- Keep it faithful to what was discussed, decided, blocked, or left open.
- Prefer a scan-first structure that makes action items, key outcomes, and topic-by-topic discussion easy to recover later.

## Recommended Shape

- frontmatter with `type`, `summary`, and backlinks when available
- `# Conversation Title`
- short orienting paragraph
- `## Action Items`
- `## Overview`
- `## <Topic Section>`
- `## References`

Default expectations:

- In `## Action Items`, capture one item per owner and task with the person and the task. Include dates only when they were explicit in the source.
- If conversation action items, blockers, owner changes, or near-term next steps appear unresolved and still relevant, update project `_state.md` as part of ingest. The conversation page preserves what was said; `_state.md` tracks what is still live.
- If no owner is provided for an action item, use `(Unassigned)`. Do not infer an owner unless the source explicitly states one.
- Action items must always use this exact format:
```
- [ ] (Owner) Task
- [ ] (Owner) Task
```
- In `## Overview`, capture the highest-signal outcomes, metrics, changes, blockers, and risks in a short bullet list.
- Use topic-based section headings from the actual meeting areas rather than generic `Discussion`.
- Keep decisions and open questions inside the relevant topic section unless a cross-cutting rollup is clearly more useful.
- In `## References`, link to source files or source context when available.

## Procedure

1. Preserve chronology when sequence matters.
2. Preserve explicit asks, decisions, blockers, owners, dates, metrics, and unresolved questions.
3. Capture topic or thread grouping when it carries meaning.
4. Put owner-assigned follow-ups in `## Action Items` rather than scattering them across sections.
5. Trim irrelevant chatter instead of summarizing around it.
6. Add links to related project pages when the conversation clearly affects them.
