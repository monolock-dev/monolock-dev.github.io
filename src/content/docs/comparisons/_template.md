# Comparison article template

This file is not published (underscore prefix — Astro content collections
skip it). It is the authoring guide for each `comparisons/*.md` page. Follow
the structure and the language rules exactly, so that the articles stay
consistent and comparable.

## Language: Simplified Technical English

All articles use ASD-STE100 Simplified Technical English:

- Sentences of 20–25 words maximum. One idea per sentence.
- Active voice. Present tense where possible. No contractions.
- No idioms, no metaphors, no colloquialisms. Prefer a simple verb over a
  phrasal verb.
- House vocabulary: "select" (not choose/pick), "occur" (not happen),
  "subsequent" (not next-in-sequence), "examine" (not check/inspect),
  "satisfactory", "necessary", "not possible" (not can't), "immediately",
  "the correct selection".
- Technical terms and proper nouns are exempt from the vocabulary rules
  (for example "fencing token", "keep-alive", "transaction pooling").
- Keep direct quotations from external documentation verbatim, in quotes.

## Tone

- Calm, honest, zero marketing. State the trade-offs openly. monolock loses
  some rows on purpose — say so plainly.
- **No straw men.** Describe the competitor at its best, in the way that its
  own documentation recommends. If a common misuse exists, describe it as a
  misuse, not as the baseline.
- Facts about the competitor must come from primary sources: their
  documentation, papers, or the posts of the authors. Verify with web search
  while you write. Do not rely on memory. Each claim that a reader can
  dispute gets a link in Sources.
- Link to the monolock pages with root-relative paths:
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

2–3 sentences directly under the frontmatter: the core difference in the
model, and who must select which tool. Write it for the reader who reads
nothing else.

### `## Background`

The story. Where the locking of <X> comes from, its design goal, and the
known discussions or lessons attached to it (for example the
Kleppmann–antirez Redlock discussion, the Chubby ancestry of ZooKeeper,
"you already operate Postgres"). This section gives the article its
character — 3–6 paragraphs, narrative, with sources.

### `## How <X> makes a lock`

An honest technical description of the competitor, in its best-practice
usage. Use bold lead-ins per paragraph, for example: **The key.**
**Detection of a dead holder.** **The wait procedure.** **Fencing.** Cover:

- the ownership model (what a lock *is*: a key with a TTL, a session, a
  row, an ephemeral node…)
- how a lease or TTL is extended, and by whom
- how the system detects a dead holder, and how fast
- whether the waiters go into a queue, and in what sequence
- whether a fencing token or an equivalent exists, and whether its
  application is automatic or the task of the user

### `## How monolock is different`

Only the points of divergence with *this* competitor — not a repetition of
the full documentation. Link out for details. Typical points:
connection-scoped ownership (no release command that you can forget),
client-selected leases with RTT-aware heartbeats, strict FIFO with push
promotion, fencing tokens with each grant, monotonic time only, the
single-binary footprint, and the honest disadvantage: no replication — when
the server is down, new acquisitions are not possible
(`/start/introduction/#what-monolock-is-not`). Where the disadvantage
appears, also mention that a passive standby shortens the gap without a
change to the trade (`/operations/high-availability/`).

When the article mentions the fencing-token guarantee of monolock, keep the
honest framing: the guarantee across restarts has documented conditions
(`/concepts/fencing-tokens/#the-guarantees-bounds`), the probability of a
failure is near zero, and the event that breaks it (a clock step to an
earlier time around a restart) is a problem for the full system, not only
for the lock.

### `## Side by side`

Fixed rows, in the same sequence in each article, so that readers can
compare the articles with each other. Keep the cell text short; the nuance
goes in the prose above.

| | monolock | <X> |
| --- | --- | --- |
| Ownership model | one TCP connection = one claim | … |
| Detection of a dead holder | silence for a client-selected lease | … |
| Queue / fairness | strict FIFO | … |
| Fencing tokens | with each grant, the number always increases | … |
| Handover latency | push; immediate after a controlled stop, ≤ one lease after a crash | … |
| Clock assumptions | monotonic durations only, no synchronized clocks | … |
| Operation continues after a coordinator failure | no — a [standby](/operations/high-availability/) shortens the gap, the state is lost | … |
| Operational footprint | one static Go binary, stdlib only | … |
| New infrastructure | one small server | … |

### `## When <X> is the correct selection`

An honest bulleted list. This section is mandatory. It must contain real
reasons, not token ones — it makes the full article trustworthy.

### `## When monolock is the correct selection`

The same format. Base it on the real target use cases: cron-style jobs,
deploy mutexes, and leader election that accepts a short coordination gap.

### `## Sources`

Bulleted links to the primary sources that the sections above use.
