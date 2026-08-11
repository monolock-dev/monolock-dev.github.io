# Comparison article template

This file is not published (underscore prefix — Astro content collections skip
it). It is the authoring guide for every `comparisons/*.md` page. Follow the
structure and tone exactly so the articles stay consistent and comparable.

## Tone & style

- Calm, honest, zero marketing. Same voice as `/start/introduction/` and
  `/concepts/how-it-works/`: technical, plain sentences, trade-offs stated
  openly. monolock loses some rows on purpose — say so plainly.
- **No straw men.** Describe the competitor at its best, the way its own
  documentation recommends using it. If a common misuse exists, mention it as
  a misuse, not as the baseline.
- Facts about the competitor must come from primary sources (their docs,
  papers, the authors' own posts) — verify with web search while writing, do
  not rely on memory. Every claim that could be disputed gets a link in
  Sources.
- Link to existing monolock pages with root-relative paths:
  `/concepts/how-it-works/`, `/concepts/fencing-tokens/`,
  `/operations/deployment/`, etc. Do not restate their content at length.
- Length target: 1200–1800 words. English only.

## Frontmatter

```yaml
---
title: "monolock vs <X>"
description: <one sentence with the search phrases a person comparing these
  two systems would actually type — e.g. "distributed lock", "<X> lock",
  "Redlock alternative">
---
```

## Structure (sections in this exact order)

### (no heading) — TL;DR

2–3 sentences right under the frontmatter: the core difference in model, and
who should pick which. Written for the reader who reads nothing else.

### `## Background`

The story. Where <X>'s locking comes from, what it was designed for, and any
well-known debates or lessons attached to it (e.g. the Kleppmann–antirez
Redlock debate, ZooKeeper's Chubby ancestry, "you already run Postgres").
This is the section that gives the article character — 3–6 paragraphs,
narrative, with sources.

### `## How <X> implements locking`

Honest technical description of the competitor, best-practice usage:

- ownership model (what *is* a lock: a key with TTL, a session, a row, an
  ephemeral node…)
- how a lease/TTL is extended and by whom
- how a dead holder is detected, and how fast
- whether waiters queue, and in what order
- whether anything like a fencing token exists, and whether applying it is
  automatic or the user's job

### `## How monolock differs`

Only the points of divergence with *this* competitor — not a retelling of the
whole docs. Link out for details. Typical anchors: connection-scoped
ownership (no release command to forget), client-chosen leases with
RTT-aware heartbeats, FIFO queue with push promotion, fencing tokens on
every grant, monotonic-time-only design, single-binary footprint, and the
honest downside: no replication — a down server means no new acquisitions
(`/start/introduction/`).

### `## Side by side`

Fixed rows, same order in every article, so readers can compare articles
with each other. Keep cell text short; nuance goes in the prose above.

| | monolock | <X> |
| --- | --- | --- |
| Ownership model | one TCP connection = one claim | … |
| Dead-holder detection | silence for a client-chosen lease | … |
| Queue / fairness | strict FIFO | … |
| Fencing tokens | on every grant, monotonically increasing | … |
| Handover latency | push; immediate on graceful exit, ≤ lease on crash | … |
| Clock assumptions | monotonic durations only, no synchronized clocks | … |
| Survives coordinator failure | no — single point of coordination | … |
| Operational footprint | single static Go binary, stdlib only | … |
| Extra infra needed | one small server | … |

### `## When to choose <X>`

An honest bulleted list. This section is mandatory and must contain real
reasons, not token ones — it is what makes the whole section trustworthy.

### `## When to choose monolock`

Same format. Ground it in the actual target use cases: cron-style jobs,
deploy mutexes, leader election that tolerates a brief coordination gap.

### `## Sources`

Bulleted links to primary sources used above.
