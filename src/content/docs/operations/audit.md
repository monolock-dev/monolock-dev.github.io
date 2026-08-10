---
title: Audit log
description: A JSON-lines stream of every lock ownership change — events, fields, and logrotate integration.
---

`-audit-log` enables the audit log: a stream of JSON lines recording every
change of lock ownership. The destination is a file path, or `-` for stdout.
It is separate from the diagnostic log (which goes to stderr) and independent
of its level: audit is either fully on or off. Storage, rotation and delivery
are external — logrotate, the container log pipeline and so on.

```json
{"time":"2026-08-08T12:00:00Z","event":"granted","lock":"nightly-import","identity":"spiffe://prod/worker/1","remote_addr":"10.0.0.5:52114","token":27262976001,"wait_ms":0}
```

## Events

Every event carries `time` (UTC, RFC 3339), `event`, `lock`, `identity`
(empty without [mTLS](/operations/tls/#client-identity)) and `remote_addr`,
plus:

| Event | Extra fields | Meaning |
| ----- | ------------ | ------- |
| `granted` | `token`, `wait_ms` | the session became the owner after waiting `wait_ms` |
| `released` | `token`, `held_ms`, `reason` | an ownership ended; `reason` is `graceful`, `expired`, `io_timeout` or `force` |
| `denied` | — | an `ACQUIRE` refused by the [ACL](/operations/acl/) |
| `force_release` | `token` | the admin [force-released](/operations/admin-api/) the lock (the kicked session also emits `released` with reason `force`) |
| `kick_waiter` | — | the admin kicked a waiter out of a queue |

In the stream a `released` always precedes the `granted` of the next owner of
the same lock, so the history of any one lock reads as a clean alternation —
no overlapping ownerships, ever.

## Reading it

The format is `jq`-friendly by construction. A few one-liners that answer
real questions:

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

`SIGHUP` closes and reopens the audit file, so logrotate can move the old one
aside; a no-op in stdout mode. A minimal logrotate policy:

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

When the reopen fails the previous file is kept — losing audit mid-flight is
worse than writing to a renamed file.

## Stdout mode

With `-audit-log -` the audit stream goes to stdout while the diagnostic log
stays on stderr, so the two never interleave. In containers this maps cleanly
onto the log pipeline: stdout is the structured audit feed for shipping,
stderr is for humans and log levels.
