package sender

import "time"

// quicSendQueue mirrors quic-go's unexported maxDatagramSendQueueLen: how many
// datagrams it buffers before SendDatagram blocks.
const quicSendQueue = 32

const (
	// DefaultSendQueueTarget is how many datagrams may go out back to back
	// after a pause, and so about how many the sender leaves sitting in QUIC's
	// send queue ahead of the packet it picks next.
	DefaultSendQueueTarget = 4
	// pacerMinInterval is the departure interval below which pacing is not
	// worth it: a full queue then drains in under ~8 ms, less than the timer
	// granularity pacing would spend on it.
	pacerMinInterval = 250 * time.Microsecond
	// pacerBlocked is how slow a SendDatagram has to be to mean "the queue was
	// full". An enqueue that finds room takes microseconds, but a send that
	// happens to be slow — a timer wake, a lock, the scheduler — takes hundreds,
	// and reading those as a full queue is expensive: each one brakes for a
	// drain that is not needed and drags the rate estimate slower. A real wait
	// for a departure lasts about one interval, and pacing only ever engages
	// above pacerMinInterval, so the threshold sits well above the noise.
	pacerBlocked = time.Millisecond
	// A departure-rate sample spans at least pacerSample and pacerMinSends, so
	// it averages over several congestion bursts. Measured burst by burst the
	// rate is wildly wrong: on a 1% / 50 ms path quic-go pops a window's worth
	// of datagrams in a few hundred microseconds and then waits an RTT, so
	// consecutive blocked sends are ~250 µs apart on a wire carrying one
	// datagram every ~4 ms (vrek iss-dy53a59).
	pacerSample   = 200 * time.Millisecond
	pacerMinSends = 16
	// pacerMaxWait caps one wait, so a wake can be noticed and the estimate
	// re-checked. It does not shorten a hold-off: the loop waits again.
	pacerMaxWait = 50 * time.Millisecond
	// pacerBlockedQuarters is how much of a sample window must have blocked for
	// the sample to count, in quarters of its sends. A sample taken while the
	// queue was sometimes empty measures what the sender offered rather than
	// what the wire can carry, and pacing to that offers less still — the
	// estimate walks itself down and takes the throughput with it. Blocking
	// often is the sender's only evidence that the wire, and not the sender,
	// set the pace.
	pacerBlockedQuarters = 1
	// pacerHeadroom is the fraction of the wire the sender leaves unused, as a
	// divisor. Pacing at exactly the measured rate conserves the queue's depth
	// rather than reducing it: as many datagrams arrive as leave, so a queue
	// that is full stays full. Only sending slightly slower than the wire
	// drains it, and this is the price of a shallow one — the throughput given
	// up is this fraction, and it is the trade the issue is about.
	pacerHeadroom = 8
)

// pacer keeps quic-go's datagram send queue shallow, so a packet the send loop
// picks now is not stuck behind bulk datagrams queued earlier (vrek
// iss-dy53a59, fnd-pp7zab7).
//
// quic-go buffers up to 32 datagrams and SendDatagram only blocks once that
// queue is full, so a sender with bulk always ready keeps it full. The queue is
// FIFO, so SRPT at pick time decides the order *into* the queue, not the order
// onto the wire: on a slow path those 32 datagrams are ~125 ms of head-of-line
// delay for a small reply granted now.
//
// Nothing reports "this datagram left", so the rate is inferred. A send that
// blocks waited for one to leave, so at that instant the queue is full. Between
// two blocked sends it is therefore full at both ends, and exactly as many
// datagrams left as were handed over, however bursty the wire was in between:
// counting sends between two blocks, over a span long enough to cover several
// bursts, measures the departure rate.
//
// Knowing the rate, the sender books a departure slot per bulk datagram, and a
// block — which proves the queue is full — books a slot far enough out for the
// queue to drain to the target first. That drain costs no throughput, because
// the wire is busy draining throughout it. What it must not do is happen when
// the queue is *not* full: braking on a belief that nothing refutes while it is
// acted on is how a sender stalls itself, and an earlier revision of this file
// lost 56% of bulk throughput that way. So only an observed block brakes, and
// the rest of the time the sender simply paces.
//
// Slots missed while the sender had nothing to send are kept as credit, up to
// target of them, so pacing tracks the wire rather than falling behind it by
// the timer's error on every send.
//
// Nothing nudges the estimate faster on its own. It is tempting: a sender that
// paces a little slower than the wire empties the queue and never learns, and
// gives up that much throughput. But a shallow queue is indistinguishable from
// an empty one — neither blocks — so such a nudge fires in exactly the state it
// is meant to detect, and ratchets until the queue is full again. Simulated
// against an even wire it holds the queue 15-20 deep against a target of 4. The
// rate therefore only ever comes from a sample taken while the queue was full,
// which is the only time the wire is known to be busy; a path that speeds up is
// under-used until something fills the queue again.
//
// Pure logic with the clock passed in, so it can be tested without a network.
type pacer struct {
	target   int           // datagrams allowed out back to back
	interval time.Duration // estimated time between departures; 0 until measured
	next     time.Time     // earliest the next bulk datagram may be handed over

	since    time.Time // the blocked send the current sample counts from
	sends    int       // datagrams handed over since then, which is how many left
	blocks   int       // how many of those blocked, which says who set the pace
	blockRun int       // blocked sends in a row; one alone may just be a slow send
}

// wait reports how long to hold off before handing quic-go another bulk
// datagram. The send loop re-picks afterwards, so a packet that becomes due
// while it waits goes out first — and only bulk ever waits, because delaying
// the most urgent packet there is helps nobody.
func (p *pacer) wait(now time.Time) time.Duration {
	if p.target < 0 {
		return 0 // pacing off: the queue runs as deep as QUIC allows
	}
	if p.interval < pacerMinInterval {
		return 0 // the queue drains faster than pacing could usefully hold it
	}
	d := p.next.Sub(now)
	if d <= 0 {
		return 0
	}
	return min(d, pacerMaxWait)
}

// sent records one datagram handed to quic-go, and whether that blocked.
func (p *pacer) sent(now time.Time, blocked bool) {
	p.schedule(now)
	p.sends++
	if !blocked {
		p.blockRun = 0
		return
	}
	p.blockRun++
	// The queue is full, so nothing handed over now can leave before the 32
	// ahead of it. Stand back for the departures that bring it to the target —
	// but only once a second send in a row has confirmed the queue really is
	// full, since braking for 28 departures that have already happened is how
	// the sender throttles itself.
	if p.interval > 0 && p.blockRun > 1 {
		p.next = now.Add(time.Duration(quicSendQueue-p.target) * p.interval)
	}
	if p.since.IsZero() {
		p.since, p.sends, p.blocks = now, 0, 0
		return
	}
	p.blocks++
	// The queue was full then and is full now, so p.sends datagrams left in
	// between. Long samples only: a short one measures a burst, not the wire.
	if d := now.Sub(p.since); d >= pacerSample && p.sends >= pacerMinSends {
		if 4*p.blocks >= pacerBlockedQuarters*p.sends {
			p.observe(d / time.Duration(p.sends))
		}
		p.since, p.sends, p.blocks = now, 0, 0
	}
}

// idle records that the send loop ran out of work. Datagrams kept leaving while
// it had none to add, so a sample spanning this moment would measure what the
// sender happened to offer rather than what the wire can carry, and pacing to
// an offered load throttles the sender to below it.
func (p *pacer) idle() {
	p.since, p.sends = time.Time{}, 0
}

// schedule books the slot after this datagram's. Slots that went unused are
// kept as credit, but only target of them, so a sender coming back from idle
// hands over that many at once and no more.
func (p *pacer) schedule(now time.Time) {
	if p.interval <= 0 {
		p.next = now
		return
	}
	slot := p.interval + p.interval/pacerHeadroom
	if credit := now.Add(-time.Duration(p.target) * slot); p.next.Before(credit) {
		p.next = credit
	}
	p.next = p.next.Add(slot)
}

// observe folds one departure-interval sample into the estimate.
func (p *pacer) observe(sample time.Duration) {
	switch {
	case sample <= 0:
	case p.interval <= 0:
		p.interval = sample
	default:
		p.interval = (3*p.interval + sample) / 4 // EWMA, α = ¼
	}
}
