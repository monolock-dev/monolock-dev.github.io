---
title: Observability
description: Health endpoints, the full Prometheus metric set, useful queries, and the two-log model.
---

`-ops-listen` starts the operational HTTP server. It outlives the protocol
listener on shutdown, so probes and scrapes keep working for the whole
shutdown window.

| Endpoint | Meaning |
| -------- | ------- |
| `GET /metrics` | Prometheus text exposition format |
| `GET /healthz` | `200 ok`; `503` as soon as shutdown starts, pulling the instance out of rotation |
| `GET /readyz` | alias of `/healthz`, for standard k8s manifests |

## Metrics

The exposition is written by hand on the standard library — no client
library. Durations are summaries (`_sum`/`_count` pairs, no quantiles), a
deliberate choice over histograms.

| Metric | Type | Meaning |
| ------ | ---- | ------- |
| `monolock_connections_active` | gauge | open sessions |
| `monolock_locks_held` | gauge | locks that have an owner right now |
| `monolock_waiters` | gauge | claims waiting across all queues |
| `monolock_acquires_total` | counter | granted ownerships, i.e. issued fencing tokens |
| `monolock_acl_denials_total` | counter | `ACQUIRE`s refused by the [ACL](/operations/acl/) |
| `monolock_releases_total{reason}` | counter | ended ownerships: `graceful`, `expired`, `io_timeout`, `force` |
| `monolock_protocol_errors_total{code}` | counter | sent `ERROR` messages by [wire code](/reference/errors/) |
| `monolock_connections_accepted_total` | counter | accepted connections |
| `monolock_accept_errors_total` | counter | failed accepts, including descriptor exhaustion backoff |
| `monolock_tls_handshake_errors_total` | counter | failed [TLS handshakes](/operations/tls/) |
| `monolock_heartbeats_total` | counter | handled `HEARTBEAT` messages |
| `monolock_wait_seconds` | summary | time from `ACQUIRE` to `ACQUIRED` |
| `monolock_hold_seconds` | summary | how long ownerships lasted |
| `go_goroutines`, `go_heap_alloc_bytes`, `go_gc_cycles_total` | — | runtime basics |

## Queries worth having

Average wait and hold times over the last five minutes:

```promql
rate(monolock_wait_seconds_sum[5m]) / rate(monolock_wait_seconds_count[5m])
rate(monolock_hold_seconds_sum[5m]) / rate(monolock_hold_seconds_count[5m])
```

Signals worth alerting on:

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

A rising `monolock_protocol_errors_total{code}` broken down by code points
straight at the misbehaving client class — the
[error code reference](/reference/errors/) says what each code means and
whether the client should have retried.

## Logging

The diagnostic log goes to **stderr** — stdout stays clean for the
[audit log](/operations/audit/). `-log-level` picks `debug`, `info`, `warn`
or `error`; `-log-format` picks `text` or `json`. Timestamps are UTC,
RFC 3339.

The two streams answer different questions: the diagnostic log is about the
*server* (what it did and why, at a chosen verbosity), the audit log is about
the *locks* (who owned what, when, and how each ownership ended — always all
of it, or nothing).
