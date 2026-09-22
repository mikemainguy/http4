// HTTP4 client session over WebTransport datagrams: sends REQs, reassembles
// DATA, and issues GRANTs from the SRPT scheduler.
//
// Phase 1 assumes a lossless link. A transfer that stops making progress is
// rejected after `stallTimeoutMs` rather than hanging; recovering with RESEND
// is the next step (vrek iss-dfchynh).

import { Reassembly } from "./reassembly.ts";
import { SrptScheduler, type GrantTrace } from "./scheduler.ts";
import { decode, encode, maxPayload, newRpcId, ErrorCode, MalformedPacketError, type Packet } from "./wire.ts";

export interface ClientOptions {
  /** Max bytes granted but not yet received, across all transfers. */
  budget?: number;
  /** Smallest GRANT increment worth sending, unless it completes a transfer. */
  minIncrement?: number;
  /** Bytes each REQ lets the server send before any GRANT (`initial_grant`). */
  initialGrant?: number;
  stallTimeoutMs?: number;
  /** Record every grant decision (for tests). */
  trace?: GrantTrace[];
}

export interface ClientStats {
  packetsIn: number;
  malformedIn: number;
  dataBytesIn: number;
  duplicateBytesIn: number;
  grantsSent: number;
  reqsSent: number;
}

export class Http4Error extends Error {
  override name = "Http4Error";
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

interface Transfer {
  rpcId: bigint;
  assetId: string;
  initialGrant: number;
  asm?: Reassembly; // set once the first DATA reveals the size
  resolve(b: Uint8Array<ArrayBuffer>): void;
  reject(e: Error): void;
  stallTimer: ReturnType<typeof setTimeout>;
}

const DEFAULT_BUDGET = 128 * 1024;
const DEFAULT_MIN_INCREMENT = 16 * 1024;
const DEFAULT_STALL_MS = 5000;

export class Http4Client {
  readonly maxDatagramSize: number;
  readonly stats: ClientStats = { packetsIn: 0, malformedIn: 0, dataBytesIn: 0, duplicateBytesIn: 0, grantsSent: 0, reqsSent: 0 };

  private readonly wt: WebTransport;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly transfers = new Map<bigint, Transfer>();
  private readonly scheduler: SrptScheduler;
  private readonly initialGrant: number;
  private readonly stallMs: number;
  private closed = false;

  private constructor(wt: WebTransport, opts: ClientOptions) {
    this.wt = wt;
    this.maxDatagramSize = wt.datagrams.maxDatagramSize;
    const budget = opts.budget ?? DEFAULT_BUDGET;
    // Chrome drops incoming datagrams beyond this queue length, so leave room
    // for a whole budget's worth arriving before the page reads any of it.
    wt.datagrams.incomingHighWaterMark = Math.max(wt.datagrams.incomingHighWaterMark, 2 * Math.ceil(budget / maxPayload(this.maxDatagramSize)));
    this.writer = wt.datagrams.writable.getWriter();
    this.scheduler = new SrptScheduler({
      budget,
      minIncrement: opts.minIncrement ?? DEFAULT_MIN_INCREMENT,
      ...(opts.trace ? { trace: opts.trace } : {}),
    });
    // Default: four full packets, so a response of up to ~4 KB (an API reply)
    // arrives in one round trip with no GRANT.
    this.initialGrant = opts.initialGrant ?? 4 * maxPayload(this.maxDatagramSize);
    this.stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_MS;
    void this.readLoop();
    void wt.closed.finally(() => this.failAll(new Http4Error("session closed")));
  }

  static async connect(url: string, certHash?: Uint8Array<ArrayBuffer>, opts: ClientOptions = {}): Promise<Http4Client> {
    const wt = new WebTransport(url, certHash ? { serverCertificateHashes: [{ algorithm: "sha-256", value: certHash }] } : {});
    await wt.ready;
    return new Http4Client(wt, opts);
  }

  /** Fetch one asset by ID. Resolves with its bytes. */
  fetch(assetId: string): Promise<Uint8Array<ArrayBuffer>> {
    if (this.closed) return Promise.reject(new Http4Error("client closed"));
    const rpcId = newRpcId();
    const req = encode({ type: "REQ", rpcId, initialGrant: this.initialGrant, assetId });
    if (req.length > this.maxDatagramSize) {
      return Promise.reject(new Http4Error(`asset ID too long: REQ is ${req.length} bytes, datagram limit ${this.maxDatagramSize}`));
    }
    return new Promise((resolve, reject) => {
      const t: Transfer = { rpcId, assetId, initialGrant: this.initialGrant, resolve, reject, stallTimer: undefined! };
      this.transfers.set(rpcId, t);
      this.armStall(t);
      this.stats.reqsSent++;
      this.write(req);
    });
  }

  close(): void {
    this.closed = true;
    this.wt.close();
  }

  private write(b: Uint8Array): void {
    // Datagram writes resolve once queued; a failure means the session is gone,
    // which wt.closed reports.
    this.writer.write(b).catch(() => {});
  }

  private async readLoop(): Promise<void> {
    const reader = this.wt.datagrams.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        this.stats.packetsIn++;
        let p: Packet;
        try {
          p = decode(value as Uint8Array);
        } catch (e) {
          if (!(e instanceof MalformedPacketError)) throw e;
          this.stats.malformedIn++;
          continue;
        }
        this.handle(p);
        this.pumpGrants();
      }
    } catch (e) {
      this.failAll(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private handle(p: Packet): void {
    const t = this.transfers.get(p.rpcId);
    if (!t) return; // finished, failed, or not ours
    switch (p.type) {
      case "DATA": {
        if (!t.asm) {
          t.asm = new Reassembly(p.totalSize);
          this.scheduler.add(t.rpcId, p.totalSize, t.initialGrant, 0);
        } else if (p.totalSize !== t.asm.size) {
          return this.finish(t, new Http4Error(`total_size changed from ${t.asm.size} to ${p.totalSize}`));
        }
        let fresh: number;
        try {
          fresh = t.asm.add(p.offset, p.payload);
        } catch (e) {
          return this.finish(t, e as Error);
        }
        this.stats.dataBytesIn += p.payload.length;
        this.stats.duplicateBytesIn += p.payload.length - fresh;
        this.scheduler.onData(t.rpcId, fresh);
        if (fresh > 0) this.armStall(t);
        if (t.asm.complete) this.finish(t);
        return;
      }
      case "ERROR": {
        const name = Object.entries(ErrorCode).find(([, c]) => c === p.code)?.[0] ?? `code ${p.code}`;
        return this.finish(t, new Http4Error(`${t.assetId}: ${name}`, p.code));
      }
      default:
        this.stats.malformedIn++; // REQ/GRANT/RESEND only flow client → server
    }
  }

  private pumpGrants(): void {
    // A transfer whose size is still unknown has its initial grant in flight.
    let reserved = 0;
    for (const t of this.transfers.values()) if (!t.asm) reserved += t.initialGrant;
    for (const g of this.scheduler.grants(reserved)) {
      this.stats.grantsSent++;
      this.write(encode({ type: "GRANT", rpcId: g.rpcId, maxOffset: g.maxOffset, priority: g.priority }));
    }
  }

  private armStall(t: Transfer): void {
    clearTimeout(t.stallTimer);
    t.stallTimer = setTimeout(() => {
      const got = t.asm ? `${t.asm.received}/${t.asm.size} bytes` : "no size yet";
      this.finish(t, new Http4Error(`${t.assetId}: stalled for ${this.stallMs} ms (${got})`));
    }, this.stallMs);
  }

  private finish(t: Transfer, err?: Error): void {
    clearTimeout(t.stallTimer);
    this.transfers.delete(t.rpcId);
    this.scheduler.remove(t.rpcId);
    if (err) t.reject(err);
    else t.resolve(t.asm!.bytes);
    this.pumpGrants(); // its budget is free for the others
  }

  private failAll(err: Error): void {
    for (const t of [...this.transfers.values()]) this.finish(t, err);
  }
}
