// Encode and decode HTTP4 datagrams as specified in docs/wire-format.md.
// Mirrors server/internal/wire; both must agree with testdata/wire/vectors.json.

export const PacketType = {
  REQ: 0x01,
  DATA: 0x02,
  GRANT: 0x03,
  RESEND: 0x04,
  ERROR: 0x05,
} as const;

export const ErrorCode = {
  NOT_FOUND: 0x01,
  BAD_REQUEST: 0x02,
  UNKNOWN_RPC: 0x03,
} as const;

export const HEADER_LEN = 9; // type + rpc_id
export const DATA_HEADER_LEN = HEADER_LEN + 8; // + total_size + offset
const REQ_FIXED_LEN = HEADER_LEN + 6; // + initial_grant + id_len
const GRANT_LEN = HEADER_LEN + 5;
const RESEND_LEN = HEADER_LEN + 8;
const ERROR_LEN = HEADER_LEN + 1;
const U32_MAX = 0xffff_ffff;

export interface Req {
  type: "REQ";
  rpcId: bigint;
  initialGrant: number; // server may send [0, initialGrant) before any GRANT
  assetId: string;
}

export interface Data {
  type: "DATA";
  rpcId: bigint;
  totalSize: number;
  offset: number;
  payload: Uint8Array; // aliases the decoded buffer
}

export interface Grant {
  type: "GRANT";
  rpcId: bigint;
  maxOffset: number; // server may send [0, maxOffset)
  priority: number; // 0 = most urgent
}

export interface Resend {
  type: "RESEND";
  rpcId: bigint;
  start: number; // missing range [start, end)
  end: number;
}

export interface ErrorPacket {
  type: "ERROR";
  rpcId: bigint;
  code: number;
}

export type Packet = Req | Data | Grant | Resend | ErrorPacket;

export class MalformedPacketError extends Error {
  override name = "MalformedPacketError";
}

/** The most asset bytes one DATA packet can carry in a datagram of this size. */
export function maxPayload(maxDatagramSize: number): number {
  return Math.max(0, maxDatagramSize - DATA_HEADER_LEN);
}

/** A fresh random rpc_id. */
export function newRpcId(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return new DataView(b.buffer).getBigUint64(0);
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

/** Parse one datagram. Throws MalformedPacketError. A DATA payload aliases `b`. */
export function decode(b: Uint8Array): Packet {
  if (b.length < HEADER_LEN) throw new MalformedPacketError(`${b.length} bytes, shorter than the header`);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const rpcId = v.getBigUint64(1);
  const type = b[0];
  switch (type) {
    case PacketType.REQ: {
      if (b.length < REQ_FIXED_LEN) throw new MalformedPacketError(`REQ is ${b.length} bytes, need at least ${REQ_FIXED_LEN}`);
      const n = v.getUint16(13);
      if (n === 0) throw new MalformedPacketError("REQ with empty asset_id");
      if (b.length !== REQ_FIXED_LEN + n) throw new MalformedPacketError(`REQ is ${b.length} bytes, id_len says ${REQ_FIXED_LEN + n}`);
      let assetId: string;
      try {
        assetId = utf8Decoder.decode(b.subarray(REQ_FIXED_LEN));
      } catch {
        throw new MalformedPacketError("REQ asset_id is not UTF-8");
      }
      return { type: "REQ", rpcId, initialGrant: v.getUint32(9), assetId };
    }
    case PacketType.DATA: {
      if (b.length < DATA_HEADER_LEN) throw new MalformedPacketError(`DATA is ${b.length} bytes, need at least ${DATA_HEADER_LEN}`);
      const p: Data = { type: "DATA", rpcId, totalSize: v.getUint32(9), offset: v.getUint32(13), payload: b.subarray(DATA_HEADER_LEN) };
      checkDataBounds(p);
      return p;
    }
    case PacketType.GRANT:
      if (b.length !== GRANT_LEN) throw new MalformedPacketError(`GRANT is ${b.length} bytes, want ${GRANT_LEN}`);
      return { type: "GRANT", rpcId, maxOffset: v.getUint32(9), priority: v.getUint8(13) };
    case PacketType.RESEND: {
      if (b.length !== RESEND_LEN) throw new MalformedPacketError(`RESEND is ${b.length} bytes, want ${RESEND_LEN}`);
      const p: Resend = { type: "RESEND", rpcId, start: v.getUint32(9), end: v.getUint32(13) };
      checkResendRange(p);
      return p;
    }
    case PacketType.ERROR:
      if (b.length !== ERROR_LEN) throw new MalformedPacketError(`ERROR is ${b.length} bytes, want ${ERROR_LEN}`);
      return { type: "ERROR", rpcId, code: v.getUint8(9) };
  }
  throw new MalformedPacketError(`unknown type 0x${type!.toString(16).padStart(2, "0")}`);
}

/** Encode one packet. Refuses anything decode would reject. */
export function encode(p: Packet): Uint8Array<ArrayBuffer> {
  checkU64(p.rpcId);
  switch (p.type) {
    case "REQ": {
      checkU32("initialGrant", p.initialGrant);
      if (!p.assetId.isWellFormed()) throw new MalformedPacketError("REQ asset_id is not valid Unicode");
      const id = utf8Encoder.encode(p.assetId);
      if (id.length === 0 || id.length > 0xffff) throw new MalformedPacketError(`REQ asset_id length ${id.length} outside 1..65535`);
      const { b, v } = header(PacketType.REQ, p.rpcId, REQ_FIXED_LEN + id.length);
      v.setUint32(9, p.initialGrant);
      v.setUint16(13, id.length);
      b.set(id, REQ_FIXED_LEN);
      return b;
    }
    case "DATA": {
      checkU32("totalSize", p.totalSize);
      checkU32("offset", p.offset);
      checkDataBounds(p);
      const { b, v } = header(PacketType.DATA, p.rpcId, DATA_HEADER_LEN + p.payload.length);
      v.setUint32(9, p.totalSize);
      v.setUint32(13, p.offset);
      b.set(p.payload, DATA_HEADER_LEN);
      return b;
    }
    case "GRANT": {
      checkU32("maxOffset", p.maxOffset);
      checkU8("priority", p.priority);
      const { b, v } = header(PacketType.GRANT, p.rpcId, GRANT_LEN);
      v.setUint32(9, p.maxOffset);
      v.setUint8(13, p.priority);
      return b;
    }
    case "RESEND": {
      checkU32("start", p.start);
      checkU32("end", p.end);
      checkResendRange(p);
      const { b, v } = header(PacketType.RESEND, p.rpcId, RESEND_LEN);
      v.setUint32(9, p.start);
      v.setUint32(13, p.end);
      return b;
    }
    case "ERROR": {
      checkU8("code", p.code);
      const { b, v } = header(PacketType.ERROR, p.rpcId, ERROR_LEN);
      v.setUint8(9, p.code);
      return b;
    }
  }
}

function header(type: number, rpcId: bigint, len: number) {
  const b = new Uint8Array(len);
  const v = new DataView(b.buffer);
  v.setUint8(0, type);
  v.setBigUint64(1, rpcId);
  return { b, v };
}

function checkDataBounds(p: Data): void {
  // Plain numbers are exact up to 2^53, so offset + length can't wrap here.
  if (p.offset + p.payload.length > p.totalSize) {
    throw new MalformedPacketError(`DATA [${p.offset}, ${p.offset + p.payload.length}) runs past total_size ${p.totalSize}`);
  }
}

function checkResendRange(p: Resend): void {
  if (p.start >= p.end) throw new MalformedPacketError(`RESEND range [${p.start}, ${p.end}) is empty`);
}

function checkU64(n: bigint): void {
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new MalformedPacketError(`rpcId ${n} is not a u64`);
}

function checkU32(field: string, n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) throw new MalformedPacketError(`${field} ${n} is not a u32`);
}

function checkU8(field: string, n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new MalformedPacketError(`${field} ${n} is not a u8`);
}
