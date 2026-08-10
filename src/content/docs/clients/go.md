---
title: Go client
description: The official Go client — Do, DoRetry, configuration and error semantics.
---

[monolock-go](https://github.com/monolock-dev/monolock-go) is the official Go
client. One lock is one TCP connection. `Do` blocks until this process owns
the named lock, runs your function for exactly as long as the server keeps
confirming ownership, and releases the lock on the way out.

## Install

```sh
go get github.com/monolock-dev/monolock-go
```

## Use

```go
import monolock "github.com/monolock-dev/monolock-go"

c := monolock.New(monolock.Config{Address: "127.0.0.1:7070"})

// Blocks until this process owns "nightly-import", runs the function, and
// releases the lock when it returns. The lease is this client's
// failure-detection window: how long the lock may sit behind a dead holder
// before moving on.
err := c.Do(ctx, "nightly-import", 2*time.Second,
    func(ctx context.Context, token uint64) error {
        // token is the fencing token of this grant. Hand it to the resource
        // the lock guards with every write — a conditional update, a CAS —
        // and have the resource reject anything with a smaller token than
        // the largest it has seen. That fences out a previous holder that
        // woke up after losing the lock.
        //
        // ctx is cancelled the moment ownership stops being confirmed.
        for {
            select {
            case <-ctx.Done():
                return nil // the lock is gone; Do reports why
            case job := <-jobs:
                if err := process(ctx, job, token); err != nil {
                    return err
                }
            }
        }
    })
```

The function's context is cancelled on heartbeat confirmation timeout, EOF,
connection error, server shutdown, or cancellation of `Do`'s own context.
Once it is cancelled the work it guarded must stop; call `Do` again to queue
up for a new turn — there is no silent re-acquisition, and a new turn means a
new position at the back of the FIFO queue.

Cancelling `Do`'s own context is a **graceful stop, not a loss**. While still
queueing it aborts at once; once the function is running it only asks the
function to stop — the lock stays held, heartbeats and all, until the
function winds down and returns, so a routine shutdown never hands the lock
over while the work is still finishing. The safety net for a holder that
cannot wind down is the lease itself: kill the process and the lock moves on
within it.

`Do` makes exactly one attempt: a dial failure, a connection dropped while
still queueing, or a server rejection comes back as an error, and
[retrying is the caller's decision](#errors). What `Do` does block on is the
queue itself — a healthy connection in the `WAITING` state waits as long as
the context allows.

The lock is released whenever the function returns — or panics — with no
release call to forget. Closing the connection *is* the release as far as the
server is concerned, so the next waiter is promoted at once instead of
waiting out the lease.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `Address` | — | `host:port` of the server, required |
| `Dialer` | `&net.Dialer{}` | anything with `DialContext`: a `*tls.Dialer` reaches a server running with [`-tls-cert`](/operations/tls/) (its client certificate is the client's [identity](/operations/tls/#client-identity) for the server's ACL and audit log), a `*net.Dialer` tunes dial timeouts, keep-alives or the source address |

Everything else is derived from the lease passed to `Do`: heartbeats go out
every `lease/4` minus a safety margin of twice the smoothed round trip, never
more often than every 100ms, and silence longer than `lease * 0.8` — whether
during the ACQUIRE handshake or while holding the lock — makes the client
give up, always before the server would. See
[the heartbeat rules](/reference/protocol/#heartbeats).

## Errors

`Do` returns exactly what happened. Before the function ever runs: invalid
input as the protocol's own validation errors (`protocol.ErrEmptyName`,
`protocol.ErrNameTooLong`, `protocol.ErrInvalidLease`), a dial or connection
error as is, and a server rejection as a `*ServerError` carrying the wire
code and reason. A `ServerError` unwraps to the canonical protocol error, so
`errors.Is(err, protocol.ErrShuttingDown)` works. `ServerError.Temporary`
reports whether a new attempt may help — following
[the code ranges](/reference/errors/#the-retry-contract): codes below `0x10`
are server conditions (e.g. shutting down), codes from `0x10` up are client
errors the same bytes would hit again.

`DoRetry` is `Do` with the retry loop built in: transient acquisition
failures — a dropped dial or connection, a temporary rejection — are retried
with exponential backoff and jitter, from 100ms doubling to 5s, until the
context is cancelled, while invalid input and permanent rejections return at
once. Every attempt is a fresh position at the back of the FIFO queue. Once
the function has run, its outcome is returned with no second run: whether
half-done work may be repeated is a property of the work, not of the lock.

Once the function runs, `Do` returns its error. If the lock was lost while
the function was still running, the cause — `ErrHeartbeatTimeout`,
`ErrConnectionClosed`, `ErrProtocolViolation`, or a `*ServerError` — is
joined in even when the function returned nil, because its last actions may
have run without the lock. A graceful stop through `Do`'s own context is not
a loss and joins nothing.

## TLS

Pass a `*tls.Dialer` to reach a [TLS-enabled server](/operations/tls/); with
mTLS the client certificate doubles as the client's identity:

```go
c := monolock.New(monolock.Config{
    Address: "locks.internal:7070",
    Dialer: &tls.Dialer{Config: &tls.Config{
        RootCAs:      serverCAPool,
        Certificates: []tls.Certificate{clientCert},
    }},
})
```
