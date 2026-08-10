---
title: Admin API
description: Lock introspection, force-release and kicking waiters over a local HTTP API.
---

`-admin-listen 127.0.0.1:7071` starts an HTTP API for the operator: lock
introspection, force-release and kicking waiters. Access control is the bind
address — the API has no authentication of its own; from outside it is
reached through `ssh -L` or `kubectl port-forward`. An address beyond
loopback logs a warning at startup.

| Endpoint | Meaning |
| -------- | ------- |
| `GET /api/info` | version, uptime, effective configuration, live counts |
| `GET /api/locks` | every lock with an owner or a non-empty queue; `?match=<glob>` filters by name |
| `GET /api/locks/{name}` | one lock with its full waiter queue |
| `POST /api/locks/{name}/release` | force-release: disconnect the owner, the next waiter is promoted |
| `DELETE /api/locks/{name}/waiters/{remote_addr}` | kick a waiter out of the queue |

Lock names may contain `/`, which in an endpoint path must be URL-encoded:
`/api/locks/nightly%2Fimport`.

## Introspection

```sh
curl -s localhost:7071/api/info
```

```json
{
  "version": "v1.0.0",
  "uptime_ms": 86400000,
  "config": {
    "listen": "0.0.0.0:7070",
    "ops_listen": "0.0.0.0:9090",
    "tls": true,
    "mtls": true,
    "acl_file": "/etc/monolock/acl.json",
    "audit_log": "/var/log/monolock/audit.jsonl",
    "io_timeout_ms": 5000
  },
  "locks": 2,
  "sessions": 5
}
```

`GET /api/locks` lists every lock that currently has an owner or a non-empty
queue — an idle lock name is not a thing the server stores. `?match=` takes
the same [glob language](/operations/acl/#glob-language) as ACL rules:

```sh
curl -s 'localhost:7071/api/locks?match=nightly/*'
```

```json
{
  "locks": [
    {
      "name": "nightly/import",
      "holder": {
        "identity": "spiffe://prod/worker/1",
        "remote_addr": "10.0.0.5:52114",
        "since": "2026-08-08T12:00:00Z",
        "lease_ms": 2000,
        "token": 27262976001
      },
      "waiters": [
        {
          "identity": "spiffe://prod/worker/2",
          "remote_addr": "10.0.0.6:41230",
          "queued_at": "2026-08-08T12:00:07Z"
        }
      ]
    }
  ]
}
```

`GET /api/locks/{name}` returns the same shape for a single lock, with its
full waiter queue in FIFO order. `identity` is empty unless
[mTLS](/operations/tls/#client-identity) is on.

## Force-release

```sh
curl -s -X POST localhost:7071/api/locks/nightly%2Fimport/release
```

Disconnects the owner; the next waiter is promoted immediately. Use it when a
holder is alive enough to heartbeat but too broken to finish — the one case
the lease cannot detect for you.

## Kicking a waiter

```sh
curl -s -X DELETE localhost:7071/api/locks/nightly%2Fimport/waiters/10.0.0.6:41230
```

Removes one waiter from the queue, addressed by its `remote_addr` exactly as
introspection reported it. The rest of the queue keeps its order.

## What the affected client sees

A force-released owner and a kicked waiter are told why with `ERROR` code
`0x02` ("closed by administrator") before their connection closes. That is a
*server condition* code, so a standard client reconnects with backoff and
rejoins the queue at the tail — an admin action is never a client bug.

Force-release is safe against the just-released holder for the same reason
lease expiry is: the next owner's [fencing token](/concepts/fencing-tokens/)
is larger, so the guarded resource fences the kicked holder out by itself.

## Paper trail

Admin actions land in the [audit log](/operations/audit/) as `force_release`
and `kick_waiter` events, and forced releases count under
`monolock_releases_total{reason="force"}` in the
[metrics](/operations/observability/#metrics).
