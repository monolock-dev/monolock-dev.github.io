---
title: "monolock vs etcd"
description: etcd distributed lock vs monolock — Raft consensus, lease TTLs, clientv3 concurrency Mutex, revisions as fencing tokens, and when a single-server lock service is enough.
---

etcd is a Raft-replicated key-value store: its locks keep working as long as a
majority of the cluster is alive, which is exactly the guarantee monolock does
not offer. monolock is one process, and while it is down no new locks can be
acquired. If the work you are guarding cannot tolerate a coordination gap when
the coordinator fails, pick etcd. If it can — cron singletons, deploy mutexes,
leader election with a tolerable pause — monolock does the same job with one
static binary, millisecond-scale failure detection, and none of the cluster
operations.

## Background

The lineage of etcd's locking runs straight back to Google's Chubby, the 2006
lock service built on Paxos that introduced most of the vocabulary this site
uses — coarse-grained locks, sessions, and leases. ZooKeeper brought that
design to the open-source world, and etcd, started at CoreOS in 2013, is the
generation after that: its own documentation says plainly that "the lessons
learned from ZooKeeper certainly informed etcd's design". Its first production
job was coordinating Container Linux reboots — locksmith, a distributed
semaphore over etcd, made sure only a few machines in a fleet updated at once.

Then Kubernetes chose etcd as its datastore, and etcd became one of the most
widely deployed consensus systems in existence. Every Kubernetes cluster runs
one. That matters for this comparison: for many teams the honest question is
not "should I deploy etcd for locks?" but "I already run etcd — should my
locks live there too?"

Unlike ZooKeeper, which leaves locks to client-side recipes (Curator), etcd
ships coordination as first-party API: leases, elections, and a distributed
lock service maintained by the etcd developers themselves. That is what this
article compares against — the recommended usage, not a home-grown
compare-and-swap loop over bare keys.

One well-known chapter of the story is Jepsen's 2020 analysis of etcd 3.4.3.
The key-value store itself came out looking excellent — strict serializability
held up under faults. The lock API did not: Jepsen showed that "multiple
clients may hold the same etcd lock simultaneously", even "in healthy
clusters, without any external faults" when lease TTLs were short. This is not
an etcd bug; it is the inherent window of every lease-based lock, the same one
[monolock documents](/concepts/fencing-tokens/). The fix is the same too:
Jepsen pointed users at the lock key's revision as "a globally ordered fencing
token", and etcd's documentation was revised accordingly. The lesson to carry
into the rest of this article: *even the consensus-backed option* needs the
guarded resource to enforce fencing.

## How etcd implements locking

The recommended Go path is the `clientv3/concurrency` package. A **Session**
wraps an etcd lease: `NewSession` calls `LeaseGrant` (default TTL 60 seconds;
TTLs are whole seconds, requested by the client but ultimately decided by the
server) and starts a background `LeaseKeepAlive` stream that refreshes the
lease for the lifetime of the client. When the lease expires or is revoked,
every key attached to it is deleted — that is the ephemerality primitive
everything else is built on.

A **Mutex** is a key. `Mutex.Lock` writes a key under the lock's prefix,
attached to the session's lease, and the key's `create_revision` — a position
in etcd's globally ordered history of writes — becomes the claim's place in
line. The oldest live key under the prefix owns the lock; every other session
waits for the deletion of the keys created before its own. This is the
ZooKeeper-style wait chain, and it is genuinely fair: waiters are woken in
creation order, one at a time, with no thundering herd. The gRPC lock service
(`Lock`/`Unlock` RPCs) exposes the same construction to non-Go clients, and
its documentation makes the same promise: the next waiting caller is woken and
given ownership.

Dead-holder detection is lease expiry. A holder that crashes stops feeding its
keep-alive stream; after the TTL the lease dies, the key vanishes, and the
next waiter's watch fires. Detection latency is therefore up to the TTL —
and since TTLs are whole seconds with a server-enforced minimum, it is
seconds-scale in practice. A graceful `Unlock` deletes the key immediately.

Fencing exists, but it is raw material, not a delivered feature. Inside etcd
itself, `Mutex.IsOwner()` gives you a transaction guard so that writes *to
etcd* happen only while the lock is held. For any resource outside etcd — a
database, an object store, an API — the user must extract the lock key's
revision and plumb it through every guarded write as a fencing token. The
Jepsen analysis exists precisely because many users assumed `Lock`/`Unlock`
alone was mutual exclusion. It is not, and cannot be: a holder paused at the
wrong moment can act after its lease has expired, in etcd exactly as in
monolock.

What the Raft layer underneath buys is availability and durability. Every
acquisition is a quorum write: proposed by the leader, fsynced to the
write-ahead log on a majority of members, then committed. A 3-node cluster
tolerates one dead member, a 5-node cluster two; leader failure costs an
election, after which locking resumes. Revisions live in the replicated log,
so fencing tokens are durable and monotonic across any restart, with no
caveats.

The bill for that arrives as operations. You run 3 or 5 members on disks fast
enough that fsync latency does not destabilize consensus — etcd's own FAQ is
blunt that it is highly sensitive to disk performance and recommends SSDs. The
MVCC store keeps every historical revision, so you configure history
compaction; compaction fragments the backend, so you schedule per-member
defragmentation, which blocks that member's reads and writes while it runs;
and a backend quota watches over all of it — exceed it and the cluster raises
an alarm and drops into a maintenance mode that accepts only reads and deletes
until an operator compacts, defragments, and disarms the alarm.

## How monolock differs

**One process instead of a quorum.** An acquisition is one round-trip to one
server that mutates memory — no proposal, no replication, no fsync. The flip
side is the availability row of the table below, lost on purpose: when the
monolock server is down or restarting, nobody acquires anything until it is
back ([what monolock is not](/start/introduction/#what-monolock-is-not)).

**The connection is the claim.** There is no lease object, session ID, or
unlock call — one TCP connection makes one claim, and closing the connection
is the release ([how it works](/concepts/how-it-works/)). etcd's Session is a
thing you create, keep alive, and close; orphan it and the lock outlives your
process until the TTL burns down.

**Leases are client-chosen and fine-grained.** etcd's server grants TTLs in
whole seconds; monolock's client picks any duration per connection —
milliseconds on a LAN — because the lease is only a failure detector, not a
term of ownership. The heartbeat schedule is derived from it (`lease / 4`,
shrunk by smoothed RTT), and the client unilaterally gives up at `0.8 ×
lease`, *before* the server's deadline, so the stale side of the race is
always the holder, never the server. etcd's client learns of lease loss
through the keep-alive stream; the pessimism is comparable, but the detection
floor is seconds, not milliseconds.

**Handover is a push, not a watch.** Both systems queue waiters fairly — etcd
by `create_revision` wait chain, monolock by strict FIFO arrival order. On
handover, etcd deletes a key and the successor's watch fires; monolock's
server sends `ACQUIRED` to the promoted waiter on its own initiative, one
one-way trip after the owner's socket closes.

**Fencing is explicit, with honest bounds.** monolock delivers a `uint64`
token in every grant; etcd makes you fish the `create_revision` out of the
lock key. In *both* systems the guarded resource must enforce the comparison —
neither lock service can do it for you. The real difference is durability:
etcd revisions live in the Raft log and survive anything short of losing the
cluster; monolock's tokens keep their guarantee across restarts only under
[documented conditions](/concepts/fencing-tokens/#the-guarantees-bounds). If
your resource cannot accept those bounds, that alone decides for etcd.

**Footprint.** monolock is a single static Go binary, standard library only,
holding everything in memory. There is no WAL to place on an SSD, no history
to compact, no backend to defragment, no quota alarm to disarm.

## Side by side

| | monolock | etcd |
| --- | --- | --- |
| Ownership model | one TCP connection = one claim | key under a lease; oldest `create_revision` owns |
| Dead-holder detection | silence for a client-chosen lease | lease TTL expiry; whole seconds, server-granted |
| Queue / fairness | strict FIFO | fair wait chain ordered by `create_revision` |
| Fencing tokens | on every grant, monotonically increasing | key revision usable as token; extraction and plumbing are yours |
| Handover latency | push; immediate on graceful exit, ≤ lease on crash | watch fires on key delete; immediate on unlock, ≤ TTL on crash |
| Clock assumptions | monotonic durations only, no synchronized clocks | no synchronized client clocks; TTLs counted server-side |
| Survives coordinator failure | no — single point of coordination | yes — any minority of members can fail |
| Operational footprint | single static Go binary, stdlib only | 3/5-node cluster, fsynced WAL, compaction + defrag + quota |
| Extra infra needed | one small server | a consensus cluster on low-latency disks |

## When to choose etcd

- The guarded work must keep acquiring locks through the failure of a
  coordinator node. This is the headline feature and monolock simply does not
  have it.
- You already operate etcd — every Kubernetes control plane does — and can
  reuse it instead of adding a service. (Mind the blast radius: lock traffic
  shares the cluster, its quota, and its compaction schedule with everything
  else.)
- Fencing tokens must be durable with no caveats: revisions are committed to
  the Raft log and survive restarts unconditionally.
- You need more than locks from the same system — replicated configuration,
  watches, elections, service discovery — and want them behind one
  consistent, transactional API.
- Multi-node durability of the coordination state is a compliance or
  architectural requirement in itself.

## When to choose monolock

- The workload tolerates a brief coordination gap if the server restarts:
  nightly imports, cron-style singletons, deploy mutexes, leader election for
  interruptible work. This is monolock's stated target, not a stretch.
- You want dead holders detected in milliseconds, not seconds — monolock's
  client-chosen leases go as low as the network allows; etcd's TTLs are whole
  seconds with a server minimum.
- You do not want to run a consensus cluster for a lock: no quorum sizing, no
  SSD latency budget, no compaction, defragmentation, or quota alarms — one
  binary and a port.
- You want ownership that cannot outlive the process: no session to orphan, no
  unlock to forget — the kernel closing the socket is the release.
- You want handover pushed to the next waiter the instant the owner leaves,
  with strict FIFO order and a fencing token already in the grant.

## Sources

- [etcd v3 lock service API reference](https://etcd.io/docs/v3.6/dev-guide/api_concurrency_reference_v3/) — Lock/Unlock RPCs, key-under-lease ownership, waiter wake-up order
- [etcd learning: API — leases and revisions](https://etcd.io/docs/v3.6/learning/api/) — LeaseGrant, KeepAlive streams, revisions as a global logical clock
- [clientv3/concurrency package documentation](https://pkg.go.dev/go.etcd.io/etcd/client/v3/concurrency) — Session (default 60 s TTL), Mutex, IsOwner
- [etcd FAQ](https://etcd.io/docs/v3.6/faq/) — quorum math, fault tolerance of 3/5-node clusters, disk latency sensitivity
- [etcd maintenance guide](https://etcd.io/docs/v3.6/op-guide/maintenance/) — history compaction, defragmentation, storage quota and alarms
- [Jepsen: etcd 3.4.3](https://jepsen.io/analyses/etcd-3.4.3) — lock unsafety under pauses and in healthy clusters, revisions as fencing tokens
- [etcd learning: comparison with other systems](https://etcd.io/docs/v3.6/learning/why/) — ZooKeeper lessons, CoreOS locksmith, Kubernetes usage
- [The Chubby lock service for loosely-coupled distributed systems](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/) — the ancestor design
