---
title: Admin API
description: Lock introspection, force-release and kicking waiters over a local HTTP API.
---

`-admin-listen 127.0.0.1:7071` starts an HTTP API for the operator. The API
gives lock introspection, force-release, and removal of waiters. The bind
address is the access control. The API has no authentication of its own. From
an external location, you reach it through `ssh -L` or
`kubectl port-forward`. If the address is not a loopback address, the server
writes a warning to the log at startup.

| Endpoint | Meaning |
| -------- | ------- |
| `GET /api/info` | version, uptime, effective configuration, live counts |
| `GET /api/locks` | each lock that has an owner or a queue that is not empty; `?match=<glob>` filters by name |
| `GET /api/locks/{name}` | one lock with its full waiter queue |
| `POST /api/locks/{name}/release` | force-release: the server disconnects the owner and gives the lock to the next waiter |
| `DELETE /api/locks/{name}/waiters/{remote_addr}` | remove a waiter from the queue |

Lock names can contain `/`. In an endpoint path, you must URL-encode this
character: `/api/locks/nightly%2Fimport`.

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

`GET /api/locks` lists each lock that has an owner or a queue that is not
empty. The server does not store the name of an idle lock. `?match=` uses
the same [glob language](/operations/acl/#glob-language) as the ACL rules:

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

`GET /api/locks/{name}` returns the same shape for one lock, with its full
waiter queue in FIFO sequence. `identity` is empty if
[mTLS](/operations/tls/#client-identity) is not on.

## Force-release

```sh
curl -s -X POST localhost:7071/api/locks/nightly%2Fimport/release
```

This command disconnects the owner. The server immediately gives the lock to
the next waiter. Use it when a holder sends heartbeats but cannot
complete its work. This is the one condition that the lease cannot detect
for you.

## Removal of a waiter

```sh
curl -s -X DELETE localhost:7071/api/locks/nightly%2Fimport/waiters/10.0.0.6:41230
```

This command removes one waiter from the queue. The address is the
`remote_addr` value exactly as introspection reported it. The remaining
queue keeps its sequence.

## What the affected client sees

The server tells a force-released owner and a removed waiter the cause. It
sends `ERROR` code `0x02` ("closed by administrator") before the connection
closes. This is a *server condition* code. Thus a standard client reconnects
with backoff and goes to the tail of the queue. An admin action is never a
client error.

Force-release is safe against the released holder for the same reason as
lease expiry. The [fencing token](/concepts/fencing-tokens/) of the next
owner is larger. Thus the guarded resource itself keeps the removed holder
out.

## Audit records

Admin actions go into the [audit log](/operations/audit/) as `force_release`
and `kick_waiter` events. Forced releases increase
`monolock_releases_total{reason="force"}` in the
[metrics](/operations/observability/#metrics).
