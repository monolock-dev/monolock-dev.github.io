---
title: Observability
description: Health endpoints, the full Prometheus metric set, useful queries, and the two-log model.
---

`-ops-listen` starts the operational HTTP server. At shutdown, this server
stops after the protocol listener. Thus probes and scrapes continue to
operate for the full shutdown window.

| Endpoint | Meaning |
| -------- | ------- |
| `GET /metrics` | Prometheus text exposition format |
| `GET /healthz` | `200 ok`; `503` immediately when shutdown starts, which removes the instance from rotation |
| `GET /readyz` | alias of `/healthz`, for standard k8s manifests |

## Metrics

The exposition is written by hand on the standard library, without a client
library. Durations are summaries (`_sum`/`_count` pairs, no quantiles). The
selection of summaries instead of histograms is intentional.

| Metric | Type | Meaning |
| ------ | ---- | ------- |
| `monolock_connections_active` | gauge | open sessions |
| `monolock_locks_held` | gauge | locks that have an owner at this time |
| `monolock_waiters` | gauge | claims that wait, across all queues |
| `monolock_acquires_total` | counter | granted ownerships, that is, issued fencing tokens |
| `monolock_acl_denials_total` | counter | `ACQUIRE`s that the [ACL](/operations/acl/) refused |
| `monolock_releases_total{reason}` | counter | ended ownerships: `graceful`, `expired`, `io_timeout`, `force` |
| `monolock_protocol_errors_total{code}` | counter | sent `ERROR` messages by [wire code](/reference/errors/) |
| `monolock_connections_accepted_total` | counter | accepted connections |
| `monolock_accept_errors_total` | counter | failed accepts, including descriptor exhaustion backoff |
| `monolock_tls_handshake_errors_total` | counter | failed [TLS handshakes](/operations/tls/) |
| `monolock_heartbeats_total` | counter | handled `HEARTBEAT` messages |
| `monolock_wait_seconds` | summary | time from `ACQUIRE` to `ACQUIRED` |
| `monolock_hold_seconds` | summary | the duration of ownerships |
| `go_goroutines`, `go_heap_alloc_bytes`, `go_gc_cycles_total` | — | basic runtime data |

## Useful queries

Average wait and hold times in the last five minutes:

```promql
rate(monolock_wait_seconds_sum[5m]) / rate(monolock_wait_seconds_count[5m])
rate(monolock_hold_seconds_sum[5m]) / rate(monolock_hold_seconds_count[5m])
```

Signals that are good candidates for alerts:

```promql
# holders dying instead of releasing — flaky workers or leases set too tight
rate(monolock_releases_total{reason="expired"}[10m]) > 0

# descriptor exhaustion: accepts failing (see Capacity & limits)
rate(monolock_accept_errors_total[5m]) > 0

# something is being denied — a misdeployed identity or a misedited ACL file
rate(monolock_acl_denials_total[5m]) > 0

# queues building up faster than work drains
monolock_waiters > 100
```

An increase of `monolock_protocol_errors_total{code}`, divided by code,
points directly to the class of client that operates incorrectly. The
[error code reference](/reference/errors/) gives the meaning of each code.
It also tells you if a retry was correct for the client.

## Logging

The diagnostic log goes to **stderr**. Stdout stays clean for the
[audit log](/operations/audit/). `-log-level` selects `debug`, `info`,
`warn` or `error`. `-log-format` selects `text` or `json`. Timestamps are
UTC, RFC 3339.

The two streams answer different questions. The diagnostic log is about the
*server*: what the server did, and why, at a selected verbosity. The audit
log is about the *locks*: who owned what, when, and how each ownership
ended. The audit log always gives all of this, or nothing.
