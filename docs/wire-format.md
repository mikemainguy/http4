# HTTP4 Datagram Wire Format — v2

The packet format for the HTTP4 sandbox. It refines §3 of the proposal (vrek
`doc-sjj28a2`) and fills in the parts the proposal leaves undefined. The golden
vectors in [`testdata/wire/vectors.json`](../testdata/wire/vectors.json) are
normative: the Go (`server/internal/wire`) and TypeScript
(`client/src/wire.ts`) codecs must both encode and decode them byte for byte.

v1 adds the META packet (0x06) so that a response can carry its
Content-Type and validators (vrek iss-tj4v2z2). Without them Chrome refuses
HTTP4-delivered module scripts (strict MIME checking; vrek finding
`fnd-7ecs69k`). v0 packets are unchanged.

v2 adds three packet types for session-wide loss detection (vrek
iss-fbzcsr1), negotiated per session with HELLO. See
[Capabilities](#capabilities-v2). They are additive: a peer that never
negotiates them sees exactly v1, and every v1 packet is unchanged.

## Transport

Each HTTP4 packet is exactly one WebTransport datagram: no batching, no
fragmentation. Datagrams can be lost, duplicated, or reordered, and the
protocol above the codec handles all three.

A packet is never larger than the session's `maxDatagramSize` as the browser
reports it at runtime (`transport.datagrams.maxDatagramSize`). **Never assume
1200.** Chrome 153 reports 1024 on a loopback session (vrek finding
`fnd-6fk8gs0`).

QUIC already encrypts and authenticates every datagram. The proposal's
"Encrypted Byte Stream" is therefore just the raw asset bytes; HTTP4 adds no
encryption layer of its own.

## Encoding rules

- Every integer is unsigned and **big-endian**.
- Offsets and sizes are `u32`, which caps an asset at 4 GiB − 1 bytes.
- Byte ranges are half-open: `[start, end)`.
- A decoder rejects a packet that has an unknown type, is shorter than its
  layout, carries trailing bytes after a fixed-size layout, or breaks one of
  the per-type rules below. A rejected packet is dropped; it never tears
  down the session.

## Common header (9 bytes)

| Offset | Size | Field  | Notes |
|---|---|---|---|
| 0 | 1 | `type`   | `0x01` REQ, `0x02` DATA, `0x03` GRANT, `0x04` RESEND, `0x05` ERROR, `0x06` META; v2: `0x07` HELLO, `0x08` DATA_SEQ, `0x09` RESEND_SEQ |
| 1 | 8 | `rpc_id` | Chosen by the client: 8 bytes from `crypto.getRandomValues`. Scopes every later packet of that request/response. |

`rpc_id` is only a correlation handle. QUIC already authenticates the
session, so it does not need to be unguessable to be safe. It is random so
that two outstanding requests never collide.

## Packet types

### `0x01` REQ — client → server (15 + n bytes)

| Offset | Size | Field           | Notes |
|---|---|---|---|
| 9  | 4 | `initial_grant` | The server may send bytes `[0, initial_grant)` straight away, before any GRANT. |
| 13 | 2 | `id_len`        | Length of `asset_id` in bytes; must be ≥ 1. |
| 15 | n | `asset_id`      | UTF-8, exactly `id_len` bytes, followed by nothing. |

**Unscheduled bytes are client-authorized.** In Homa, a sender may push a fixed
amount of unscheduled data (about one RTT's worth) before any grant arrives. In
HTTP4 the client names that amount itself in `initial_grant`, and the server
treats it exactly like a GRANT for `[0, initial_grant)`. `initial_grant = 0`
means "just tell me the size". The server therefore never sends a byte the
client did not authorize, which is what goal G2 measures (zero un-granted
bytes, with no exception for a first burst).

A retransmitted REQ reuses the same `rpc_id`. The server must treat it as the
same RPC, never start a second one, and answers it with META and packet 0
again.

### `0x02` DATA — server → client (17 + n bytes)

| Offset | Size | Field        | Notes |
|---|---|---|---|
| 9  | 4 | `total_size` | Size of the whole asset. The same value in every DATA packet of the RPC. |
| 13 | 4 | `offset`     | Where `payload` starts within the asset. |
| 17 | n | `payload`    | Asset bytes `[offset, offset + n)`. Can be empty. |

Rule: `offset + n ≤ total_size`.

**Packet 0** is the DATA packet at `offset = 0`. It is always sent in response
to a REQ, even when `initial_grant = 0` or the asset is empty. In that case its
payload is empty and it exists only to deliver `total_size`. An empty payload
is not un-granted data.

Max payload per packet = `maxDatagramSize − 17` (1007 bytes at Chrome's 1024).

### `0x03` GRANT — client → server (14 bytes)

| Offset | Size | Field            | Notes |
|---|---|---|---|
| 9  | 4 | `max_offset`     | The server may send bytes `[0, max_offset)` of this RPC. |
| 13 | 1 | `priority_class` | 0 = most urgent. Phase 1 carries it but ignores it. |

A grant is cumulative and only ever rises. The server keeps the highest
`max_offset` it has seen for the RPC and ignores lower ones, so a grant that
arrives late or twice does no harm. A `max_offset` beyond `total_size` is
clamped to `total_size`.

### `0x04` RESEND — client → server (17 bytes)

| Offset | Size | Field   | Notes |
|---|---|---|---|
| 9  | 4 | `start` | First missing byte. |
| 13 | 4 | `end`   | One past the last missing byte. |

Rule: `start < end`. The server resends `[start, end)` clipped to the current
grant. Resending bytes that were already granted never counts against G2.

### `0x05` ERROR — server → client (10 bytes)

| Offset | Size | Field  | Notes |
|---|---|---|---|
| 9 | 1 | `code` | `0x01` NOT_FOUND (unknown `asset_id`), `0x02` BAD_REQUEST, `0x03` UNKNOWN_RPC (GRANT/RESEND for an `rpc_id` the server has no state for). |

ERROR ends the RPC. The proposal does not define it; it was added so that a
failed request gets an answer instead of silence. A decoder accepts unknown
`code` values so that codes can be added later without breaking older
decoders.

### `0x06` META — server → client (10 + fields bytes)

| Offset | Size | Field   | Notes |
|---|---|---|---|
| 9 | 1 | `count` | Number of fields that follow; at most 4. |

Each field, repeated `count` times:

| Size | Field       | Notes |
|---|---|---|
| 1 | `name_len`  | |
| n | `name`      | One of `content-type`, `etag`, `last-modified`, `cache-control`, exactly as written (lowercase). |
| 2 | `value_len` | |
| m | `value`     | 1..65535 bytes of printable ASCII (0x20–0x7E), with no leading or trailing space. |

A decoder rejects an unknown or differently-cased name, a repeated name, an
empty or non-printable value, and trailing bytes after the last field. There
is no `content-encoding`: DATA payloads are always the raw asset bytes. Fields
keep their order on the wire; the server sends them in the order listed above.

META is the response's metadata, like HTTP response headers:

- **When:** the server sends META for an RPC immediately before its packet 0,
  and again before packet 0 whenever a repeated REQ arrives. It never sends
  META for a request that got ERROR.
- **Grants:** META is not body data, so it needs no grant and never counts
  toward G2's un-granted bytes.
- **Size:** META must fit in one datagram. The server keeps it within 512
  bytes, dropping the least important fields (cache-control, then
  last-modified, then etag) rather than exceed that.
- **Completion:** the client treats a request as complete only when it has
  both every body byte and the META. If the body is complete and META is
  missing, it recovers the same way as for a lost packet 0: it repeats the REQ.

## Capabilities (v2)

A client can offer optional features for its session with HELLO. The server
turns on what it supports and ignores the rest. **Compatibility rests on one
rule, already true of every decoder since v0: a packet with an unknown type is
dropped without ending the session.** So:

| Server | Client | What happens |
|---|---|---|
| v1 (no HELLO support) | v2 | HELLO is dropped as an unknown type. The server sends plain DATA, and the client uses per-transfer loss detection as in v1. |
| v2 | v1 (never sends HELLO) | Plain DATA, as in v1. |
| v2 with `-no-seq` | v2 | HELLO is ignored: plain DATA. |
| v2 | v2 with `sessionSeq: false` | No HELLO: plain DATA. |
| v2 | v2 | DATA_SEQ once the server has seen HELLO; RESEND_SEQ accepted. |

A client must accept DATA and DATA_SEQ at any time. Packets sent before the
server saw HELLO are plain DATA, so during the switch-over both kinds can
arrive for one RPC.

### `0x07` HELLO — client → server (13 bytes)

| Offset | Size | Field  | Notes |
|---|---|---|---|
| 1 | 8 | `rpc_id` | Unused; sent as 0. |
| 9 | 4 | `caps` | Capability bits. Bit 0 = SESSION_SEQ (DATA_SEQ and RESEND_SEQ). A server ignores bits it doesn't know. |

The client sends HELLO when the session opens and again with its first few
REQs, since datagrams can be lost, until a DATA_SEQ shows the server took it
up. Repeats are harmless: a capability, once on, stays on for the session.

### `0x08` DATA_SEQ — server → client (21 + n bytes)

DATA plus a session sequence number. Every rule of DATA applies, including
G2's accounting: DATA_SEQ is DATA.

| Offset | Size | Field        | Notes |
|---|---|---|---|
| 9  | 4 | `total_size` | As in DATA. |
| 13 | 4 | `offset`     | As in DATA. |
| 17 | 4 | `seq`        | Session sequence number. |
| 21 | n | `payload`    | As in DATA. |

From the moment SESSION_SEQ is on, every DATA the server sends in that
session goes out as DATA_SEQ, whatever the RPC and including resends. It is
numbered 0, 1, 2, … in send order, and a resend gets a new number. A number
is used up even if its datagram is lost, so a gap in the numbers is exactly a
lost datagram. It works like QUIC's packet numbers, across all RPCs.

`seq` is a u32. At ~1183 bytes per datagram, 2³² numbers is about 5 TB in one
session, which is unreachable in practice. If a session did get there, the
server falls back to plain DATA for the rest of it, rather than wrap. A u32
keeps the header 4 bytes smaller than a u64 would, and plain numbers in
JavaScript, with no wraparound arithmetic.

Max payload per packet = `maxDatagramSize − 21`.

### `0x09` RESEND_SEQ — client → server (17 bytes)

| Offset | Size | Field   | Notes |
|---|---|---|---|
| 1  | 8 | `rpc_id` | Unused; sent as 0. |
| 9  | 4 | `start` | First lost sequence number. |
| 13 | 4 | `end`   | One past the last. |

Rule: `start < end`. The client names lost datagrams by number and doesn't
need to know which RPC they belonged to. The server remembers what each
recent number carried (RPC, offset, length; the last 65536 numbers) and
resends those bytes under new numbers, clipped exactly as RESEND is: to what
is granted and already sent.
- **Each number is resent at most once**, so a client may repeat a
  RESEND_SEQ in case it was lost.
- **A lost repair** shows up as a new missing number, which the client asks
  for in turn.
- **A number the server no longer remembers**, or whose RPC has ended, is
  skipped. The client's per-transfer recovery (the tail probe and the stall
  timer) still covers it.

A server that never negotiated SESSION_SEQ drops RESEND_SEQ as a protocol
violation.

**Client detection:** RACK across the session. A number is a loss once at
least 3 later numbers have arrived and it has stayed missing for the
reordering window. Unlike per-transfer detection, this finds a transfer's
lost *last* packet as soon as any later packet of the session arrives.

## Size limits at a glance

| Type   | Size        | At `maxDatagramSize` = 1024 |
|---|---|---|
| REQ    | 15 + id_len | id_len ≤ 1009 |
| DATA   | 17 + n      | n ≤ 1007 |
| GRANT  | 14          | |
| RESEND | 17          | |
| ERROR  | 10          | |
| META   | 10 + Σ(3 + name + value) | server keeps it ≤ 512 |
| HELLO  | 13          | |
| DATA_SEQ | 21 + n    | n ≤ 1003 |
| RESEND_SEQ | 17      | |
