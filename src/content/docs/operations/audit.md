---
title: Audit log
description: A JSON-lines stream of every lock ownership change — events, fields, and logrotate integration.
---

`-audit-log` turns on the audit log: a stream of JSON lines that records
each change of lock ownership. The destination is a file path, or `-` for
stdout. The audit log is separate from the diagnostic log, which goes to
stderr. The audit log is also independent of the diagnostic log level: audit
is fully on or fully off. Storage, rotation, and delivery are external
tasks, for example logrotate or the container log pipeline.

```json
{"time":"2026-08-08T12:00:00Z","event":"granted","lock":"nightly-import","identity":"spiffe://prod/worker/1","remote_addr":"10.0.0.5:52114","token":27262976001,"wait_ms":0}
```

## Events

Each event contains `time` (UTC, RFC 3339), `event`, `lock`, `identity`
(empty without [mTLS](/operations/tls/#client-identity)), and `remote_addr`.
Each event type adds these fields:

| Event | Extra fields | Meaning |
| ----- | ------------ | ------- |
| `granted` | `token`, `wait_ms` | the session became the owner after a wait of `wait_ms` |
| `released` | `token`, `held_ms`, `reason` | an ownership ended; `reason` is `graceful`, `expired`, `io_timeout` or `force` |
| `denied` | — | the [ACL](/operations/acl/) refused an `ACQUIRE` |
| `force_release` | `token` | the admin [force-released](/operations/admin-api/) the lock (the disconnected session also gets a `released` event with reason `force`) |
| `kick_waiter` | — | the admin removed a waiter from a queue |

In the stream, a `released` event always comes before the `granted` event of
the next owner of the same lock. Thus the history of one lock is a clean
alternation. Ownerships never overlap.

## How to read the log

The format is made for `jq`. These commands answer usual questions:

```sh
# who has held "nightly/import", for how long, and why did each hold end?
jq -r 'select(.lock == "nightly/import" and .event == "released")
       | [.time, .identity, .held_ms, .reason] | @tsv' audit.jsonl

# which identities are being denied, and on which locks?
jq -r 'select(.event == "denied") | [.identity, .lock] | @tsv' audit.jsonl | sort | uniq -c

# holds that ended by lease expiry — candidates for a bigger lease or a bug
jq 'select(.event == "released" and .reason == "expired")' audit.jsonl
```

## Rotation

`SIGHUP` closes the audit file and opens it again. Thus logrotate can move
the old file to a different name. In stdout mode, this operation does
nothing. A minimal logrotate policy:

```text
/var/log/monolock/audit.jsonl {
    daily
    rotate 30
    compress
    postrotate
        kill -HUP "$(pidof monolock)"
    endscript
}
```

If the reopen fails, the server keeps the previous file. A loss of audit
data during operation is worse than writes to a renamed file.

## Stdout mode

With `-audit-log -`, the audit stream goes to stdout, and the diagnostic log
stays on stderr. Thus the two streams never mix. In containers, this agrees
with the log pipeline. Stdout is the structured audit feed for delivery.
Stderr is for the operator, and the log levels apply to it.
