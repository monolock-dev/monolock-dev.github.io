---
title: Error codes
description: Every ERROR code on the wire, and the retry contract the code ranges encode.
---

An `ERROR` frame carries a one-byte code and a human-readable reason (see the
[frame layout](/reference/protocol/#server-to-client)). Clients branch on the
code alone, never on the text.

## Codes

| Code | Meaning | Class |
| ---- | ------- | ----- |
| `0x01` | server shutting down | server condition |
| `0x02` | closed by administrator ([force-release / kick](/operations/admin-api/)) | server condition |
| `0x10` | unsupported protocol version | client error |
| `0x11` | first message must be ACQUIRE | client error |
| `0x12` | duplicate ACQUIRE | client error |
| `0x13` | unknown message type | client error |
| `0x14` | empty lock name | client error |
| `0x15` | lock name too long (> 255 bytes) | client error |
| `0x16` | lock name is not valid UTF-8 | client error |
| `0x17` | lease must be positive | client error |
| `0x18` | not authorized for lock ([ACL](/operations/acl/)) | client error |

## The retry contract

The split is a **range, not a list**:

- **Codes below `0x10` are server conditions.** Nothing is wrong with the
  client, and reconnecting is the right reaction — immediately after a
  shutdown handover (`0x01`), with backoff otherwise.
- **Codes from `0x10` up are client errors.** The same bytes will fail the
  same way, so the client should surface the error and stop rather than
  retry.

Because the split is a range, a client classifies codes it does not know yet
the same way — a future server condition below `0x10` gets retried, a future
client error above it gets surfaced. That is what keeps old clients
well-behaved against newer servers.

## The reason string

The reason is a UTF-8 string for error messages and debugging: the canonical
text of the code, sometimes followed by detail — `unknown message type:
0x7f` — and possibly empty. It is not part of the contract and may change
between server versions; never parse it.

## Observability

Every sent `ERROR` is counted in `monolock_protocol_errors_total{code}`
([metrics](/operations/observability/#metrics)), so a misbehaving client
class shows up as a rising counter labelled with its wire code. ACL denials
(`0x18`) additionally count in `monolock_acl_denials_total` and land in the
[audit log](/operations/audit/) as `denied` events.
