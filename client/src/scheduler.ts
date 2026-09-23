// Receiver-driven SRPT grant scheduler (docs/wire-format.md, GRANT).
//
// The client keeps at most `budget` bytes granted but not yet received,
// across all RPCs. Whenever there's room, the room goes to the RPC with the
// fewest bytes left to receive (Shortest Remaining Processing Time). The next
// RPC gets grants only once every shorter one is fully granted. This is pure
// logic with no I/O, so it can be tested in Node.
//
// The budget can change between calls (it follows the measured bandwidth-delay
// product; see budget.ts). Shrinking it below what is already outstanding
// revokes nothing: grants() just hands out nothing until enough has arrived.

export interface GrantDecision {
  rpcId: bigint;
  maxOffset: number;
  priority: number; // 0 = shortest remaining; carried on the wire, ignored by the Phase 1 server
}

/** One grant as the scheduler saw it, for tests and instrumentation. */
export interface GrantTrace extends GrantDecision {
  remaining: number;
  /** Remaining bytes of every other RPC that could still take a grant at that moment. */
  others: number[];
}

export interface SchedulerOptions {
  budget: number; // max bytes granted-but-not-received across all RPCs (see setBudget)
  minIncrement: number; // don't send a grant smaller than this unless it finishes the RPC
  trace?: GrantTrace[]; // if set, every decision is appended here
}

interface Entry {
  size: number;
  granted: number;
  received: number;
  paused?: boolean; // a streaming consumer is behind: no new grants for now
  seq: number; // arrival order, breaks ties
}

export class SrptScheduler {
  private readonly rpcs = new Map<bigint, Entry>();
  private seq = 0;
  private readonly opts: SchedulerOptions;
  private budget: number;
  private limited = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.budget = opts.budget;
  }

  /** Change the budget for later grants() calls. */
  setBudget(budget: number): void {
    this.budget = budget;
  }

  /**
   * Whether the last grants() call left a transfer wanting more because the
   * budget ran out, i.e. the budget, not demand, was the limit.
   */
  get budgetLimited(): boolean {
    return this.limited;
  }

  /** Start scheduling an RPC once its size is known. `granted` is what the REQ already allowed. */
  add(rpcId: bigint, size: number, granted: number, received: number): void {
    this.rpcs.set(rpcId, { size, granted: Math.min(granted, size), received, seq: this.seq++ });
  }

  remove(rpcId: bigint): void {
    this.rpcs.delete(rpcId);
  }

  /** Record `bytes` newly received for an RPC. */
  onData(rpcId: bigint, bytes: number): void {
    const e = this.rpcs.get(rpcId);
    if (e) e.received += bytes;
  }

  /**
   * Stop (or resume) granting an RPC while its reader is behind: a streaming
   * body whose consumer isn't keeping up shouldn't pull more bytes into
   * memory. What it already holds still counts against the budget, so the
   * others see the true amount in flight, but it takes no new grants and
   * doesn't make the budget look exhausted.
   */
  setPaused(rpcId: bigint, paused: boolean): void {
    const e = this.rpcs.get(rpcId);
    if (e) e.paused = paused;
  }

  /** Current grant ceiling for an RPC, or undefined if it isn't scheduled. */
  granted(rpcId: bigint): number | undefined {
    return this.rpcs.get(rpcId)?.granted;
  }

  /** Bytes granted to scheduled RPCs but not yet received. */
  outstanding(): number {
    let n = 0;
    for (const e of this.rpcs.values()) n += Math.max(0, e.granted - e.received);
    return n;
  }

  /**
   * Spend whatever budget is free and return the GRANTs to send.
   * `reserved` is budget already committed elsewhere, e.g. the initial grants
   * of REQs whose size isn't known yet.
   */
  grants(reserved = 0): GrantDecision[] {
    const outstanding = this.outstanding();
    let available = this.budget - reserved - outstanding;
    const candidates = [...this.rpcs.entries()]
      .filter(([, e]) => e.granted < e.size && !e.paused)
      .sort(([, a], [, b]) => a.size - a.received - (b.size - b.received) || a.seq - b.seq);
    this.limited = candidates.length > 0 && available < this.opts.minIncrement;
    if (available <= 0) return [];

    const out: GrantDecision[] = [];
    for (let rank = 0; rank < candidates.length && available > 0; rank++) {
      const [rpcId, e] = candidates[rank]!;
      const target = Math.min(e.size, e.granted + available);
      const inc = target - e.granted;
      // Strict SRPT: if the shortest RPC can't take a worthwhile grant yet,
      // nobody longer gets one either — unless nothing is in flight at all,
      // in which case a small grant is the only thing that can restart the
      // session. Without that exception a minIncrement larger than the budget
      // can ever free deadlocks every transfer bigger than it: no grant is
      // issued, so no data arrives, so the budget never grows, so no grant is
      // issued (vrek iss-pjpnk4q; it wedged a live site).
      const stalled = outstanding === 0 && out.length === 0;
      if (inc < this.opts.minIncrement && target < e.size && !stalled) {
        this.limited = true;
        break;
      }
      const d: GrantDecision = { rpcId, maxOffset: target, priority: Math.min(rank, 7) };
      if (this.opts.trace) {
        this.opts.trace.push({
          ...d,
          remaining: e.size - e.received,
          others: candidates.filter(([id, o]) => id !== rpcId && o.granted < o.size).map(([, o]) => o.size - o.received),
        });
      }
      e.granted = target;
      available -= inc;
      out.push(d);
    }
    // Room ran out with someone still wanting more.
    if (available <= 0 && candidates.some(([, e]) => e.granted < e.size)) this.limited = true;
    return out;
  }
}
