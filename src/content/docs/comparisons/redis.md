---
title: "monolock vs Redis & Redlock"
description: "Redis distributed lock (SET NX PX, Redlock) compared with monolock: fencing tokens, TTL vs connection-scoped ownership, FIFO queues, and when to pick a Redlock alternative."
---

Redis locks are a key with a TTL: whoever sets the key owns the lock until the
key expires or is deleted. monolock locks are a TCP connection: whoever holds
the connection owns the lock, and closing it is the release. If you already
run Redis and your locks are about efficiency — avoiding duplicate work, not
preventing corruption — a single-instance Redis lock is hard to beat. If you
want fencing tokens, a FIFO queue, and a holder that finds out it lost the
lock *before* the server hands it to someone else, that is what monolock is
built around.

## Background

Redis was never designed as a lock service; it grew one because it was
already there. The pattern is old and simple: create a key with `SET NX` and
a TTL, delete it when done. In 2014 Salvatore Sanfilippo (antirez), Redis's
author, wrote up a more careful version and a distributed extension called
**Redlock**: run the same acquisition against N independent Redis masters
(typically five), and consider the lock held if a majority accepted it within
a fraction of the TTL. Redlock is still the canonical algorithm on the Redis
documentation site, with client implementations in most languages.

In 2016 Martin Kleppmann published "How to do distributed locking", the
critique that has shaped every conversation about Redis locks since. His
first argument applies to *any* lock with an expiry: a client can pause — a
stop-the-world GC cycle, a page fault, a preempted VM — for longer than the
TTL, wake up believing it still holds the lock, and write to the guarded
resource after the lock has moved on. His proposed fix is the **fencing
token**: a number that increases with every grant, checked by the resource
itself, so a stale holder's writes arrive stamped with an old token and get
rejected. Redlock, he noted, "does not have any facility for generating
fencing tokens." His second argument was aimed at Redlock specifically: its
safety analysis assumes bounded clock drift and bounded pauses — a
synchronous system model — and Redis expiry uses the wall clock, not a
monotonic one.

antirez replied in "Is Redlock safe?". On clocks, he argued the requirement
is modest — processes only need to count *relative* time with a bounded error
rate, and Redlock re-checks elapsed time after acquisition, so unbounded
message delays cannot fool it. On fencing, he argued that if the guarded
resource can check tokens, "you probably don't need a distributed lock at
all, or at least you don't need a lock with strong guarantees" — and that
Redlock's random value can serve as a check-and-set token, albeit without
ordering. Neither side conceded. Today the Redis documentation links both
posts and states plainly: "You should implement fencing tokens" and "Redis is
not using monotonic clock for TTL expiration mechanism."

monolock's design reads like a response to that debate: fencing tokens on
every grant, monotonic time only, and a client-side timeout that fires before
the server-side lease — the Kleppmann failure modes, addressed one by one,
within the honest limits of a single-node service.

## How Redis implements locking

**Single instance.** The lock is a key created with
`SET resource_name random_value NX PX 30000`: set only if absent, with a TTL.
The random value must be unique per client and attempt, because release must
be token-checked — delete the key only if it still holds *your* value, via a
small Lua script (or the `DELEX` command since Redis 8.4); a plain `DEL`
could remove a lock already expired and re-acquired by someone else. The TTL
is the "lock validity time": the client must finish within it, and the Redis
docs are explicit that mutual exclusion "is only limited to a given window of
time from the moment the lock is acquired."

**Extension.** A client that needs longer sends a Lua script that extends the
TTL if the key still holds its value. Mature clients automate this: Redisson,
the main Java client, runs a "lock watchdog" that prolongs the expiration
(default `lockWatchdogTimeout`, 30 seconds) for as long as the holder's
process is alive.

**Dead-holder detection** is the TTL itself. A crashed holder is discovered
only when the key expires — there is no connection or session tied to the
lock, so nothing faster is possible. A holder that forgets to release, or
crashes after acquiring, leaves the lock stuck for the full TTL.

**Waiting.** There is no queue in the pattern itself: contenders retry
`SET NX` in a loop, and the docs recommend a random delay to desynchronize
them. Client libraries improve on this — Redisson notifies waiters via
pub/sub rather than polling, and offers a separate *fair lock* that
"guarantees that threads will acquire it in is same order they requested it."
Fairness is an opt-in library feature, not a property of the lock.

**Redlock** layers the single-instance pattern over N independent masters:
acquire on all in parallel, succeed if a majority accepted within the
validity time, subtract the elapsed time and a clock-drift allowance. It
survives the crash of a minority of Redis nodes, at the price of the clock
assumptions above — plus operational care (delayed restarts or
`fsync=always`) so a crashed node cannot rejoin and re-grant a lock it
forgot.

**Fencing.** Neither the single-instance pattern nor Redlock issues an
ordered fencing token. The random value can be used for check-and-set at the
resource, as antirez suggests, but it carries no ordering, and wiring any of
it into the guarded resource is entirely the user's job.

## How monolock differs

**Ownership is a connection, not a key.** One TCP connection makes one claim
on one lock; closing the connection is the release
([how it works](/concepts/how-it-works/)). There is no release command to
forget, no Lua script to get subtly wrong, and no lock left stuck for a TTL
because a process crashed after acquiring — if the process dies, the kernel
closes the socket and the next waiter is promoted immediately.

**The lease is a failure detector, not a deadline.** A Redis TTL is a budget
your work must fit into (or a watchdog must keep topping up). A monolock
lease is a sliding window of silence: heartbeats reset it, and a lock can be
held forever. Each client picks its own lease per connection, so detection
speed is a per-client choice rather than a global policy.

**A stale holder finds out first.** This is the sharpest contrast with the
GC-pause scenario. A paused Redis lock holder silently loses the key and has
no way to know until its next command. A monolock client gives up on its own
at 0.8 × lease without a heartbeat confirmation — *before* the server's lease
expires — so a holder never believes in a lock the server has already moved
on from. The unbounded remainder of the window (writes already in flight) is
what fencing is for.

**Fencing tokens on every grant.** Every `ACQUIRED` carries a `uint64`
strictly larger than every earlier grant, ready to be applied as a
conditional write at the resource — the mechanism Kleppmann asked for and
Redlock lacks ([fencing tokens](/concepts/fencing-tokens/)). To be fair in
both directions: antirez is right that the resource must cooperate for
fencing to mean anything, and monolock's own guarantee has documented
bounds — tokens are derived from server start time and an in-memory counter,
so they survive restarts only if the server's clock does not step backwards
and restarts are at least a second apart.

**Strict FIFO, promoted by push.** Waiters queue in arrival order and the new
owner is notified on the server's initiative — no retry loops, no random
back-off, no thundering herd on release. Handover is immediate on graceful
exit and at most one lease after a crash.

**Monotonic time only.** Only durations cross the wire; both sides use
monotonic clocks exclusively, so an NTP step changes nothing — a direct
answer to the wall-clock caveat in the Redis docs.

**The honest downside:** monolock is a single point of coordination. Redlock
over five masters keeps granting locks when a node dies; a down monolock
server means no new acquisitions until it is back
([what monolock is not](/start/introduction/#what-monolock-is-not)).

## Side by side

| | monolock | Redis / Redlock |
| --- | --- | --- |
| Ownership model | one TCP connection = one claim | key with TTL, random value |
| Dead-holder detection | silence for a client-chosen lease | key expiry after full TTL |
| Queue / fairness | strict FIFO | none; retry loops (fair lock via Redisson) |
| Fencing tokens | on every grant, monotonically increasing | none; unordered random value only |
| Handover latency | push; immediate on graceful exit, ≤ lease on crash | next successful retry after `DEL` or expiry |
| Clock assumptions | monotonic durations only, no synchronized clocks | wall-clock TTLs; Redlock assumes bounded drift |
| Survives coordinator failure | no — single point of coordination | Redlock: yes, up to a minority of N masters |
| Operational footprint | single static Go binary, stdlib only | Redis server(s); 5 masters for Redlock |
| Extra infra needed | one small server | none if you already run Redis |

## When to choose Redis

- You already operate Redis. A lock that needs no new infrastructure, no new
  deployment, and no new failure domain is a real advantage.
- Your locks are efficiency locks — deduplicating work where an occasional
  double execution is annoying but harmless. Kleppmann himself endorses a
  single Redis instance for exactly this case.
- You need very high lock throughput at sub-millisecond latency; an in-memory
  key operation is about as cheap as acquisition gets.
- You want a mature, batteries-included client ecosystem — Redisson alone
  ships watchdog renewal, fair locks, read-write locks, and semaphores.
- You need lock acquisition to survive the loss of a single coordinator node
  without failing over: Redlock over N independent masters does this;
  monolock by design does not.

## When to choose monolock

- Cron-style jobs, deploy mutexes, and leader election that tolerate a brief
  coordination gap — work where correctness matters enough to want fencing,
  but not enough to justify a consensus cluster.
- You want fencing tokens issued by the lock service rather than built by
  hand, and a resource-side check that is one integer comparison.
- Forgotten releases and TTL tuning have bitten you: connection-scoped
  ownership removes the release call, and the lease is a detection speed, not
  a work deadline.
- Contention should be fair and quiet: strict FIFO with push promotion
  instead of randomized retry loops.
- You do not run Redis and do not want to start for the sake of a lock: one
  static binary is the entire footprint.

## Sources

- [Distributed Locks with Redis (Redlock)](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/) — redis.io
- [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) — Martin Kleppmann, 2016
- [Is Redlock safe?](http://antirez.com/news/101) — Salvatore Sanfilippo (antirez), 2016
- [Redisson: Locks and Synchronizers](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/) — lock watchdog and fair lock documentation
