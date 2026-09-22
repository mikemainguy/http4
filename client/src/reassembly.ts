// Rebuilds one asset from DATA payloads that may arrive out of order or more
// than once, and tracks exactly which bytes have arrived.

export interface Range {
  start: number;
  end: number; // exclusive
}

export class Reassembly {
  readonly size: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  // Disjoint, sorted, non-adjacent ranges that have arrived.
  private ranges: Range[] = [];
  private _received = 0;

  constructor(size: number) {
    this.size = size;
    this.bytes = new Uint8Array(size);
  }

  /** Unique bytes received so far. */
  get received(): number {
    return this._received;
  }

  get complete(): boolean {
    return this._received === this.size;
  }

  /** End of the gap-free prefix: every byte in [0, contiguous) has arrived. */
  get contiguous(): number {
    const first = this.ranges[0];
    return first && first.start === 0 ? first.end : 0;
  }

  /** One past the highest byte received: everything missing below it was skipped over. */
  get frontier(): number {
    return this.ranges.at(-1)?.end ?? 0;
  }

  /**
   * Store a payload at `offset` and return how many of its bytes were new.
   * Throws if it doesn't fit inside the asset.
   */
  add(offset: number, payload: Uint8Array): number {
    const end = offset + payload.length;
    if (offset < 0 || end > this.size) throw new RangeError(`[${offset}, ${end}) outside asset of ${this.size} bytes`);
    if (payload.length === 0) return 0;
    this.bytes.set(payload, offset);

    // Merge [offset, end) into the range list and count how much was new.
    let covered = 0;
    let start = offset;
    let stop = end;
    let i = 0;
    while (i < this.ranges.length && this.ranges[i]!.end < offset) i++;
    let j = i;
    while (j < this.ranges.length && this.ranges[j]!.start <= end) {
      const r = this.ranges[j]!;
      covered += Math.max(0, Math.min(r.end, end) - Math.max(r.start, offset));
      start = Math.min(start, r.start);
      stop = Math.max(stop, r.end);
      j++;
    }
    this.ranges.splice(i, j - i, { start, end: stop });
    const fresh = payload.length - covered;
    this._received += fresh;
    return fresh;
  }

  /** Gaps below `limit` (e.g. the grant): what should have arrived and hasn't. */
  missing(limit: number = this.size): Range[] {
    const gaps: Range[] = [];
    let at = 0;
    for (const r of this.ranges) {
      if (at >= limit) break;
      if (r.start > at) gaps.push({ start: at, end: Math.min(r.start, limit) });
      at = r.end;
    }
    if (at < limit) gaps.push({ start: at, end: limit });
    return gaps;
  }
}

/**
 * Decides which missing ranges of one transfer to RESEND, and when (vrek
 * iss-e58kfkh). It is the HTTP4 analogue of TCP's fast retransmit plus
 * RACK's time-based reordering window:
 *
 * - **Early detection:** a gap is a loss suspect once the transfer's frontier
 *   is far enough past it (the caller passes `limit` = frontier − a
 *   reordering allowance). It is declared lost only after staying missing for
 *   the reordering window, so a merely reordered packet has time to arrive.
 * - **No repeat storms:** a RESENT range isn't requested again until its
 *   `delay` has passed, which should cover the round trip plus the bytes
 *   queued ahead of the resend. The stall timer's RESENDs go through `claim`
 *   too, so the two paths never duplicate each other.
 *
 * Pure logic with the clock passed in, so it can be tested in Node.
 */
export class RepairTracker {
  private suspects = new Map<number, number>(); // gap start → when it was first a suspect
  private pending: (Range & { due: number })[] = []; // RESENT, awaiting the repair
  private _requested = 0;

  /** Whether any range has been RESENT for this transfer. */
  get requested(): boolean {
    return this._requested > 0;
  }

  /**
   * Gaps below `limit` that have stayed missing for `reorderWindowMs`, minus
   * any part a live RESEND already covers. The returned ranges are recorded
   * as RESENT, due by `now + delayMs`.
   */
  detect(asm: Reassembly, limit: number, now: number, reorderWindowMs: number, delayMs: number): Range[] {
    const gaps = asm.missing(limit);
    const suspects = new Map<number, number>();
    const lost: Range[] = [];
    for (const g of gaps) {
      const since = this.suspects.get(g.start) ?? now;
      suspects.set(g.start, since);
      if (now - since >= reorderWindowMs) lost.push(g);
    }
    this.suspects = suspects;
    return this.claim(asm, lost, now, delayMs);
  }

  /**
   * The parts of `gaps` not covered by a live RESEND, recorded as RESENT now
   * and due by `now + delayMs`.
   */
  claim(asm: Reassembly, gaps: Range[], now: number, delayMs: number): Range[] {
    // Drop RESENDs that were repaired (no longer overlap a gap) or are overdue.
    // Both lists are sorted and disjoint, so one sweep does it.
    const open = asm.missing(asm.size);
    const live: (Range & { due: number })[] = [];
    let i = 0;
    for (const p of this.pending) {
      if (p.due <= now) continue;
      while (i < open.length && open[i]!.end <= p.start) i++;
      if (i < open.length && open[i]!.start < p.end) live.push(p);
    }
    // Remove what live RESENDs already cover from each gap (gaps are sorted
    // and disjoint too), then record what's left as newly RESENT.
    const out: Range[] = [];
    let j = 0;
    for (const g of gaps) {
      let at = g.start;
      while (j < live.length && live[j]!.end <= at) j++;
      for (let k = j; k < live.length && live[k]!.start < g.end; k++) {
        const p = live[k]!;
        if (p.start > at) out.push({ start: at, end: p.start });
        at = Math.max(at, p.end);
      }
      if (at < g.end) out.push({ start: at, end: g.end });
    }
    const fresh = out.map((r) => ({ ...r, due: now + delayMs }));
    this.pending = [...live, ...fresh].sort((a, b) => a.start - b.start);
    this._requested += out.length;
    return out;
  }
}
