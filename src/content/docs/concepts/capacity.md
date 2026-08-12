---
title: Capacity & limits
description: What bounds a monolock server — file descriptors — and how it behaves at the boundary.
---

The server has no built-in connection limit and no built-in waiter-queue
limit. Exactly one system resource controls the capacity. The failure mode at
the boundary is deliberate and not fatal.

## One connection, one descriptor

One connection is one open file descriptor. Thus the capacity is the value
that `RLIMIT_NOFILE` permits. Set this limit at the same location as the
other process limits:

- `LimitNOFILE=` in a [systemd unit](/operations/deployment/#systemd)
- `--ulimit nofile=` for [Docker](/operations/deployment/#docker)

Note: the Go runtime increases the soft limit to the hard limit at startup.
Thus a low `ulimit -n` in an interactive shell does not apply to the server.

## Why waiter queues need no limit

A connection is one claim on one lock. Thus the waiters of all locks
together can never be more than the open connections. A limit on descriptors
is also a limit on the queues, at no cost. A separate queue limit would only
be a second, redundant setting, and the two settings could disagree.

## Behavior at the boundary

When no more descriptors are available, `accept` starts to fail. The server
**waits and retries**, and does not exit. It accepts the queued connections
as soon as sessions release descriptors. The counter
`monolock_accept_errors_total` counts the failed accepts. Set an alert on an
increase of this counter (see
[Observability](/operations/observability/)).

Until that time, clients above the limit stay connected in the accept queue
of the kernel, with no reply, and their own timeout stops them. From the
point of view of the client, this condition is identical to a slow network.
The standard reaction — stop the attempt, wait, and retry — is the correct
reaction.

## Memory

The state for each session is small and fixed: a name (≤ 255 bytes), a
lease, a timestamp, and a queue position. There is no history for each lock,
and nothing is persisted. Memory increases linearly with the open
connections. It is not probable that memory becomes the limit before the
descriptors become the limit.
