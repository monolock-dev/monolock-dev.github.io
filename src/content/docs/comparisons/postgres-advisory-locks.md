---
title: "monolock vs PostgreSQL advisory locks"
description: PostgreSQL advisory locks (pg_advisory_lock) as a distributed lock vs monolock — session vs connection ownership, PgBouncer pitfalls, dead-client detection, FIFO fairness, and fencing tokens.
---

PostgreSQL advisory locks are the closest architectural relative monolock has:
a single coordination point, no consensus, and ownership that dies with a
connection. If you already run Postgres and your locking needs are modest,
advisory locks are a perfectly good answer with zero new infrastructure. A
separate lock server earns its place when you need string-named locks,
per-lock failure detection measured in your own milliseconds, fair queues, and
fencing tokens — none of which advisory locks provide.

## Background

Advisory locks have been in PostgreSQL since 8.2 (2006), when a new locking
API replaced the old `contrib/userlock` module. The idea is older than most
dedicated lock services: Postgres already has a battle-tested lock manager for
rows and tables, so it exposes a corner of it for locks whose meaning the
database does not know or care about — "advisory" because it is entirely up to
the application to honor them.

That heritage explains both their strength and their shape. The strength is
that they cost nothing to adopt: no new daemon, no new port, no new failure
mode. The famous argument — *you already run Postgres* — is genuinely strong
here, because a lock is a small, transient thing that fits the lock manager
perfectly. For a nightly job that must not run twice,
`SELECT pg_try_advisory_lock(42)` is often the whole solution.

The shape is that everything about them is inherited from the database rather
than designed for distributed mutual exclusion. Locks are identified by
numbers because the lock manager keys on fixed-size structs. Ownership follows
the database session because that is the unit the backend tracks. Dead-client
detection is whatever the TCP stack under the backend does. None of this is
wrong — it is exactly what "reuse the lock manager" buys — but each inherited
trait becomes a sharp edge once advisory locks are asked to coordinate a fleet
of machines rather than a couple of app servers.

The best-known sharp edge involves connection poolers. Session-level advisory
locks belong to a *server* session, but under PgBouncer's transaction pooling
a client's statements are spread across server connections — so the lock you
took and the connection you are now talking on can silently be different
sessions. PgBouncer's own feature matrix marks session-level advisory locks as
**Never** working in transaction pooling mode — a well-documented footgun,
since transaction pooling is the mode most people deploy PgBouncer in. The fix
is transaction-level locks, which hold only as long as a transaction does.

So the honest framing is not "advisory locks are a lesser lock service." They
are a free, solid lock primitive with database-shaped semantics. The question
this page answers is what you get — and what you give up — by running a
purpose-built lock server next to a database you already trust.

## How PostgreSQL implements advisory locking

A lock is an entry in the server's shared-memory lock table, identified by an
application-chosen key: a single `bigint`, or a pair of `int4` values. There
are **no string names**. If your locks have names, you hash them into the key
space yourself, and two names hashing to the same 64 bits silently become the
same lock — the collision is your problem, not the server's.

Ownership comes in two scopes:

- **Session-level** (`pg_advisory_lock`, `pg_try_advisory_lock`): held until
  explicitly unlocked or the session ends. These locks deliberately ignore
  transaction semantics — a lock taken inside a transaction survives its
  rollback. Requests also *stack*: lock the same key three times and you must
  unlock it three times. `pg_advisory_unlock_all` releases everything, and the
  server invokes it implicitly at session end, even on an ungraceful
  disconnect — so a dead connection does release its locks, once the server
  notices the connection is dead.
- **Transaction-level** (`pg_advisory_xact_lock`): released automatically at
  transaction end, no manual unlock exists. The docs recommend this for
  short-term use, and it is the only scope that is safe behind a
  transaction-pooling PgBouncer.

**Dead-holder detection** is where the inherited shape shows most. There is no
lease and no heartbeat protocol: a lock is freed when its session ends, and a
session with a vanished client ends only when the server notices. The manual
is explicit that the server detects a lost connection "only at the next
interaction with the socket" — and a backend blocked waiting for the next
query does not interact with the socket. What closes the gap is TCP-level
plumbing: `tcp_keepalives_idle` / `_interval` / `_count` and
`tcp_user_timeout`, all defaulting to the operating system's values (a Linux
default keepalive starts probing after two hours of idleness), plus
`idle_session_timeout` as a blunt application-level backstop — with its own
documented warning about surprising poolers. All of these are server-wide
knobs. Detection latency for a dead lock holder is a TCP tuning question
answered once for every connection to the database, not a per-lock decision.

**Waiting**: `pg_advisory_lock` blocks until the lock is granted, and the
blocked call returning *is* the notification — there is no separate push
channel. The `try` variants return immediately. As for who gets the lock next,
the manual documents blocking behavior but makes **no promise about the order
in which waiters are granted** — there is no documented FIFO fairness across
sessions for advisory locks.

**Fencing tokens**: none. A grant returns `void` (or a boolean for the `try`
variants); nothing distinguishes this grant from the previous one, so a
resource cannot tell a stale holder's write from the current holder's.

Two capacity facts round out the picture. Advisory locks live in a
shared-memory pool sized by `max_locks_per_transaction × max_connections`,
which caps total locks "typically in the tens to hundreds of thousands." And
every *held* session-level lock requires a live database session — one backend
process out of the finite `max_connections` pool, sitting mostly idle for as
long as the lock is held. Backends are expensive, which is exactly why
databases ration them; long-held locks spend that scarce resource on waiting.

## How monolock differs

The models rhyme — ownership dies with a connection in both — so the
differences are pointed rather than philosophical:

- **Names, not numbers.** monolock locks are raw UTF-8 strings up to 255
  bytes. There is no client-side hashing step and no collision risk to reason
  about.
- **The connection is the claim — with a lease on top.** Postgres frees an
  ungracefully dead session's locks *once it notices*; how fast is a
  server-wide TCP question. In monolock every session picks its own lease in
  `ACQUIRE`, heartbeats on an RTT-aware schedule derived from it, and a dead
  holder is detected within that lease — milliseconds on a LAN if you ask for
  that — per connection, no server tuning involved. See
  [how it works](/concepts/how-it-works/).
- **Strict FIFO with push promotion.** Waiters are promoted in arrival order,
  and the server sends `ACQUIRED` on its own initiative the moment the
  previous owner is gone — handover is one one-way trip. Postgres offers a
  blocked call with unspecified ordering.
- **Fencing tokens on every grant.** Each monolock grant carries a
  monotonically increasing `uint64` so the guarded resource can reject stale
  writers ([fencing tokens](/concepts/fencing-tokens/)). Advisory locks have
  no equivalent; a paused holder that wakes up after losing its session writes
  unchallenged.
- **A lock costs a TCP connection, not a database backend.** monolock sessions
  are cheap goroutine-backed connections, bounded by
  [system resources](/concepts/capacity/) rather than a `max_connections`
  budget shared with your queries.
- **What monolock does *not* add: availability.** Neither system replicates
  lock state. Advisory locks live in the primary's shared memory and are gone
  after a failover; monolock is openly a single point of coordination — when
  it is down, no new locks are granted (
  [what monolock is not](/start/introduction/#what-monolock-is-not)). Postgres
  does bring mature durability and HA machinery for your *data*, and reusing
  it means one less process to run; monolock is one more binary, however
  small.

## Side by side

| | monolock | PostgreSQL advisory locks |
| --- | --- | --- |
| Ownership model | one TCP connection = one claim | database session (or transaction) holds an `int8`/two-`int4` key |
| Dead-holder detection | silence for a client-chosen lease | session death, noticed via server-wide TCP keepalives / timeouts |
| Queue / fairness | strict FIFO | blocked callers; no documented grant order |
| Fencing tokens | on every grant, monotonically increasing | none |
| Handover latency | push; immediate on graceful exit, ≤ lease on crash | blocked call returns on grant; crash noticed at TCP-tuning granularity |
| Clock assumptions | monotonic durations only, no synchronized clocks | none for locking itself |
| Survives coordinator failure | no — single point of coordination | no — lock state is primary-only shared memory |
| Operational footprint | single static Go binary, stdlib only | a full PostgreSQL server (often already running) |
| Extra infra needed | one small server | none, if Postgres is already there |

## When to choose PostgreSQL advisory locks

- You already run Postgres and your locking needs are a handful of mutexes for
  jobs and migrations — zero new infrastructure is a real, decisive advantage.
- The lock guards work done *in that same database*: `pg_advisory_xact_lock`
  inside the transaction ties the lock's life to the work's life exactly.
- Your clients connect to Postgres directly or through session pooling, so the
  session-ownership model holds without caveats.
- Minutes-grade dead-holder detection is fine, or you already tune TCP
  keepalives fleet-wide anyway.
- You value that the primitive is 20 years old, exhaustively documented, and
  operated by every DBA on earth.

## When to choose monolock

- Locks are named after tenants, shards, or resources — real strings, many of
  them — and hashing into 64 bits with silent collisions is not acceptable.
- You need fast, per-lock failure detection: a deploy mutex or leader election
  where a crashed holder must be replaced in seconds, chosen by the client
  that knows its own network, not by a database-wide TCP setting.
- Waiters must be served fairly and promoted instantly — cron-style jobs and
  deploy queues where starvation or a thundering herd matters.
- The guarded resource lives *outside* the database, so you want
  [fencing tokens](/concepts/fencing-tokens/) to make stale writers reject
  themselves.
- Long-held locks would otherwise pin scarce Postgres backends, or your
  connection path runs through transaction-pooling PgBouncer where
  session-level advisory locks simply do not work.

## Sources

- [PostgreSQL: Explicit Locking — §13.3.5 Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL: System Administration Functions — §9.28.10 Advisory Lock Functions](https://www.postgresql.org/docs/current/functions-admin.html)
- [PostgreSQL: Connection Settings — TCP keepalives and `tcp_user_timeout`](https://www.postgresql.org/docs/current/runtime-config-connection.html)
- [PostgreSQL: Client Connection Defaults — `idle_session_timeout`](https://www.postgresql.org/docs/current/runtime-config-client.html)
- [PostgreSQL 8.2 release notes — advisory locking replaces `contrib/userlock`](https://www.postgresql.org/docs/release/8.2.0/)
- [PgBouncer features — pooling modes and session-state compatibility matrix](https://www.pgbouncer.org/features.html)
