---
title: Capacity & limits
description: What bounds a monolock server — file descriptors — and how it behaves at the boundary.
---

There is no connection limit and no waiter-queue limit built into the server.
Capacity is governed by exactly one system resource, and the failure mode at
the boundary is deliberate and non-fatal.

## One connection, one descriptor

One connection is one open file descriptor, so capacity is whatever
`RLIMIT_NOFILE` allows. Set it where the rest of the process limits live:

- `LimitNOFILE=` in a [systemd unit](/operations/deployment/#systemd)
- `--ulimit nofile=` for [Docker](/operations/deployment/#docker)

Note that the Go runtime raises the soft limit to the hard limit on startup,
so a low `ulimit -n` in an interactive shell does not apply to the server.

## Why waiter queues need no limit

A connection is one claim on one lock, so the waiters of every lock together
can never outnumber the open connections. Bounding descriptors bounds the
queues for free; a separate queue limit would just be a second, redundant
knob that could disagree with the first.

## Behavior at the boundary

Once descriptors run out, `accept` starts failing. The server **backs off and
retries** rather than exiting, and picks up the queued connections as soon as
sessions free descriptors up. Failed accepts are counted in
`monolock_accept_errors_total` — alert on it climbing (see
[Observability](/operations/observability/)).

Until then, clients past the limit sit connected in the kernel's accept queue
with no reply and time out on their own side. From the client's point of view
that is indistinguishable from a slow network, and the standard reaction —
give up, back off, retry — is the right one.

## Memory

Per-session state is small and fixed: a name (≤ 255 bytes), a lease, a
timestamp, a queue position. There is no per-lock history and nothing is
persisted; memory scales linearly with open connections and is unlikely to be
the binding constraint before descriptors are.
