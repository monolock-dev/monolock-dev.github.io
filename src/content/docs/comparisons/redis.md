---
title: "monolock vs Redis & Redlock"
description: "A comparison of Redis locks (SET NX PX, Redlock) and monolock: fencing tokens, TTL and connection ownership, FIFO queues, and when monolock is a Redlock alternative."
---

A Redis lock is a key that has a TTL (time to live). The client that sets the key is the
owner of the lock. The lock stops when the key expires or when a client
deletes the key. A monolock lock is a TCP connection. The client that holds
the connection is the owner of the lock. When the connection closes, the
server releases the lock.

Possibly you operate Redis, and your locks only prevent unnecessary work and
do not prevent damage to data. Then a Redis lock on one instance is a good
solution. But possibly you want fencing tokens, a first-in, first-out
(FIFO) queue, and a holder
that knows about a lost lock before the server gives the lock to a different
client. monolock is made for this.

## Background

Redis is a data store, not a lock service. But users made locks with Redis
because Redis was available. The procedure is old and simple. Make a key with
the `SET NX` command and a TTL. Delete the key when the work is complete.

In 2014, Salvatore Sanfilippo (antirez), the author of Redis, wrote a more
careful version of this procedure. He also wrote a distributed extension with
the name **Redlock**. Redlock does the same acquisition on N independent
Redis masters, usually five. The lock is valid if a majority of the masters
accept it in a fraction of the TTL. Redlock is the standard algorithm in the
Redis documentation. Client implementations are available in most languages.

In 2016, Martin Kleppmann wrote the article "How to do distributed locking".
This article changed all subsequent discussions about Redis locks. His first
argument is applicable to each lock that has an expiry time. A client can
stop for more time than the TTL. Possible causes are a stop-the-world
garbage collection (GC)
cycle, a page fault, or a preempted VM. The client then continues, thinks
that it holds the lock, and writes to the resource. But the lock is not
valid. His solution is the **fencing token**: a number that increases with
each grant. The resource examines the token and rejects writes that have an
old token. He wrote that Redlock "does not have any facility for generating
fencing tokens". His second argument is applicable only to Redlock. The
safety analysis of Redlock is correct only with limits on clock drift and on
pauses. And Redis expiry uses the wall clock, not a monotonic clock.

antirez replied in the article "Is Redlock safe?". About clocks, he wrote
that the requirement is small. Processes must only measure relative time with
a small error. Redlock also measures the elapsed time again after the
acquisition. Thus unlimited message delays cannot cause an incorrect result.
About fencing, he wrote that a resource that can examine tokens possibly
does not need a distributed lock with strong guarantees. He also wrote that
the random value of Redlock can operate as a check-and-set token, but
without a sequence. The two authors did not agree. Today the Redis
documentation refers to the two articles. It tells you to implement fencing
tokens. It also tells you that Redis does not use a monotonic clock for TTL
expiration.

The design of monolock is a reply to this discussion: fencing tokens with
each grant, monotonic time only, and a client-side timeout that occurs
before the server-side lease. It is a solution for each Kleppmann failure
mode, in the known limits of a single-node service.

## How Redis makes a lock

**One instance.** The lock is a key. The client makes the key with the
command `SET resource_name random_value NX PX 30000`. This command sets the
key only if the key is not there, and it sets a TTL. The random value must be
different for each client and for each attempt. The reason: the release must
occur only if the key contains your value. A small Lua script does this check
(or the `DELEX` command, available since Redis 8.4). A simple `DEL` command
is not safe. It can delete a lock that expired and that a different client
acquired again. The TTL is the validity time of the lock. The client must
complete its work in this time. The Redis documentation tells you that
mutual exclusion is applicable only in this window of time.

**Extension.** A client that needs more time sends a Lua script. The script
extends the TTL if the key contains the value of the client. Mature client
libraries do this automatically. Redisson, the primary Java client, has a
"lock watchdog". The watchdog extends the expiration (default
`lockWatchdogTimeout`, 30 seconds) while the process of the holder is alive.

**Detection of a dead holder.** The TTL is the only detection. If a holder
stops because of a crash, the other clients know it only when the key
expires. No connection and no session is attached to the lock. Thus a faster
detection is not possible. If a holder does not release the lock, or stops
after the acquisition, the lock stays for the full TTL.

**The wait procedure.** The pattern has no queue. Clients that wait send the
`SET NX` command again and again in a loop. The documentation recommends a
random delay between the attempts. Client libraries make this better.
Redisson sends a signal to the waiters through pub/sub and does not poll.
Redisson also has an optional *fair lock*. This lock gives the lock to the
threads in the sequence of their requests. Fairness is a feature of the
library, not a property of the lock.

**Redlock.** Redlock uses the one-instance pattern on N independent masters.
The client tries the acquisition on all the masters at the same time. The
acquisition is satisfactory if a majority of the masters accept it in the
validity time. The client subtracts the elapsed time and a margin for clock
drift. Redlock continues to operate if a minority of the Redis nodes fail.
The costs are the clock assumptions above and careful operation. Examples of
careful operation are delayed restarts or `fsync=always`. Without this care,
a node that had a crash can start again and give the same lock two times.

**Fencing.** The one-instance pattern and Redlock do not make fencing tokens
that have a sequence. You can use the random value for a check-and-set at the
resource, as antirez recommends. But the random value has no sequence. And
the connection of all this to the resource is fully your task.

## How monolock is different

**The owner is a connection, not a key.** One TCP connection makes one claim
on one lock. When the connection closes, the server releases the lock
([how it works](/concepts/how-it-works/)). There is no release command that
you can forget. There is no Lua script that you can write incorrectly. A
crash does not keep a lock for a full TTL. If the process stops, the kernel
closes the socket. The server then immediately gives the lock to the next
waiter.

**The lease is a failure detector, not a deadline.** A Redis TTL is a time
limit for your work, or a watchdog must extend it. A monolock lease is a
window of silence that moves. Each heartbeat starts the window again. A
client can hold a lock without a time limit. Each client selects its own
lease for its connection. Thus the detection speed is a selection of each
client, not a global policy.

**A stale holder knows it first.** This is the largest difference in the
GC-pause scenario. A Redis holder that has a pause loses the key and does
not know it. It finds the problem only with its subsequent command. A
monolock client stops its claim at 0.8 × lease if it gets no heartbeat
confirmation. This occurs before the lease expires on the server. Thus a
holder does not think that it holds a lock that the server gave to a
different client. Writes that are already in flight are the task of the
fencing tokens.

**Fencing tokens with each grant.** Each `ACQUIRED` message contains a
`uint64` number. This number is larger than the number of each earlier
grant. You can use it as a condition for a write at the resource. This is
the mechanism that Kleppmann asked for and that Redlock does not have
([fencing tokens](/concepts/fencing-tokens/)). Two limits are important.
antirez is correct: the resource must examine the tokens, or the tokens have
no effect. And the monolock guarantee has known limits. The server makes the
tokens from the unix second of the latest grant and a counter in memory.
The sequence continues across a restart or a
[failover](/operations/high-availability/) only if the wall clock does not
step back between the grants of the two processes. In usual operation, this
condition is almost always true. Only an unusual event, for example a clock
step to an earlier time exactly around a restart, can break it. The
probability is near zero. And a system with this event has a problem that
is much larger than one lock.

**Strict FIFO, with push promotion.** Waiters go into a queue in the
sequence of their arrival. The server sends a message to the new owner.
There are no retry loops and no random delays. When a lock becomes free,
only one waiter gets a message. The handover is immediate after a controlled
stop. After a crash, the handover occurs in a maximum of one lease.

**Monotonic time only.** Only durations go across the network. The two sides
use only monotonic clocks. Thus a step of the Network Time Protocol (NTP)
clock has no effect. This is a direct
answer to the wall-clock warning in the Redis documentation.

**The disadvantage:** monolock is a single point of coordination. Redlock
with five masters continues to give locks when a node fails. If the monolock
server is not available, new acquisitions are not possible until the server
is available again
([what monolock is not](/start/introduction/#what-monolock-is-not)). A
passive [standby](/operations/high-availability/) makes the gap short, but
the lock state does not move with the traffic.

## Side by side

| | monolock | Redis / Redlock |
| --- | --- | --- |
| Ownership model | one TCP connection = one claim | key with a TTL and a random value |
| Detection of a dead holder | silence for a client-selected lease | key expiry after the full TTL |
| Queue / fairness | strict FIFO | none; retry loops (fair lock with Redisson) |
| Fencing tokens | with each grant, the number always increases | none; only a random value without a sequence |
| Handover latency | push; immediate after a controlled stop, ≤ one lease after a crash | the subsequent satisfactory retry after `DEL` or expiry |
| Clock assumptions | monotonic durations only, no synchronized clocks | wall-clock TTLs; Redlock assumes limited drift |
| Operation continues after a coordinator failure | no — a [standby](/operations/high-availability/) shortens the gap, the state is lost | Redlock: yes, for a minority of the N masters |
| Operational footprint | one static Go binary, stdlib only | Redis server(s); 5 masters for Redlock |
| New infrastructure | one small server | none, if you operate Redis |

## When Redis is the correct selection

- You operate Redis. A lock that needs no new infrastructure, no new
  deployment, and no new failure domain is a real advantage.
- Your locks are efficiency locks. They prevent unnecessary double work. A
  double execution is not dangerous. Kleppmann recommends one Redis instance
  for exactly this case.
- Your locks have a short life, and there are many acquisitions each second.
  A Redis client opens a connection one time and sends thousands of commands
  through it. A monolock claim is a connection. Thus each lock needs a new
  TCP handshake (and a TLS handshake, if you use TLS) and a socket close.
  The latency of one acquisition is almost equal for the two tools. But at a
  high rate of short locks, Redis gives more throughput.
- You need more primitives than a mutex: read-write locks, semaphores, or
  count-down latches. Redisson has them. monolock has only one primitive,
  the exclusive named lock. This is by design.
- The lock service must continue when one coordinator node fails. Redlock
  with N independent masters does this. monolock, by design, does not.

## When monolock is the correct selection

- Cron jobs, deploy mutexes, and leader election that permit a short
  coordination gap. Correct operation is sufficiently important for fencing
  tokens, but not sufficiently important for a consensus cluster.
- You want fencing tokens from the lock service, not tokens that you make
  yourself. The check at the resource is one integer comparison.
- Forgotten releases and TTL adjustments caused problems for you before.
  Connection ownership removes the release call. The lease is a detection
  speed, not a work deadline.
- Contention must be fair and quiet: strict FIFO with push promotion, not
  retry loops with random delays.
- You do not operate Redis, and you do not want to start Redis only for a
  lock. One static binary is the full footprint.
- A small client is important to you. Many Redisson functions only correct
  the weak points of the key-with-TTL primitive: watchdog renewal, pub/sub
  signals, fair-lock records, and release scripts that examine the token.
  In monolock, the protocol contains these functions. Thus a client is one
  page of code ([writing a client](/clients/writing-a-client/)).

## Sources

- [Distributed Locks with Redis (Redlock)](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/) — redis.io
- [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) — Martin Kleppmann, 2016
- [Is Redlock safe?](http://antirez.com/news/101) — Salvatore Sanfilippo (antirez), 2016
- [Redisson: Locks and Synchronizers](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/) — lock watchdog and fair lock documentation
