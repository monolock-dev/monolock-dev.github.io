---
title: Writing a client
description: What a correct monolock client in any language must do — a checklist with pseudocode.
---

Official clients exist for [Go](/clients/go/); Python, Node.js and Rust are
planned. Until then — or for any other language — the
[wire protocol](/reference/protocol/) is deliberately small: a correct client
is a few hundred lines, and this page is the specification-as-checklist for
writing one.

## The shape of a client

```text
connect(address)                      # TCP, or TLS with a client certificate
send ACQUIRE(version=1, lease_ms, name)
loop:
    msg = read()                      # a PERMANENT reader — see rule 1
    if msg == WAITING:   still queued; keep heartbeating
    if msg == ACQUIRED:  own the lock; remember token; keep heartbeating
    if msg == ERROR:     classify by code range and stop or retry
on any doubt:                         # timeout, EOF, garbage bytes
    close the connection and treat the lock as lost
```

The four messages are laid out byte-for-byte in the
[protocol reference](/reference/protocol/#messages); the rules below are what
turns "can speak the bytes" into "is safe to build on".

## The rules

### 1. Keep a permanent reader

Promotion is a **push**: when you are the next waiter, the server sends
`ACQUIRED` on its own initiative, not as a reply to anything. A client that
only reads after sending will sit on an already-granted lock without knowing
it. Run a read loop for the whole life of the connection.

### 2. Read frames, not packets

TCP is a byte stream. Read exactly the frame the length fields describe
(`read_full` semantics), and never assume one `read()` call returns one
message — or that a message arrives in one piece.

### 3. Derive the heartbeat schedule from the lease

The [heartbeat rules](/reference/protocol/#heartbeats) are normative:

- base interval `lease / 4`;
- shrink by twice the smoothed RTT (EWMA, alpha 0.2), never below a floor
  (the Go client uses 100ms), never above the base interval;
- **at most one heartbeat in flight** — send the next only after the reply;
- give up at `0.8 × lease` without a confirmation, so you always give up
  before the server drops you.

The last point is the safety-critical one: the client must be the pessimist.
If your client can believe it holds a lock the server has already moved on
from, it is wrong even if it passes every happy-path test.

### 4. Treat any reply as the acknowledgement

`WAITING` and `ACQUIRED` double as heartbeat acks — there is no `PONG`. Any
frame from the server means the session is alive and tells you your current
state. There are no sequence numbers to match because rule 3 guarantees only
one heartbeat is ever unanswered.

### 5. Surface the fencing token

Deliver the token from `ACQUIRED` to the code that does the guarded work, and
make it easy to pass along — it is the resource's only defense against a
stale holder ([why](/concepts/fencing-tokens/)). A client API that hides the
token invites unsafe usage.

### 6. Classify errors by code range

Per the [retry contract](/reference/errors/#the-retry-contract): codes below
`0x10` are server conditions — reconnect (immediately after `0x01`, with
backoff otherwise); codes from `0x10` up are client errors — surface and
stop. Classify by *range*, not by enumerating known codes, so future codes
are handled correctly. Branch on the code, never on the reason text.

### 7. Release by closing, and only by closing

There is no `RELEASE` message. Close the connection when the work is done —
or when anything is in doubt: a timeout, an unexpected byte, a failed write.
Close-on-doubt is always safe (the server promotes the next waiter; your
lock is simply gone), while carrying on in an uncertain state never is.

### 8. Losing the lock must stop the work

When the session ends — heartbeat timeout, EOF, `ERROR` — whatever the lock
guarded must be told to stop (cancel a context, set a flag, kill a task).
Re-acquiring is a new `ACQUIRE` on a new connection, at the back of the FIFO
queue; there is no silent re-acquisition.

## Testing against a real server

A local server is one command:

```sh
docker run -p 7070:7070 ghcr.io/monolock-dev/monolock
```

Scenarios worth scripting, in rough order of how often they catch bugs:

1. two clients, one lock: the second gets `WAITING`, then `ACQUIRED` when the
   first disconnects — *without* sending anything (tests rule 1);
2. hold a lock past several heartbeat intervals (tests rule 3's cadence);
3. drop the network mid-hold (a firewall rule, a proxy you kill): the client
   must give up before the lease and stop the work (tests rules 3 and 8);
4. server restart mid-queue: expect `ERROR 0x01`, reconnect immediately
   (tests rule 6);
5. send a 300-byte name: expect `ERROR 0x15` and no retry (tests rule 6).

If you write a client, tell us — the plan is to list community clients here.
