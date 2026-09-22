package sender

import (
	"testing"
	"time"

	"http4/server/internal/wire"
)

var epoch = time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)

// saturate feeds p a run of blocked sends spaced by interval, as a full queue
// does, and returns the time it ended at.
func saturate(p *pacer, at time.Time, interval time.Duration, n int) time.Time {
	for range n {
		at = at.Add(interval)
		p.sent(at, true)
	}
	return at
}

func TestPacerWaitsForNothingUntilItHasMeasured(t *testing.T) {
	p := &pacer{target: 4}
	at := epoch
	for range 100 {
		if d := p.wait(at); d != 0 {
			t.Fatalf("wait = %v before any measurement, want 0", d)
		}
		at = at.Add(time.Millisecond)
		p.sent(at, false)
	}
}

func TestPacerLeavesFastPathsAlone(t *testing.T) {
	p := &pacer{target: 4}
	// A loopback-ish wire: 32 queued datagrams drain in ~2 ms, so pacing them
	// would cost more in timer granularity than the delay it saves.
	at := saturate(p, epoch, 60*time.Microsecond, 64)
	if p.interval >= pacerMinInterval {
		t.Fatalf("interval %v, want < %v for this test", p.interval, pacerMinInterval)
	}
	if d := p.wait(at); d != 0 {
		t.Errorf("wait = %v on a fast path, want 0", d)
	}
}

func TestPacerMeasuresTheWireAndDrainsAFullQueue(t *testing.T) {
	const interval = 4 * time.Millisecond
	p := &pacer{target: 4}
	at := saturate(p, epoch, interval, 64)

	if got := p.interval; got < 3800*time.Microsecond || got > 4200*time.Microsecond {
		t.Errorf("measured interval %v, want ≈ %v", got, interval)
	}
	// The last send blocked, so the queue is full: the wait must cover the
	// departures that bring it back under target.
	want := time.Duration((quicSendQueue - 4 + 1) * interval) // 29 × 4 ms
	if d := p.wait(at); d < want-interval || d > want+interval {
		t.Errorf("wait = %v after a full queue, want ≈ %v", d, want)
	}
	// Once those departures have happened, it stops holding off.
	if d := p.wait(at.Add(want)); d != 0 {
		t.Errorf("wait = %v after the queue drained, want 0", d)
	}
}

func TestPacerProbesFasterWhileNothingBlocks(t *testing.T) {
	p := &pacer{target: 4}
	at := saturate(p, epoch, 4*time.Millisecond, 64)
	measured := p.interval
	for range 20 { // 20 × 200 ms of sends that find room
		at = at.Add(pacerProbeEvery)
		p.sent(at, false)
	}
	if p.interval >= measured {
		t.Errorf("interval %v did not creep below the measured %v", p.interval, measured)
	}
	if p.interval < measured*3/4 {
		t.Errorf("interval %v crept too far below %v", p.interval, measured)
	}
}

func TestPacerForgetsTheQueueAfterAnIdle(t *testing.T) {
	p := &pacer{target: 4}
	at := saturate(p, epoch, 4*time.Millisecond, 64)
	if d := p.wait(at.Add(time.Second)); d != 0 {
		t.Errorf("wait = %v a second after the last send, want 0: the queue has long drained", d)
	}
}

// sendQueue models quic-go's datagram queue: 32 deep, one departure per
// interval, and an enqueue that blocks while it is full.
type sendQueue struct {
	interval time.Duration
	queued   int
	nextPop  time.Time
}

func (w *sendQueue) drain(now time.Time) {
	for w.queued > 0 && !now.Before(w.nextPop) {
		w.queued--
		w.nextPop = w.nextPop.Add(w.interval)
	}
	if w.queued == 0 && now.After(w.nextPop) {
		w.nextPop = now // an idle wire starts the next datagram when it arrives
	}
}

// push enqueues one datagram, waiting if the queue is full. It returns the
// time the enqueue completed and whether it had to wait.
func (w *sendQueue) push(now time.Time) (time.Time, bool) {
	w.drain(now)
	blocked := w.queued >= quicSendQueue
	if blocked {
		now = w.nextPop
		w.drain(now)
	}
	if w.queued == 0 {
		w.nextPop = now.Add(w.interval)
	}
	w.queued++
	return now, blocked
}

// The control loop against that wire: the queue should stay near the target
// without giving up throughput, which is the whole point (iss-dy53a59).
func TestPacerKeepsTheQueueShallowWithoutLosingThroughput(t *testing.T) {
	const interval = 4 * time.Millisecond
	const run = 30 * time.Second
	p := &pacer{target: 4}
	w := &sendQueue{interval: interval, nextPop: epoch}

	now, sends, blocks, deep := epoch, 0, 0, 0
	depth := 0
	for now.Sub(epoch) < run {
		if d := p.wait(now); d > 0 {
			now = now.Add(d)
		}
		at, blocked := w.push(now)
		now = at
		p.sent(now, blocked)
		sends++
		depth += w.queued
		if blocked {
			blocks++
		}
		if w.queued > p.target+2 {
			deep++
		}
	}

	// Throughput: the wire could carry run/interval datagrams; pacing must not
	// give much of that up.
	capacity := int(run / interval)
	if sends < capacity*9/10 {
		t.Errorf("sent %d datagrams, want ≥ 90%% of the wire's %d", sends, capacity)
	}
	// Depth: the point of the exercise. Averaged, and however often it is
	// allowed to run deep while the estimate re-syncs.
	if avg := float64(depth) / float64(sends); avg > float64(p.target)+3 {
		t.Errorf("average queue depth %.1f, want ≲ %d", avg, p.target+3)
	}
	if got := 100 * deep / sends; got > 20 {
		t.Errorf("queue was deeper than target+2 for %d%% of sends, want ≤ 20%%", got)
	}
	t.Logf("%d sends (wire capacity %d), %d blocked, avg depth %.1f, %d%% deep, final interval %v",
		sends, capacity, blocks, float64(depth)/float64(sends), 100*deep/sends, p.interval)
}

// queueDatagrams puts QUIC's send queue between the sender and the test: it
// holds quicSendQueue datagrams, releases one every interval and blocks the
// sender once it is full. Packets then reach the test in departure order,
// which is the order a client sees them in.
func (h harness) queueDatagrams(interval time.Duration) {
	q := make(chan []byte, quicSendQueue)
	h.mu.Lock()
	h.queue = q
	h.mu.Unlock()
	go func() {
		for {
			select {
			case b := <-q:
				select {
				case <-time.After(interval):
				case <-h.closed:
					return
				}
				if err := h.deliver(b); err != nil {
					return
				}
			case <-h.closed:
				return
			}
		}
	}()
}

// bulkAhead saturates the wire with a bulk transfer, then asks for a small
// asset and returns how many bulk datagrams depart before its first one.
func bulkAhead(t *testing.T, target int, interval time.Duration) int {
	t.Helper()
	h := start(t, MapAssets{"bulk": asset(1 << 20), "small": asset(900)},
		func(c *Config) { c.SendQueueTarget = target })
	h.queueDatagrams(interval)
	h.send(&wire.Req{RPCID: 1, InitialGrant: 1 << 20, AssetID: "bulk"})

	// Long enough to fill the queue and for the pacer to measure the wire.
	time.Sleep(300 * time.Millisecond)
	for len(h.out) > 0 { // what has already departed is ahead of nothing
		<-h.out
	}
	h.send(&wire.Req{RPCID: 2, InitialGrant: 900, AssetID: "small"})

	n := 0
	deadline := time.After(5 * time.Second)
	for {
		select {
		case p := <-h.out:
			var d *wire.Data
			switch p := p.(type) {
			case *wire.Data:
				d = p
			case *wire.DataSeq:
				d = &p.Data
			default:
				continue
			}
			if d.RPCID == 2 {
				return n
			}
			n++
		case <-deadline:
			t.Fatalf("the small reply never came; %d bulk datagrams departed", n)
		}
	}
}

// The point of the whole exercise, end to end: a small reply asked for while
// bulk saturates the wire must not depart behind a queue full of bulk
// (vrek iss-dy53a59, fnd-pp7zab7).
func TestSmallReplyDoesNotDepartBehindAFullQueueOfBulk(t *testing.T) {
	const interval = 2 * time.Millisecond // 32 queued datagrams = 64 ms of wire

	unpaced := bulkAhead(t, -1, interval)
	paced := bulkAhead(t, DefaultSendQueueTarget, interval)
	t.Logf("bulk datagrams ahead of the small reply: %d unpaced, %d paced", unpaced, paced)

	if unpaced < quicSendQueue*2/3 {
		t.Errorf("unpaced, only %d bulk datagrams preceded the small reply; expected a nearly full queue (%d)", unpaced, quicSendQueue)
	}
	if want := DefaultSendQueueTarget + 4; paced > want {
		t.Errorf("paced, %d bulk datagrams preceded the small reply, want ≤ %d", paced, want)
	}
}
