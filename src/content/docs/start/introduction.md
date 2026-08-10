---
title: Introduction
description: What monolock is, what problem it solves, and when to pick it over a consensus-backed lock service.
---

monolock is a lightweight TCP server for named locks — a distributed mutex
without the distributed system. Many processes across many machines need to
agree that only one of them runs the nightly import, rolls the deploy, or
compacts the shard. monolock gives them a single, simple place to agree.

## The idea

A client opens a TCP connection, asks for a lock by name, and either becomes
the owner or queues up behind the current one. That is the whole model:

- **One connection is one claim on one lock.** The connection *is* the lease;
  closing it releases the lock. There is no `RELEASE` command to forget and no
  session token to lose.
- **Named locks, FIFO waiters.** Lock names are raw UTF-8 strings up to 255
  bytes. Waiters are promoted strictly in arrival order.
- **Connection-scoped ownership.** On graceful shutdown of the owner the next
  waiter takes over immediately. If the owner hangs or the network drops, the
  lock moves on once the session stays silent for a full lease.
- **Client-chosen leases, RTT-aware heartbeats.** Each client picks how fast a
  dead holder should be detected; the server imposes no global policy.
- **Fencing tokens.** Every grant carries a number strictly larger than every
  earlier grant, so the guarded resource can reject writes from stale holders.

## What's in the box

The server is a single static Go binary with no dependencies outside the
standard library — no database, no config file, no sidecar. Operations are
covered end to end:

- [TLS and mTLS](/operations/tls/) with certificate rotation on `SIGHUP`
- [ACL authorization](/operations/acl/): mTLS identity → lock name glob rules
- [JSON audit log](/operations/audit/) of every ownership change
- [Admin HTTP API](/operations/admin-api/): introspection, force-release,
  kicking waiters
- [Prometheus metrics and health endpoints](/operations/observability/)
- Connections and waiters limited only by
  [system resources](/concepts/capacity/)

## What monolock is not

monolock is **simple by design**: a single point of coordination. There is no
replication, no quorum, no consensus. That buys a tiny operational footprint
and easy-to-reason-about behavior, and it costs availability: when the server
is down or restarting, locks cannot be acquired until it is back.

That trade-off is right for a lot of real work — cron-style jobs, deploy
mutexes, leader election for tasks that tolerate a brief coordination gap. It
is wrong when the guarded resource demands guarantees that survive the
coordinator: then you need a consensus-backed lock service (etcd, ZooKeeper,
Consul) and should not try to bend monolock into one.

[Fencing tokens](/concepts/fencing-tokens/) narrow the gap considerably — they
protect the *resource* even when a holder goes stale — but their guarantee has
explicit bounds, documented honestly rather than hand-waved.

## Where to go next

- [Quick start](/start/quickstart/) — a server and a lock in two minutes.
- [How it works](/concepts/how-it-works/) — sessions, leases, heartbeats and
  handover in detail.
- [Wire protocol](/reference/protocol/) — the full byte-level reference.
