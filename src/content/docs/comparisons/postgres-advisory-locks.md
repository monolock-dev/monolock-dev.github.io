---
title: "monolock vs PostgreSQL advisory locks"
description: PostgreSQL advisory locks (pg_advisory_lock) as a distributed lock vs monolock — session vs connection ownership, PgBouncer pitfalls, dead-client detection, FIFO fairness, and fencing tokens.
---

A PostgreSQL advisory lock is an entry in the lock table of the server. The
database session that takes the lock is the owner. The lock stops when the
session unlocks it or when the session ends. A monolock lock is a TCP
connection. When the connection closes, the server releases the lock.

The two designs are near relatives. Each has one coordination point, no
consensus, and ownership that ends with a connection. Possibly you operate
Postgres, and you need only some mutexes for jobs and migrations. Then
advisory locks are a good solution, and no new infrastructure is necessary.
But possibly you need string names, fast failure detection for each lock,
fair queues, and fencing tokens. Advisory locks do not have these functions.
monolock is made for this.

## Background

Advisory locks are a part of PostgreSQL since version 8.2 (2006). At that
time, a new locking API replaced the old `contrib/userlock` module. The idea
is simple. Postgres has a proven lock manager for rows and tables. It makes a
part of this lock manager available for locks of the application. The name
"advisory" tells you the rule. The application must obey the locks. The
database does not.

This heritage gives advisory locks their strength and their shape. The
strength: they cost nothing. No new daemon, no new port, and no new failure
mode are necessary. The argument "you already operate Postgres" is strong
here. For a nightly job that must not start two times,
`SELECT pg_try_advisory_lock(42)` is frequently the full solution.

The shape: each property comes from the database, not from a design for
distributed mutual exclusion. The keys are numbers, because the lock manager
uses structures with a fixed size. The owner is a database session, because
the backend monitors sessions. The detection of a dead client is the behavior
of the TCP stack. This is not incorrect. But each of these properties becomes
a risk when advisory locks must coordinate many machines.

The best-known risk is a connection pooler. A session-level advisory lock is
attached to a *server* session. But in the transaction pooling mode of
PgBouncer, the statements of one client go through different server
connections. Thus the session that holds your lock and the session that gets
your subsequent statements can be different. The feature matrix of PgBouncer
shows "Never" for session-level advisory locks in this mode. And transaction
pooling is the usual mode for PgBouncer. The solution is transaction-level
locks. These locks stay only for the duration of one transaction.

Thus the correct summary is not "advisory locks are a bad lock service".
They are a free and solid lock primitive with database semantics. This page
shows what you get, and what you lose, with a special lock server adjacent
to a database that you trust.

## How PostgreSQL makes a lock

**The key.** A lock is an entry in the lock table in the shared memory of
the server. The application selects the key: one `bigint` value, or two
`int4` values. There are **no string names**. If your locks have names, you
must hash the names into the key space yourself. Two names with the same
64-bit hash become the same lock, without a warning. This collision is your
problem, not a problem of the server.

**Session-level locks.** The functions `pg_advisory_lock` and
`pg_try_advisory_lock` make these locks. The lock stays until you unlock it
or until the session ends. These locks ignore transactions. A lock that you
take in a transaction stays after a rollback. The requests also add up. If
you lock the same key three times, you must unlock it three times. The
function `pg_advisory_unlock_all` releases all the locks of a session. The
server does this automatically at the end of a session, also after a
disconnect that is not controlled. Thus a dead connection releases its locks
— when the server sees that the connection is dead.

**Transaction-level locks.** The function `pg_advisory_xact_lock` makes
these locks. The server releases the lock at the end of the transaction. A
manual unlock is not possible. The documentation recommends this scope for
short use. It is also the only scope that is safe behind PgBouncer in
transaction pooling mode.

**Detection of a dead holder.** There is no lease and no heartbeat protocol.
A lock becomes free when its session ends. A session with a client that
disappeared ends only when the server sees the problem. The manual is clear.
The server finds a lost connection "only at the next interaction with the
socket". A backend that waits for the subsequent query does not interact
with the socket. TCP settings close this gap: `tcp_keepalives_idle`,
`tcp_keepalives_interval`, `tcp_keepalives_count`, and `tcp_user_timeout`.
Their default values come from the operating system. On Linux, the default
keepalive probes start after two hours without traffic. The setting
`idle_session_timeout` can also stop idle sessions. But its documentation
contains a warning about the effect on poolers. All these settings apply to
the full server. Thus the detection speed for a dead holder is a TCP
question with one answer for all connections, not a selection for each lock.

**The wait procedure.** The function `pg_advisory_lock` blocks until the
server gives the lock. The return of the blocked call is the notification.
There is no separate push channel. The `try` functions return immediately.
The manual gives **no promise about the sequence of the waiters**. There is
no documented FIFO fairness for advisory locks.

**Fencing.** There are no fencing tokens. A grant returns `void`, or a
boolean value for the `try` functions. Nothing makes one grant different
from the earlier grant. Thus a resource cannot know a stale holder from the
current holder.

**Capacity.** Advisory locks use a pool in shared memory. The size of the
pool is `max_locks_per_transaction × max_connections`. This limits the total
number of locks, usually to tens or hundreds of thousands. Also, each
session-level lock needs a live database session. This session is one
backend process from the limited `max_connections` pool. The backend is
mostly idle while the client holds the lock. Backends are expensive. This is
the reason why databases limit them. A lock with a long life spends this
limited resource on waiting.

## How monolock is different

The two models are similar. In each model, ownership ends with a connection.
Thus the differences are precise, not philosophical:

- **Names, not numbers.** monolock lock names are UTF-8 strings with a
  maximum length of 255 bytes. There is no hash step on the client, and
  there is no collision risk.
- **The connection is the claim, with a lease.** Postgres frees the locks of
  a dead session when it sees the problem. The speed is a server-wide TCP
  question. In monolock, each session selects its own lease in the `ACQUIRE`
  message. The client sends heartbeats on a schedule that includes the RTT.
  The server detects a dead holder in a maximum of one lease — milliseconds
  on a LAN, if you select that. Each connection makes this selection. No
  server tuning is necessary ([how it works](/concepts/how-it-works/)).
- **Strict FIFO with push promotion.** The server promotes the waiters in
  the sequence of their arrival. When the owner is gone, the server sends
  the `ACQUIRED` message immediately. The handover is one one-way message.
  Postgres has a blocked call without a specified sequence.
- **Fencing tokens with each grant.** Each monolock grant contains a
  `uint64` number that always increases. The resource can reject stale
  writers with one comparison
  ([fencing tokens](/concepts/fencing-tokens/)). Advisory locks have no
  equivalent function. A holder with a pause that lost its session writes
  without a check.
- **A lock costs a TCP connection, not a database backend.** monolock
  sessions are light connections, each with one goroutine. The limit is the
  [system resources](/concepts/capacity/), not a `max_connections` budget
  that your queries also use.
- **monolock does not add availability.** The two systems do not replicate
  the lock state. Advisory locks are in the shared memory of the primary and
  are gone after a failover. monolock is openly a single point of
  coordination. When it is not available, new locks are not possible
  ([what monolock is not](/start/introduction/#what-monolock-is-not)).
  Each of the two can return through a failover with lock-state loss —
  Postgres to a replica, monolock to a
  [standby](/operations/high-availability/).
  Postgres has mature durability and HA functions for your *data*. If you
  use them, you operate one process less. monolock is one more binary, but
  the binary is small.

## Side by side

| | monolock | PostgreSQL advisory locks |
| --- | --- | --- |
| Ownership model | one TCP connection = one claim | a database session (or a transaction) holds an `int8` key or two `int4` keys |
| Detection of a dead holder | silence for a client-selected lease | end of the session, seen through server-wide TCP keepalives and timeouts |
| Queue / fairness | strict FIFO | blocked calls; no documented sequence |
| Fencing tokens | with each grant, the number always increases | none |
| Handover latency | push; immediate after a controlled stop, ≤ one lease after a crash | the blocked call returns at the grant; the server sees a crash at the speed of the TCP settings |
| Clock assumptions | monotonic durations only, no synchronized clocks | none for the locks |
| Operation continues after a coordinator failure | no — a [standby](/operations/high-availability/) shortens the gap, the state is lost | no — the lock state is only in the shared memory of the primary |
| Operational footprint | one static Go binary, stdlib only | a full PostgreSQL server (frequently already in operation) |
| New infrastructure | one small server | none, if you operate Postgres |

## When PostgreSQL advisory locks are the correct selection

- You operate Postgres, and your locks are some mutexes for jobs and
  migrations. Zero new infrastructure is a real and decisive advantage.
- The lock protects work *in the same database*. `pg_advisory_xact_lock` in
  the transaction attaches the life of the lock to the life of the work
  exactly.
- Your clients connect to Postgres directly, or through session pooling.
  Then the session-ownership model operates without problems.
- A detection of a dead holder in minutes is satisfactory. Or you already
  tune the TCP keepalives for your full fleet.
- It is important to you that the primitive is 20 years old, has full
  documentation, and is known to each DBA.

## When monolock is the correct selection

- Your locks have the names of tenants, shards, or resources — real
  strings, many of them. A hash into 64 bits with silent collisions is not
  acceptable.
- You need fast failure detection for each lock. Examples are a deploy
  mutex or leader election, where the replacement of a crashed holder must
  occur in seconds. The client that knows its own network makes this
  selection, not a database-wide TCP setting.
- The service of the waiters must be fair and immediate. Examples are cron
  jobs and deploy queues, where starvation or many simultaneous retries are
  a problem.
- The resource that the lock protects is *outside* the database. You want
  [fencing tokens](/concepts/fencing-tokens/), so that stale writers reject
  themselves.
- Locks with a long life would keep limited Postgres backends busy. Or your
  connection path goes through PgBouncer in transaction pooling mode, where
  session-level advisory locks do not operate.

## Sources

- [PostgreSQL: Explicit Locking — §13.3.5 Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL: System Administration Functions — §9.28.10 Advisory Lock Functions](https://www.postgresql.org/docs/current/functions-admin.html)
- [PostgreSQL: Connection Settings — TCP keepalives and `tcp_user_timeout`](https://www.postgresql.org/docs/current/runtime-config-connection.html)
- [PostgreSQL: Client Connection Defaults — `idle_session_timeout`](https://www.postgresql.org/docs/current/runtime-config-client.html)
- [PostgreSQL 8.2 release notes — advisory locking replaces `contrib/userlock`](https://www.postgresql.org/docs/release/8.2.0/)
- [PgBouncer features — pooling modes and session-state compatibility matrix](https://www.pgbouncer.org/features.html)
