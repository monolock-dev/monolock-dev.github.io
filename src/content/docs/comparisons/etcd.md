---
title: "monolock vs etcd"
description: etcd distributed lock vs monolock — Raft consensus, lease TTLs, clientv3 concurrency Mutex, revisions as fencing tokens, and when a single-server lock service is enough.
---

etcd is a key-value store with Raft replication. Its locks continue to
operate while a majority of the cluster is alive. This is exactly the
guarantee that monolock does not give. monolock is one process. While it is
not available, new acquisitions are not possible. If your work cannot accept
a coordination gap after a coordinator failure, select etcd. If a gap is
acceptable — cron singletons, deploy mutexes, leader election with a
permitted pause — monolock does the same work with one static binary,
failure detection in milliseconds, and no cluster operations.

## Background

The locking of etcd comes from Chubby, the lock service that Google made on
Paxos in 2006. Chubby gave us most of the vocabulary that this site uses:
coarse-grained locks, sessions, and leases. ZooKeeper brought that design to
the open-source world. etcd, started at CoreOS in 2013, is the subsequent
generation. Its own documentation says that "the lessons learned from
ZooKeeper certainly informed etcd's design". Its first production task was
the coordination of Container Linux reboots. The tool locksmith, a
distributed semaphore on etcd, made sure that only some machines in a fleet
update at the same time.

Then Kubernetes selected etcd as its datastore. Thus etcd became one of the
most widely deployed consensus systems. Each Kubernetes cluster operates
one. This is important for this comparison. For many teams, the honest
question is not "must I deploy etcd for locks?". The question is "I already
operate etcd — must my locks live there also?".

ZooKeeper gives locks only as client-side recipes (Curator). etcd is
different. It has coordination as a first-party API: leases, elections, and
a distributed lock service from the etcd developers themselves. This
article compares against that recommended usage, not against a home-made
compare-and-swap loop on bare keys.

One well-known part of the story is the Jepsen analysis of etcd 3.4.3 in
2020. The key-value store itself got a very good result. Strict
serializability stayed correct under faults. The lock API did not. Jepsen
showed that "multiple clients may hold the same etcd lock simultaneously",
also "in healthy clusters, without any external faults", when the lease TTLs
were short. This is not an etcd bug. It is the window that each lease-based
lock has, the same window that
[monolock documents](/concepts/fencing-tokens/). The solution is also the
same. Jepsen pointed the users at the revision of the lock key as "a
globally ordered fencing token", and the etcd documentation got a related
update. The lesson for the remainder of this article: *also the option with
consensus* needs a guarded resource that examines fencing tokens.

## How etcd makes a lock

**Session and lease.** The recommended Go path is the `clientv3/concurrency`
package. A **Session** contains an etcd lease. `NewSession` calls
`LeaseGrant`. The default TTL (time to live) is 60 seconds, and TTLs are
whole seconds. The
client requests a TTL, but the server makes the decision. The session also
starts a background `LeaseKeepAlive` stream. This stream refreshes the lease
for the life of the client. When the lease expires, or when a client revokes
it, the server deletes each key that is attached to the lease. This is the
base primitive for all the other functions.

**Mutex.** A **Mutex** is a key. `Mutex.Lock` writes a key under the prefix
of the lock, attached to the lease of the session. The `create_revision` of
the key is a position in the globally ordered history of writes in etcd. It
is the position of the claim in the line. The oldest live key under the
prefix owns the lock. Each other session waits for the deletion of the keys
that came before its own key. This is the ZooKeeper-style wait chain, and it
is fair. The server wakes the waiters in the sequence of creation, one at a
time. There is no group of waiters that awake at the same time. The gRPC
lock service (the `Lock` and `Unlock` RPCs) gives the same construction to
non-Go clients. Its documentation makes the same promise: the server wakes
the subsequent waiting caller and gives it ownership.

**Detection of a dead holder.** The detection is the lease expiry. A holder
that has a crash stops its keep-alive stream. After the TTL, the lease dies,
the key goes away, and the watch of the subsequent waiter reacts. Thus the
detection latency is a maximum of the TTL. And because TTLs are whole
seconds with a server-side minimum, the latency is seconds in practice. A
controlled `Unlock` deletes the key immediately.

**Fencing.** Fencing is available, but as material, not as a complete
function. In etcd itself, `Mutex.IsOwner()` gives you a transaction guard.
With it, writes *to etcd* occur only while you hold the lock. For each
resource outside etcd — a database, an object store, an API — you must get
the revision from the lock key yourself. You must then send it with each
guarded write as a fencing token. The Jepsen analysis exists exactly because
many users thought that `Lock` and `Unlock` alone give mutual exclusion.
They do not, and they cannot. A holder with a pause at the incorrect moment
can operate after its lease expired — in etcd exactly as in monolock.

**What the Raft layer gives.** The Raft layer gives availability and
durability. Each acquisition is a quorum write. The leader makes a proposal,
a majority of the members fsync it to the write-ahead log, and then the
cluster commits it. A 3-node cluster continues with one dead member, a
5-node cluster with two. A leader failure costs an election. After the
election, locking continues. The revisions live in the replicated log. Thus
the fencing tokens are durable, and they increase across each restart,
without conditions.

**The cost is operations.** You operate 3 or 5 members on disks that are
sufficiently fast, because slow fsync makes the consensus unstable. The etcd
FAQ says clearly that etcd is highly sensitive to disk performance, and it
recommends SSDs. The MVCC store keeps each historical revision. Thus you
must configure history compaction. Compaction fragments the backend. Thus
you must schedule defragmentation for each member, and defragmentation
blocks the reads and writes of that member while it runs. A backend quota
monitors all of this. If you go above the quota, the cluster raises an
alarm and goes into a maintenance mode. This mode accepts only reads and
deletes, until an operator compacts, defragments, and stops the alarm.

## How monolock is different

**One process, not a quorum.** An acquisition is one round-trip to one
server that changes its memory. There is no proposal, no replication, and
no fsync. The cost is the availability row in the table below, and this
loss is a design decision. When the monolock server is down or restarts,
no client can acquire a lock until the server is available again
([what monolock is not](/start/introduction/#what-monolock-is-not)). A
passive [standby](/operations/high-availability/) makes this gap short.
But it does not change the guarantee: the lock state is not replicated.

**The connection is the claim.** There is no lease object, no session ID,
and no unlock call. One TCP connection makes one claim. The close of the
connection is the release ([how it works](/concepts/how-it-works/)). An
etcd Session is an object that you create, keep alive, and close. If you
lose it without a close, the lock stays after your process until the TTL
ends.

**The client selects a fine-grained lease.** The etcd server grants TTLs in
whole seconds. The monolock client selects any duration for its connection
— milliseconds on a local-area network (LAN). This is possible because the lease is only a
failure detector, not a term of ownership. The heartbeat schedule comes
from the lease (`lease / 4`, decreased by the smoothed round-trip time,
RTT). The client
stops its claim at `0.8 × lease`, *before* the deadline of the server. Thus
the stale side of the race is always the holder, never the server. The etcd
client learns about a lost lease through the keep-alive stream. The caution
is comparable, but the minimum detection time is seconds, not milliseconds.

**The handover is a push, not a watch.** The two systems have fair queues.
etcd uses the wait chain with `create_revision`. monolock uses a strict
first-in, first-out (FIFO) order — the sequence of arrival. At handover, etcd deletes a key, and the watch
of the subsequent waiter reacts. The monolock server sends the `ACQUIRED`
message to the promoted waiter on its own initiative — one one-way message
after the socket of the owner closes.

**Fencing is explicit, with honest limits.** monolock sends a `uint64`
token in each grant. In etcd, you must get the `create_revision` from the
lock key yourself. In the *two* systems, the guarded resource must do the
comparison. No lock service can do it for you. The real difference is
durability. The etcd revisions live in the Raft log. They stay correct
after each failure that is smaller than the loss of the cluster. The
monolock tokens keep their guarantee across restarts and
[failovers](/operations/high-availability/) only under
[documented conditions](/concepts/fencing-tokens/#the-guarantees-bounds):
the wall clock must not step back between the grants of the two processes.
In usual operation, this condition is almost always true. A failure needs
an unusual event:
a wall clock that moves back exactly around a restart, for example because
of an incorrect NTP (Network Time Protocol) configuration. The probability is near zero. And if
this event occurs, it is a problem for your full system — certificates,
logs, caches, and databases — not only for the lock. But if your resource
must have tokens with no conditions at all, this point makes etcd the
correct selection.

**Footprint.** monolock is one static Go binary, standard library only,
with all data in memory. There is no write-ahead log (WAL) that needs an
SSD, no history that
needs compaction, no backend that needs defragmentation, and no quota alarm
that needs an operator.

## Side by side

| | monolock | etcd |
| --- | --- | --- |
| Ownership model | one TCP connection = one claim | a key under a lease; the oldest `create_revision` owns |
| Detection of a dead holder | silence for a client-selected lease | lease TTL expiry; whole seconds, granted by the server |
| Queue / fairness | strict FIFO | fair wait chain in the sequence of `create_revision` |
| Fencing tokens | with each grant, the number always increases | the key revision can be a token; you get it and send it yourself |
| Handover latency | push; immediate after a controlled stop, ≤ one lease after a crash | the watch reacts to the key deletion; immediate after unlock, ≤ TTL after a crash |
| Clock assumptions | monotonic durations only, no synchronized clocks | no synchronized client clocks; the server counts the TTLs |
| Operation continues after a coordinator failure | no — a [standby](/operations/high-availability/) shortens the gap, the state is lost | yes — a minority of the members can fail |
| Operational footprint | one static Go binary, stdlib only | a 3/5-node cluster, fsynced WAL, compaction + defragmentation + quota |
| New infrastructure | one small server | a consensus cluster on low-latency disks |

## When etcd is the correct selection

- The guarded work must continue to acquire locks through the failure of a
  coordinator node. This is the primary feature, and monolock does not have
  it.
- You already operate etcd — each Kubernetes control plane does — and you
  can use it without a new service. But be careful: the lock traffic shares
  the cluster, its quota, and its compaction schedule with all the other
  data.
- The fencing tokens must be durable without conditions, also in rare
  failure modes. The revisions are committed to the Raft log and stay
  correct after each restart.
- You need more than locks from the same system — replicated
  configuration, watches, elections, service discovery — behind one
  consistent, transactional API.
- Multi-node durability of the coordination state is itself a compliance or
  architecture requirement.

## When monolock is the correct selection

- The work accepts a short coordination gap when the server restarts:
  nightly imports, cron-style singletons, deploy mutexes, and leader
  election for work that you can interrupt. This is the specified target of
  monolock.
- You want the detection of dead holders in milliseconds, not seconds. The
  client-selected leases of monolock go as low as the network permits. The
  etcd TTLs are whole seconds with a server-side minimum.
- You do not want to operate a consensus cluster for a lock: no quorum
  size, no SSD latency budget, no compaction, no defragmentation, and no
  quota alarms — one binary and one port.
- You want ownership that cannot stay after the process: no session that
  you can lose, and no unlock that you can forget. The close of the socket
  by the kernel is the release.
- You want a handover that goes to the subsequent waiter immediately when
  the owner leaves, with strict FIFO sequence and a fencing token already
  in the grant.

## Sources

- [etcd v3 lock service API reference](https://etcd.io/docs/v3.6/dev-guide/api_concurrency_reference_v3/) — Lock/Unlock RPCs, key-under-lease ownership, waiter wake-up order
- [etcd learning: API — leases and revisions](https://etcd.io/docs/v3.6/learning/api/) — LeaseGrant, KeepAlive streams, revisions as a global logical clock
- [clientv3/concurrency package documentation](https://pkg.go.dev/go.etcd.io/etcd/client/v3/concurrency) — Session (default 60 s TTL), Mutex, IsOwner
- [etcd FAQ](https://etcd.io/docs/v3.6/faq/) — quorum math, fault tolerance of 3/5-node clusters, disk latency sensitivity
- [etcd maintenance guide](https://etcd.io/docs/v3.6/op-guide/maintenance/) — history compaction, defragmentation, storage quota and alarms
- [Jepsen: etcd 3.4.3](https://jepsen.io/analyses/etcd-3.4.3) — lock unsafety under pauses and in healthy clusters, revisions as fencing tokens
- [etcd learning: comparison with other systems](https://etcd.io/docs/v3.6/learning/why/) — ZooKeeper lessons, CoreOS locksmith, Kubernetes usage
- [The Chubby lock service for loosely-coupled distributed systems](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/) — the ancestor design
