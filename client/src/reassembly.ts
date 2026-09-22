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

/** What an arriving session sequence number turned out to be. */
export type SeqArrival = "new" | "reordered" | "spurious" | "duplicate";

/** Which transfer's bytes a DATA_SEQ carried (or, for a lost one, probably carried). */
export interface SeqHint {
  rpcId: bigint;
  start: number;
  end: number; // exclusive
}

/**
 * Session-wide loss detection over DATA_SEQ sequence numbers (wire v2, vrek
 * iss-fbzcsr1): RACK across every transfer of the session. Unlike a transfer's
 * own gaps, a number that's missing while later numbers keep arriving shows a
 * loss even at the very end of a transfer, because other transfers' packets
 * reveal it. That's how QUIC's packet numbers work.
 *
 * - **Missing:** every number between the highest seen and a new higher one.
 * - **Lost:** a missing number with at least `allowance` later numbers seen
 *   past it, still missing after the reordering window. It's then *claimed*
 *   (RESEND_SEQ goes out). The server resends under new numbers, so if the
 *   repair is lost too, that loss shows up as a new missing number of its
 *   own. The RESEND_SEQ itself can be lost too, and nothing would show it, so
 *   `repeats` asks again a few times. The server resends each number only
 *   once, so the repeats cost a small packet each and never duplicate data.
 * - **Spurious:** a claimed number that arrives after all (it was only late).
 *
 * The client doesn't need to know which transfer a lost number belonged to:
 * the server remembers what each number carried and resends exactly that.
 * It can often guess, though: when the packets on both sides of a gap belong
 * to one transfer, the gap's numbers carried the bytes between them. That
 * guess (a `hint`) is only used to stop repeating once those bytes have
 * arrived, so a wrong guess can only cost a repeat or skip one, never
 * correctness. Pure logic with the clock passed in.
 */
export class SeqTracker {
  private highest = -1;
  private last: SeqHint | undefined; // what the highest number carried
  private readonly missing = new Map<number, { since: number; hint: SeqHint | undefined }>();
  // Claimed numbers still being asked for (few: the losses of the last few
  // repair delays), and those asked for maxTries times, kept only so a late
  // original reads as spurious (bounded, oldest dropped first).
  private readonly claimed = new Map<number, { at: number; tries: number; hint: SeqHint | undefined }>();
  private readonly settled = new Map<number, number>(); // seq → when it stopped being asked for
  static readonly MAX_SETTLED = 8192;

  /** Numbers jumping further than this are treated as a restart, not a loss burst. */
  static readonly MAX_GAP = 4096;
  /** A claimed number is forgotten after this long; a very late original then reads as a duplicate. */
  static readonly CLAIM_TTL_MS = 30_000;

  /** Highest number seen so far, or -1. */
  get top(): number {
    return this.highest;
  }

  /** Numbers known missing and not yet claimed. */
  get outstanding(): number {
    return this.missing.size;
  }

  /** Record an arriving number; `where` is what its DATA_SEQ carried. */
  arrive(seq: number, now: number, where?: SeqHint): SeqArrival {
    if (seq > this.highest) {
      if (seq - this.highest - 1 <= SeqTracker.MAX_GAP) {
        // The gap sits between the previous highest and this packet. If both
        // belong to one transfer, the missing numbers carried its bytes in
        // between them.
        const prev = this.last;
        const hint =
          prev && where && seq - this.highest > 1 && prev.rpcId === where.rpcId && prev.end < where.start
            ? { rpcId: where.rpcId, start: prev.end, end: where.start }
            : undefined;
        for (let s = this.highest + 1; s < seq; s++) this.missing.set(s, { since: now, hint });
      }
      this.highest = seq;
      this.last = where;
      return "new";
    }
    if (this.missing.delete(seq)) return "reordered";
    if (this.claimed.delete(seq) || this.settled.delete(seq)) return "spurious";
    return "duplicate";
  }

  /**
   * Missing numbers now considered lost, as sorted half-open ranges of at
   * most `maxRange` numbers each. They're recorded as claimed. Like QUIC's
   * RACK, a number is lost once `allowance` later numbers have passed it and
   * it has stayed missing for `windowMs`. At the end of a burst there may never
   * be that many later numbers, so it is also lost once any later number has
   * arrived and it has stayed missing for `tailWindowMs` (a round trip
   * longer), instead of waiting for a tail probe.
   */
  detect(now: number, allowance: number, windowMs: number, tailWindowMs = Infinity, maxRange = 1024): { start: number; end: number }[] {
    const lost: number[] = [];
    for (const [s, m] of this.missing) {
      const age = now - m.since;
      if ((this.highest - s >= allowance && age >= windowMs) || age >= tailWindowMs) lost.push(s);
    }
    for (const s of lost) {
      const hint = this.missing.get(s)!.hint;
      this.missing.delete(s);
      this.claimed.set(s, { at: now, tries: 1, hint });
    }
    return ranges(lost, maxRange);
  }

  /**
   * Claimed numbers whose last RESEND_SEQ went out at least `delayMs` ago,
   * asked for fewer than `maxTries` times: their RESEND_SEQ may have been
   * lost. They're recorded as asked again. A number whose hint shows its
   * bytes have since arrived (`repaired(hint)`) is settled instead.
   */
  repeats(
    now: number,
    delayMs: number,
    maxTries: number,
    repaired: (hint: SeqHint) => boolean = () => false,
    maxRange = 1024,
  ): { start: number; end: number }[] {
    const due: number[] = [];
    for (const [s, c] of this.claimed) {
      if (now - c.at < delayMs) continue;
      if (c.tries >= maxTries || (c.hint && repaired(c.hint))) {
        // Done asking. Remember it a while longer, only to spot a late original.
        this.claimed.delete(s);
        this.settled.set(s, now);
        continue;
      }
      c.at = now;
      c.tries++;
      due.push(s);
    }
    // Bound the settled set: Maps iterate in insertion order, oldest first.
    for (const [s, at] of this.settled) {
      if (this.settled.size <= SeqTracker.MAX_SETTLED && now - at <= SeqTracker.CLAIM_TTL_MS) break;
      this.settled.delete(s);
    }
    return ranges(due, maxRange);
  }
}

/** Sorted, merged half-open ranges of at most `maxRange` numbers each. */
function ranges(nums: number[], maxRange: number): { start: number; end: number }[] {
  nums.sort((a, b) => a - b);
  const out: { start: number; end: number }[] = [];
  for (const s of nums) {
    const last = out.at(-1);
    if (last && last.end === s && last.end - last.start < maxRange) last.end = s + 1;
    else out.push({ start: s, end: s + 1 });
  }
  return out;
}
