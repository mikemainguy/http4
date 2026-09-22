// HTTP4 client session over WebTransport datagrams: sends REQs, reassembles
// DATA, issues GRANTs from the SRPT scheduler, and recovers lost datagrams.
//
// Loss recovery: a transfer that has bytes outstanding but hasn't made progress
// for one RTO is "stalled". If its size is still unknown (REQ or packet 0 was
// lost), the REQ is sent again under the same rpc_id. Otherwise its current
// GRANT is re-sent (a GRANT may have been lost) along with a RESEND for each
// missing range below the grant. The timeout doubles on each attempt without
// progress, and the transfer fails after `maxRecoveries` attempts.

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
  /** Lower bound on the retransmission timeout. */
  rtoFloorMs?: number;
  /** Recovery attempts without progress before a transfer fails. */
  maxRecoveries?: number;
  /** Record every grant decision (for tests). */
  trace?: GrantTrace[];
  /** TESTING ONLY: return true to drop an outgoing packet, simulating loss. */
  dropOutgoing?: (p: Packet) => boolean;
}

export interface ClientStats {
  packetsIn: number;
  malformedIn: number;
  dataBytesIn: number;
  duplicateBytesIn: number;
  grantsSent: number;
  reqsSent: number;
  reqRetransmits: number;
  resendsSent: number;
  recoveries: number;
  droppedOutgoing: number;
  srttMs: number | null;
  rtoMs: number;
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
  reqSentAt: number;
  reqRetransmitted: boolean; // Karn: no RTT sample from an ambiguous REQ
  lastProgress: number;
  recoveries: number; // consecutive attempts without progress
}

const DEFAULT_BUDGET = 128 * 1024;
const DEFAULT_MIN_INCREMENT = 16 * 1024;
const DEFAULT_RTO_FLOOR_MS = 20;
const DEFAULT_MAX_RECOVERIES = 10;
const MAX_RTO_MS = 2000;
const MAX_RESEND_RANGES = 16; // per recovery attempt

export class Http4Client {
  readonly maxDatagramSize: number;
  readonly stats: ClientStats;

  private readonly wt: WebTransport;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly transfers = new Map<bigint, Transfer>();
  private readonly scheduler: SrptScheduler;
  private readonly initialGrant: number;
  private readonly rtoFloor: number;
  private readonly maxRecoveries: number;
  private readonly dropOutgoing: ((p: Packet) => boolean) | undefined;
  private srtt: number | null = null;
  private rttvar = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
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
    this.rtoFloor = opts.rtoFloorMs ?? DEFAULT_RTO_FLOOR_MS;
    this.maxRecoveries = opts.maxRecoveries ?? DEFAULT_MAX_RECOVERIES;
    this.dropOutgoing = opts.dropOutgoing;
    this.stats = {
      packetsIn: 0, malformedIn: 0, dataBytesIn: 0, duplicateBytesIn: 0, grantsSent: 0, reqsSent: 0,
      reqRetransmits: 0, resendsSent: 0, recoveries: 0, droppedOutgoing: 0, srttMs: null, rtoMs: this.rto(),
    };
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
    const req: Packet = { type: "REQ", rpcId, initialGrant: this.initialGrant, assetId };
    const size = encode(req).length;
    if (size > this.maxDatagramSize) {
      return Promise.reject(new Http4Error(`asset ID too long: REQ is ${size} bytes, datagram limit ${this.maxDatagramSize}`));
    }
    return new Promise((resolve, reject) => {
      const now = performance.now();
      this.transfers.set(rpcId, {
        rpcId, assetId, initialGrant: this.initialGrant, resolve, reject,
        reqSentAt: now, reqRetransmitted: false, lastProgress: now, recoveries: 0,
      });
      this.startTicker();
      this.stats.reqsSent++;
      this.send(req);
    });
  }

  close(): void {
    this.closed = true;
    this.wt.close();
  }

  /** Retransmission timeout: RFC 6298 from the REQ→first-DATA samples, with a floor. */
  private rto(): number {
    if (this.srtt === null) return Math.max(this.rtoFloor, 100);
    return Math.min(MAX_RTO_MS, Math.max(this.rtoFloor, this.srtt + 4 * this.rttvar));
  }

  private sampleRtt(r: number): void {
    if (this.srtt === null) {
      this.srtt = r;
      this.rttvar = r / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r);
      this.srtt = 0.875 * this.srtt + 0.125 * r;
    }
    this.stats.srttMs = this.srtt;
    this.stats.rtoMs = this.rto();
  }

  private send(p: Packet): void {
    if (this.dropOutgoing?.(p)) {
      this.stats.droppedOutgoing++;
      return;
    }
    // Datagram writes resolve once queued; a failure means the session is gone,
    // which wt.closed reports.
    this.writer.write(encode(p)).catch(() => {});
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
          if (!t.reqRetransmitted) this.sampleRtt(performance.now() - t.reqSentAt);
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
        if (fresh > 0) {
          t.lastProgress = performance.now();
          t.recoveries = 0;
        }
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
      this.send({ type: "GRANT", rpcId: g.rpcId, maxOffset: g.maxOffset, priority: g.priority });
    }
  }

  private startTicker(): void {
    this.ticker ??= setInterval(() => this.tick(), Math.max(5, this.rtoFloor / 2));
  }

  private tick(): void {
    const now = performance.now();
    for (const t of [...this.transfers.values()]) {
      const granted = t.asm ? (this.scheduler.granted(t.rpcId) ?? 0) : 0;
      const waiting = t.asm !== undefined && t.asm.received >= granted;
      if (waiting) {
        // Nothing outstanding: it's queued behind shorter transfers, not stalled.
        t.lastProgress = now;
        continue;
      }
      const timeout = Math.min(MAX_RTO_MS, this.rto() * 2 ** t.recoveries);
      if (now - t.lastProgress >= timeout) this.recover(t, granted, now);
    }
    if (this.transfers.size === 0) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private recover(t: Transfer, granted: number, now: number): void {
    if (++t.recoveries > this.maxRecoveries) {
      const got = t.asm ? `${t.asm.received}/${t.asm.size} bytes` : "no size yet";
      return this.finish(t, new Http4Error(`${t.assetId}: no progress after ${this.maxRecoveries} recovery attempts (${got})`));
    }
    this.stats.recoveries++;
    t.lastProgress = now; // the next attempt waits a (doubled) timeout from here
    if (!t.asm) {
      // Neither packet 0 nor any other DATA arrived: the REQ or its reply was lost.
      t.reqRetransmitted = true;
      this.stats.reqRetransmits++;
      this.send({ type: "REQ", rpcId: t.rpcId, initialGrant: t.initialGrant, assetId: t.assetId });
      return;
    }
    // The server may never have seen our latest GRANT; grants are idempotent.
    if (granted > t.initialGrant) this.send({ type: "GRANT", rpcId: t.rpcId, maxOffset: granted, priority: 0 });
    for (const gap of t.asm.missing(granted).slice(0, MAX_RESEND_RANGES)) {
      this.stats.resendsSent++;
      this.send({ type: "RESEND", rpcId: t.rpcId, start: gap.start, end: gap.end });
    }
  }

  private finish(t: Transfer, err?: Error): void {
    this.transfers.delete(t.rpcId);
    this.scheduler.remove(t.rpcId);
    if (err) t.reject(err);
    else t.resolve(t.asm!.bytes);
    this.pumpGrants(); // its budget is free for the others
  }

  private failAll(err: Error): void {
    for (const t of [...this.transfers.values()]) this.finish(t, err);
    clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
