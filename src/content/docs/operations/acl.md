---
title: ACL authorization
description: Mapping mTLS identities to the lock names they may acquire, with glob rules and deny-by-default semantics.
---

`-acl-file` points at a JSON file mapping client identities to the lock names
they may acquire. It requires `-tls-client-ca`: the identity comes from the
verified [mTLS certificate](/operations/tls/#client-identity), and without
mTLS there is nothing to authorize. Without an ACL file authorization is
disabled and every client may acquire every lock.

```json
{
  "rules": [
    { "identity": "spiffe://prod/worker/*", "locks": ["nightly/*", "shard-?"] },
    { "identity": "admin.svc.cluster.local", "locks": ["*"] }
  ]
}
```

## Semantics

**Deny by default, union of matches**: a lock is allowed if *any* `locks`
pattern of *any* rule whose `identity` pattern matches the client allows it.
Rule order carries no meaning — there are no priorities, no overrides, and no
deny rules, which keeps every ACL file's meaning obvious from a glance.

"Allow everything" is an explicit `"*"`, not an absent rule. A rule must name
an identity pattern and at least one locks pattern, since a rule that can
never allow anything is a config mistake worth failing on.

With the file above:

| Client identity | Lock | Result |
| --------------- | ---- | ------ |
| `spiffe://prod/worker/7` | `nightly/import` | allowed — first rule |
| `spiffe://prod/worker/7` | `shard-3` | allowed — `?` matches one character |
| `spiffe://prod/worker/7` | `shard-31` | **denied** — `?` matches exactly one |
| `admin.svc.cluster.local` | anything | allowed — explicit `*` |
| `spiffe://staging/worker/1` | `nightly/import` | **denied** — no matching identity |

## Glob language

Both sides of a rule are glob patterns:

- `*` matches any substring, **including `/`**
- `?` matches exactly one character
- everything else is a literal

A pattern matches the whole string, not a part of it, and strings are raw
UTF-8 — case sensitive, never normalised. The same glob language is used by
the admin API's `?match=` [filter](/operations/admin-api/), so patterns you
write in rules behave identically when querying.

Note that `*` crossing `/` is deliberate: lock names are flat strings, and
`/` is just a popular character in them, not a hierarchy the server knows
about. `nightly/*` matches `nightly/import` and `nightly/a/b` alike.

## Reload

`SIGHUP` re-reads the file. When the reload fails — unreadable file, invalid
JSON, a bad rule — the previous rules are kept and the error is logged. See
the [SIGHUP contract](/operations/configuration/#sighup-reload-external-files).

## Denials

A refused `ACQUIRE` is answered with `ERROR` code `0x18`
(["not authorized for lock"](/reference/errors/)) and the connection is
closed. That is a *client* error code: the same bytes will fail the same way,
so a well-behaved client surfaces it and stops rather than retrying.

Denials are visible in three places:

- counted in `monolock_acl_denials_total`
  ([metrics](/operations/observability/#metrics))
- logged at info level
- recorded in the [audit log](/operations/audit/) as `denied` events, with
  the identity and the lock name
