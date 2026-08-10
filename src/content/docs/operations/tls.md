---
title: TLS & mTLS
description: Encrypting the protocol port, authenticating clients with certificates, and rotating everything on SIGHUP.
---

`-tls-cert` and `-tls-key` (PEM) enable TLS on the protocol port; they are
only valid together. `-tls-client-ca` adds a PEM CA pool for client
certificates and enables **mTLS**: every client must present a certificate
that verifies against the pool, and the connection is rejected at the
handshake otherwise. A client CA without a server certificate and key is a
configuration error.

```sh
monolock \
  -tls-cert /etc/monolock/server.crt \
  -tls-key /etc/monolock/server.key \
  -tls-client-ca /etc/monolock/clients-ca.crt
```

The handshake is completed explicitly before any protocol traffic, bounded by
`-io-timeout` like any other single read; failures are counted in
`monolock_tls_handshake_errors_total`.

## The three modes

| Configuration | Transport | Client identity |
| ------------- | --------- | --------------- |
| no TLS flags | plaintext TCP | empty |
| `-tls-cert` + `-tls-key` | encrypted | empty |
| … + `-tls-client-ca` | encrypted, both sides authenticated | derived from the client certificate |

mTLS is the only source of client identity — there is deliberately no token
or password authentication. If you need [ACL authorization](/operations/acl/)
or identities in the [audit log](/operations/audit/), you need mTLS.

## Client identity

The identity is derived from the verified client certificate:

1. the first **URI SAN** (SPIFFE-friendly), else
2. the first **DNS SAN**, else
3. the **Common Name**.

Every consumer sees the same string: [ACL rules](/operations/acl/) match
against it, the [audit log](/operations/audit/) records it, and the
[admin API](/operations/admin-api/) shows it per holder and waiter. Without
mTLS the identity is empty.

With a SPIFFE-style PKI a certificate carrying
`URI:spiffe://prod/worker/7` yields exactly that string as the identity, which
is what an ACL rule like `spiffe://prod/worker/*` then matches.

## Certificate reload

`SIGHUP` re-reads all three files, so certificates rotate without a restart
and **without dropping existing connections**; the new files apply to every
connection accepted after the signal. A file that fails to load keeps its
previous value, so a botched rotation degrades to stale certificates instead
of a broken listener.

A typical rotation is just:

```sh
cp new-server.crt /etc/monolock/server.crt
cp new-server.key /etc/monolock/server.key
kill -HUP "$(pidof monolock)"
```

Long-lived lock connections are a feature here: a session established under
the old certificate keeps running — rotation never causes a lock handover.

## A lab PKI in four commands

For local experiments (not production key management):

```sh
# CA
openssl req -x509 -newkey ed25519 -nodes -subj "/CN=lab-ca" \
  -keyout ca.key -out ca.crt -days 365
# server certificate
openssl req -newkey ed25519 -nodes -subj "/CN=monolock" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout server.key -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -copy_extensions copy -out server.crt -days 90
# client certificate with a SPIFFE-style identity
openssl req -newkey ed25519 -nodes -subj "/CN=worker" \
  -addext "subjectAltName=URI:spiffe://lab/worker/1" \
  -keyout client.key -out client.csr && \
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -copy_extensions copy -out client.crt -days 90
```

Then run the server with `-tls-cert server.crt -tls-key server.key
-tls-client-ca ca.crt`, and connect with a client configured for
`client.crt` / `client.key` and `ca.crt` as the server CA. The client's
identity everywhere in monolock is `spiffe://lab/worker/1`.
