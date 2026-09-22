# HTTP4 Datagram Wire Format — v0

The packet format for the HTTP4 sandbox. It refines §3 of the proposal (vrek
`doc-sjj28a2`) and fills in the parts the proposal leaves undefined. The golden
vectors in [`testdata/wire/vectors.json`](../testdata/wire/vectors.json) are
normative: the Go (`server/internal/wire`) and TypeScript
(`client/src/wire.ts`) codecs must both encode and decode them byte for byte.

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
| 0 | 1 | `type`   | `0x01` REQ, `0x02` DATA, `0x03` GRANT, `0x04` RESEND, `0x05` ERROR |
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
same RPC, never start a second one.

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

## Size limits at a glance

| Type   | Size        | At `maxDatagramSize` = 1024 |
|---|---|---|
| REQ    | 15 + id_len | id_len ≤ 1009 |
| DATA   | 17 + n      | n ≤ 1007 |
| GRANT  | 14          | |
| RESEND | 17          | |
| ERROR  | 10          | |
