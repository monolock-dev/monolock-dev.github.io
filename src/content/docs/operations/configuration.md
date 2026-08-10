---
title: Configuration
description: Every flag, its environment variable, and the SIGHUP reload contract.
---

There is no config file. Every knob is a flag, and every flag has a matching
environment variable; a **flag wins over the environment, which wins over the
default**. `monolock -h` prints the same table as below.

## Flags

| Flag | Environment variable | Default | Meaning |
| ---- | -------------------- | ------- | ------- |
| `-listen` | `MONOLOCK_LISTEN_ADDRESS` | `0.0.0.0:7070` | address to listen on |
| `-ops-listen` | `MONOLOCK_OPS_LISTEN_ADDRESS` | _(empty)_ | address of the ops HTTP server: `/metrics`, `/healthz`, `/readyz`; empty disables it |
| `-admin-listen` | `MONOLOCK_ADMIN_LISTEN_ADDRESS` | _(empty)_ | address of the admin HTTP API; empty disables it |
| `-tls-cert` | `MONOLOCK_TLS_CERT` | _(empty)_ | PEM server certificate; with `-tls-key` enables TLS on the protocol port |
| `-tls-key` | `MONOLOCK_TLS_KEY` | _(empty)_ | PEM private key for `-tls-cert` |
| `-tls-client-ca` | `MONOLOCK_TLS_CLIENT_CA` | _(empty)_ | PEM CA pool for client certificates; enables mTLS |
| `-acl-file` | `MONOLOCK_ACL_FILE` | _(empty)_ | JSON file with identity → lock name glob rules; requires `-tls-client-ca`, empty disables authorization |
| `-audit-log` | `MONOLOCK_AUDIT_LOG` | _(empty)_ | audit log destination: a file path or `-` for stdout; empty disables audit |
| `-io-timeout` | `MONOLOCK_IO_TIMEOUT` | `5s` | deadline for a single read or write on a connection |
| `-log-level` | `MONOLOCK_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `-log-format` | `MONOLOCK_LOG_FORMAT` | `text` | `text` or `json` |

Durations are Go duration strings, e.g. `5s` or `250ms`.

## What is deliberately absent

There is **no lease knob and no heartbeat knob**: each client picks its own
lease in `ACQUIRE`, and the client derives its heartbeat schedule from that
(see [How it works](/concepts/how-it-works/#heartbeats)). The server's only
I/O policy is `-io-timeout` — the deadline for a single read or write, which
bounds how long one stuck socket can occupy the server.

There is also no connection or queue limit — see
[Capacity & limits](/concepts/capacity/) for what bounds the server instead.

## SIGHUP: reload external files

`SIGHUP` is the single "re-read your external files" signal. It re-reads:

- the TLS certificate, key and client CA — so certificates
  [rotate without a restart](/operations/tls/#certificate-reload)
- the [ACL file](/operations/acl/#reload)
- and reopens the [audit log](/operations/audit/#rotation) for logrotate

A failed reload keeps the previous state: a botched certificate rotation
degrades to stale certificates, a broken ACL file keeps the old rules, a
failed audit reopen keeps writing to the old (possibly renamed) file. The
failure is logged; the server never trades a running configuration for a
broken one.

## Example

```sh
monolock \
  -listen 0.0.0.0:7070 \
  -ops-listen 0.0.0.0:9090 \
  -admin-listen 127.0.0.1:7071 \
  -tls-cert /etc/monolock/server.crt \
  -tls-key /etc/monolock/server.key \
  -tls-client-ca /etc/monolock/clients-ca.crt \
  -acl-file /etc/monolock/acl.json \
  -audit-log /var/log/monolock/audit.jsonl \
  -log-format json
```

The same configuration via environment (useful for containers):

```sh
MONOLOCK_LISTEN_ADDRESS=0.0.0.0:7070 \
MONOLOCK_OPS_LISTEN_ADDRESS=0.0.0.0:9090 \
MONOLOCK_ADMIN_LISTEN_ADDRESS=127.0.0.1:7071 \
MONOLOCK_TLS_CERT=/etc/monolock/server.crt \
MONOLOCK_TLS_KEY=/etc/monolock/server.key \
MONOLOCK_TLS_CLIENT_CA=/etc/monolock/clients-ca.crt \
MONOLOCK_ACL_FILE=/etc/monolock/acl.json \
MONOLOCK_AUDIT_LOG=/var/log/monolock/audit.jsonl \
MONOLOCK_LOG_FORMAT=json \
monolock
```
