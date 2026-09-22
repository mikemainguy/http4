// Package sender is the HTTP4 passive sender: it answers REQs and emits DATA
// only inside the byte ranges the client has granted (docs/wire-format.md).
//
// Each session runs two goroutines. The receive loop decodes packets and
// updates state; it never sends, so a slow send can't delay it. The send
// loop picks the next packet and hands it to QUIC. QUIC's SendDatagram blocks
// while its queue is full, which paces the send loop at the congestion
// controller's rate — but that queue is 32 datagrams deep and FIFO, so the
// loop also holds off while it is deeper than SendQueueTarget, or a packet
// picked now would leave behind bulk queued earlier (see pacer.go).
package sender

import (
	"cmp"
	"context"
	"errors"
	"log"
	"math"
	"sync"
	"time"

	"github.com/quic-go/quic-go"

	"http4/server/internal/wire"
)

// Conn is the datagram side of a WebTransport session.
type Conn interface {
	SendDatagram([]byte) error
	ReceiveDatagram(context.Context) ([]byte, error)
}

type Config struct {
	Assets  Assets
	Metrics *Metrics
	// InitialMaxDatagram is the first guess at the largest datagram QUIC will
	// send. It is lowered automatically when QUIC reports a smaller limit.
	InitialMaxDatagram int
	// IdleTimeout evicts an RPC nothing has referred to for this long. The
	// client can still RESEND until then.
	IdleTimeout time.Duration
	// NewDropper, if set, makes a loss-injection hook for each session (see
	// ParseDropSpec). Testing only.
	NewDropper func() Dropper
	// NoSeq ignores the client's HELLO, so sessions keep plain v1 DATA even
	// when the client offers session sequence numbers.
	NoSeq bool
	// SendQueueTarget is how many datagrams the sender leaves sitting in
	// QUIC's send queue ahead of the packet it picks next: 0 takes
	// DefaultSendQueueTarget, and a negative value turns pacing off, letting
	// the queue run as deep as QUIC allows (see pacer.go).
	SendQueueTarget int
}

const (
	DefaultInitialMaxDatagram = 1200
	DefaultIdleTimeout        = 60 * time.Second
	// The HTTP/3 layer prefixes each datagram with a quarter-stream-ID varint
	// (1–8 bytes) that QUIC's too-large error doesn't account for.
	h3DatagramPrefixMax = 8
	// seqRingSize is how many recently sent DATA_SEQ datagrams the server
	// remembers, so RESEND_SEQ can name what to send again. 65536 entries is
	// ~77 MB of payload at 1183 bytes: far more than can be in flight.
	seqRingSize = 1 << 16
	// maxResendSeqRange caps how many sequence numbers one RESEND_SEQ may name.
	maxResendSeqRange = 1024
)

// Serve runs the HTTP4 protocol on conn until ctx ends or the connection fails.
func Serve(ctx context.Context, conn Conn, cfg Config) {
	if cfg.Metrics == nil {
		cfg.Metrics = new(Metrics)
	}
	if cfg.InitialMaxDatagram == 0 {
		cfg.InitialMaxDatagram = DefaultInitialMaxDatagram
	}
	if cfg.IdleTimeout == 0 {
		cfg.IdleTimeout = DefaultIdleTimeout
	}
	cfg.Metrics.Sessions.Add(1)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &session{
		conn:        conn,
		cfg:         cfg,
		m:           cfg.Metrics,
		rpcs:        make(map[wire.RPCID]*rpc),
		wake:        make(chan struct{}, 1),
		maxDatagram: cfg.InitialMaxDatagram,
		now:         time.Now,
	}
	s.pacer.target = cmp.Or(cfg.SendQueueTarget, DefaultSendQueueTarget)
	if cfg.NewDropper != nil {
		s.drop = cfg.NewDropper()
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		defer cancel()
		s.receiveLoop(ctx)
	})
	wg.Go(func() {
		defer cancel()
		s.sendLoop(ctx)
	})
	wg.Wait()
}

type span struct{ start, end uint32 }

type rpc struct {
	id    wire.RPCID
	asset []byte
	meta  *wire.Meta // sent before packet 0, and again with it on a repeated REQ
	size  uint32

	// All fields below are guarded by session.mu.
	// Written by the receive loop:
	granted    uint32 // may send [0, granted); only ever rises, capped at size
	resends    []span // requested ranges, clipped to what was granted and sent
	packet0Req uint64 // bumped by each REQ; packet 0 is due while > packet0Sent
	lastActive time.Time

	// Written by the send loop:
	next        uint32 // first byte never sent
	metaSent    uint64 // REQ generation the last META answered
	packet0Sent uint64
}

type session struct {
	conn Conn
	cfg  Config
	m    *Metrics
	now  func() time.Time
	drop Dropper // nil unless injecting loss; used by the send loop only

	pacer pacer // send loop only: keeps QUIC's send queue shallow

	mu          sync.Mutex
	rpcs        map[wire.RPCID]*rpc
	pending     []wire.Packet // control replies (ERROR), sent before any DATA
	maxDatagram int           // largest datagram QUIC accepts, as far as we know

	// Session sequence numbers (wire v2), guarded by mu. seqOn is set by the
	// receive loop when a HELLO offers CapSessionSeq; nextSeq and ring are
	// written by the send loop and read by the receive loop for RESEND_SEQ.
	seqOn   bool
	nextSeq uint64 // the next DATA_SEQ's number; past MaxUint32 we fall back to DATA
	ring    []seqEntry

	wake chan struct{}
}

// seqEntry records what one DATA_SEQ carried, so RESEND_SEQ can name it.
type seqEntry struct {
	seq    uint32
	valid  bool
	resent bool // already queued again once: repeats of the same RESEND_SEQ are ignored
	rpc    wire.RPCID
	off    uint32
	n      uint32
}

func (s *session) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *session) receiveLoop(ctx context.Context) {
	for {
		b, err := s.conn.ReceiveDatagram(ctx)
		if err != nil {
			return
		}
		s.m.PacketsIn.Add(1)
		p, err := wire.Decode(b)
		if err != nil {
			s.m.MalformedIn.Add(1)
			continue
		}
		s.mu.Lock()
		s.handle(p)
		s.mu.Unlock()
		s.signal()
	}
}

// handle applies one client packet to session state. Caller holds s.mu.
func (s *session) handle(p wire.Packet) {
	now := s.now()
	switch p := p.(type) {
	case *wire.Req:
		r := s.rpcs[p.RPCID]
		if r == nil {
			a, err := s.cfg.Assets.Get(p.AssetID)
			switch {
			case errors.Is(err, ErrNotFound):
				s.reply(&wire.Error{RPCID: p.RPCID, Code: wire.CodeNotFound})
				return
			case err != nil:
				log.Printf("asset %q: %v", p.AssetID, err)
				s.reply(&wire.Error{RPCID: p.RPCID, Code: wire.CodeBadRequest})
				return
			}
			r = &rpc{id: p.RPCID, asset: a.Body, meta: a.Meta(p.RPCID), size: uint32(len(a.Body))}
			s.rpcs[p.RPCID] = r
			s.m.RPCs.Add(1)
		}
		// A repeated REQ means the client is missing META or packet 0: send
		// both again. Its initial_grant counts like any other grant.
		r.packet0Req++
		r.raiseGrant(p.InitialGrant)
		r.lastActive = now

	case *wire.Grant:
		r := s.rpcs[p.RPCID]
		if r == nil {
			s.reply(&wire.Error{RPCID: p.RPCID, Code: wire.CodeUnknownRPC})
			return
		}
		r.raiseGrant(p.MaxOffset)
		r.lastActive = now

	case *wire.Resend:
		r := s.rpcs[p.RPCID]
		if r == nil {
			s.reply(&wire.Error{RPCID: p.RPCID, Code: wire.CodeUnknownRPC})
			return
		}
		r.lastActive = now
		// Only granted bytes may be resent. Bytes past `next` haven't been
		// sent yet and will go out as new data anyway.
		end := min(p.End, r.granted, r.next)
		if p.Start < end {
			r.resends = append(r.resends, span{p.Start, end})
		}

	case *wire.Hello:
		s.m.HellosIn.Add(1)
		if !s.cfg.NoSeq && p.Caps&wire.CapSessionSeq != 0 && !s.seqOn {
			s.seqOn = true
			s.ring = make([]seqEntry, seqRingSize)
		}

	case *wire.ResendSeq:
		if !s.seqOn {
			s.m.MalformedIn.Add(1) // never negotiated: the client shouldn't send it
			return
		}
		s.m.SeqResends.Add(1)
		end := min(uint64(p.End), uint64(p.Start)+maxResendSeqRange)
		for seq := uint64(p.Start); seq < end; seq++ {
			s.resendSeq(uint32(seq), now)
		}

	default: // DATA, DATA_SEQ or ERROR from a client is a protocol violation
		s.m.MalformedIn.Add(1)
	}
}

// resendSeq queues again the bytes the DATA_SEQ numbered seq carried, clipped
// exactly as RESEND is: to what was granted and already sent. A number the
// ring no longer holds, or whose RPC has finished or been evicted, is skipped:
// the client's per-transfer recovery still covers it.
//
// Each number is resent at most once. The client repeats a RESEND_SEQ in case
// it was lost; the repeats must not duplicate data. If the repair itself is
// lost, it went out under a new number, which the client asks for instead.
// Caller holds s.mu.
func (s *session) resendSeq(seq uint32, now time.Time) {
	e := &s.ring[seq%seqRingSize]
	if !e.valid || e.seq != seq {
		s.m.SeqResendMisses.Add(1)
		return
	}
	if e.resent {
		s.m.SeqResendRepeats.Add(1)
		return
	}
	e.resent = true
	r := s.rpcs[e.rpc]
	if r == nil {
		s.m.SeqResendMisses.Add(1)
		return
	}
	r.lastActive = now
	end := min(e.off+e.n, r.granted, r.next)
	if e.off >= end {
		return
	}
	// Consecutive lost datagrams of one RPC merge into one range.
	if k := len(r.resends) - 1; k >= 0 && r.resends[k].end == e.off {
		r.resends[k].end = end
		return
	}
	r.resends = append(r.resends, span{e.off, end})
}

func (r *rpc) raiseGrant(g uint32) {
	r.granted = max(r.granted, min(g, r.size))
}

// reply queues a control packet for the send loop. Caller holds s.mu.
func (s *session) reply(p wire.Packet) {
	s.pending = append(s.pending, p)
}

// work is one packet the send loop has chosen, plus what to record once it's sent.
type work struct {
	pkt     wire.Packet
	r       *rpc
	kind    workKind
	packet0 uint64 // for workMeta/workPacket0: the request generation this answers
	seq     bool   // DATA goes out as DATA_SEQ (decided at pick, so the payload fits)
}

type workKind int

const (
	workControl workKind = iota
	workMeta
	workPacket0
	workResend
	workNew
)

func (s *session) sendLoop(ctx context.Context) {
	sweep := time.NewTicker(max(s.cfg.IdleTimeout/4, time.Millisecond))
	defer sweep.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			s.evictIdle()
		default:
		}
		if !s.pace(ctx) {
			return
		}
		s.mu.Lock()
		w, ok := s.pick()
		s.mu.Unlock()
		if !ok {
			select {
			case <-ctx.Done():
				return
			case <-s.wake:
			case <-sweep.C:
				s.evictIdle()
			}
			continue
		}
		if !s.send(ctx, w) {
			return
		}
	}
}

// pace holds off until QUIC's send queue is shallow enough that the packet
// picked next won't sit behind bulk queued earlier. It returns false once the
// session is over. A wake re-checks rather than waiting the estimate out: by
// then the queue has often drained already.
func (s *session) pace(ctx context.Context) bool {
	for {
		d := s.pacer.wait(s.now())
		if d <= 0 {
			return true
		}
		s.m.PacedWaits.Add(1)
		start := s.now()
		timer := time.NewTimer(d)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-timer.C:
		case <-s.wake:
			timer.Stop()
		}
		s.m.PacedWaitMicros.Add(s.now().Sub(start).Microseconds())
	}
}

// pick chooses the next packet. Order: control replies, then META, then
// packet 0s, then resends, then new data. So an RPC's META always leaves just
// ahead of its packet 0. Among RPCs it takes the one with the fewest bytes
// left (SRPT), matching the client's scheduler. Caller holds s.mu.
func (s *session) pick() (work, bool) {
	if len(s.pending) > 0 {
		return work{pkt: s.pending[0], kind: workControl}, true
	}
	var best *rpc
	var bestKind workKind
	for _, r := range s.rpcs {
		k, ok := r.due()
		if !ok {
			continue
		}
		if best == nil || k < bestKind || (k == bestKind && r.size-r.next < best.size-best.next) {
			best, bestKind = r, k
		}
	}
	if best == nil {
		return work{}, false
	}
	r := best
	// Only the send loop advances nextSeq, and pick runs on the send loop.
	seq := s.seqOn && s.nextSeq <= math.MaxUint32
	chunk := uint32(s.chunk(seq))
	switch bestKind {
	case workMeta:
		return work{pkt: r.meta, r: r, kind: workMeta, packet0: r.packet0Req}, true
	case workPacket0:
		n := min(chunk, r.granted)
		return work{pkt: r.data(0, n), r: r, kind: workPacket0, packet0: r.packet0Req, seq: seq}, true
	case workResend:
		sp := r.resends[0]
		n := min(chunk, sp.end-sp.start)
		return work{pkt: r.data(sp.start, n), r: r, kind: workResend, seq: seq}, true
	default:
		n := min(chunk, r.granted-r.next)
		return work{pkt: r.data(r.next, n), r: r, kind: workNew, seq: seq}, true
	}
}

// chunk is how many payload bytes one DATA (or DATA_SEQ) datagram carries.
// Caller holds s.mu.
func (s *session) chunk(seq bool) int {
	if seq {
		return max(1, wire.MaxPayloadSeq(s.maxDatagram))
	}
	return max(1, wire.MaxPayload(s.maxDatagram))
}

// due reports the most urgent kind of packet r has waiting, if any.
func (r *rpc) due() (workKind, bool) {
	switch {
	case r.packet0Req > r.metaSent:
		return workMeta, true
	case r.packet0Req > r.packet0Sent:
		return workPacket0, true
	case len(r.resends) > 0:
		return workResend, true
	case r.next < r.granted:
		return workNew, true
	}
	return 0, false
}

func (r *rpc) data(off, n uint32) *wire.Data {
	return &wire.Data{RPCID: r.id, TotalSize: r.size, Offset: off, Payload: r.asset[off : off+n]}
}

// send transmits w and records its effect. It returns false once the
// connection is unusable.
func (s *session) send(ctx context.Context, w work) bool {
	d, isData := w.pkt.(*wire.Data)
	_, isMeta := w.pkt.(*wire.Meta)
	if isData {
		// G2 check. This is the one place DATA leaves the server, so it is
		// the one place the grant is checked. The packet is still sent: the
		// counter must measure what actually went out, and a test that sees
		// it rise has found a bug.
		s.mu.Lock()
		granted := w.r.granted
		s.mu.Unlock()
		if end := d.Offset + uint32(len(d.Payload)); end > granted {
			over := end - max(d.Offset, granted)
			s.m.UngrantedSent.Add(int64(over))
			log.Printf("BUG: rpc %016x sending [%d, %d) past grant %d", uint64(w.r.id), d.Offset, end, granted)
		}
	}

	// DATA_SEQ is DATA with the next session sequence number: the G2 check
	// above and every counter below treat it exactly like DATA.
	out := w.pkt
	var seq uint32
	if isData && w.seq {
		seq = uint32(s.nextSeq) // only the send loop writes nextSeq
		out = &wire.DataSeq{Data: *d, Seq: seq}
	}
	b, err := wire.Marshal(out)
	if err != nil {
		log.Printf("BUG: cannot encode %+v: %v", w.pkt, err)
		return false
	}
	if isData && s.drop != nil && s.drop(w.dropInfo(d)) {
		// Simulated loss: record it as sent, as if it vanished on the wire.
		s.m.DroppedData.Add(1)
	} else if isMeta && s.drop != nil && s.drop(DropInfo{Meta: true, Resend: w.r.metaSent > 0}) {
		s.m.DroppedMeta.Add(1)
	} else if err := s.transmit(b); err != nil {
		var tooLarge *quic.DatagramTooLargeError
		if errors.As(err, &tooLarge) && isData {
			// Nothing was sent and nothing was recorded, so the same work is
			// picked again next time, at the smaller chunk size.
			s.mu.Lock()
			s.maxDatagram = int(tooLarge.MaxDatagramPayloadSize) - h3DatagramPrefixMax
			s.mu.Unlock()
			s.m.ChunkShrinks.Add(1)
			return true
		}
		if ctx.Err() == nil {
			log.Printf("send datagram: %v", err)
		}
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	switch w.kind {
	case workControl:
		s.pending = s.pending[1:]
		s.m.ErrorsSent.Add(1)
		return true
	case workMeta:
		// META is metadata, not body bytes: no grant covers it and it never
		// counts toward UngrantedSent.
		w.r.metaSent = w.packet0
		s.m.MetaPackets.Add(1)
		return true
	case workPacket0:
		w.r.packet0Sent = w.packet0
		// The first request sends new bytes; later ones resend them.
		if n := uint32(len(d.Payload)); w.r.next >= n {
			s.m.ResentBytes.Add(int64(n))
		} else {
			w.r.next = n
		}
	case workResend:
		w.r.resends[0].start += uint32(len(d.Payload))
		if w.r.resends[0].start >= w.r.resends[0].end {
			w.r.resends = w.r.resends[1:]
		}
		s.m.ResentBytes.Add(int64(len(d.Payload)))
	case workNew:
		w.r.next += uint32(len(d.Payload))
	}
	if isData && w.seq {
		// The number is used up whether the datagram arrived or was dropped
		// on the way, exactly as a real loss would use it up.
		s.ring[seq%seqRingSize] = seqEntry{seq: seq, valid: true, rpc: w.r.id, off: d.Offset, n: uint32(len(d.Payload))}
		s.nextSeq++
		s.m.DataSeqPackets.Add(1)
	}
	s.m.DataPackets.Add(1)
	s.m.DataBytes.Add(int64(len(d.Payload)))
	return true
}

// transmit hands one datagram to QUIC, timing the handover. A handover that
// waits means QUIC's queue was full and one datagram left to make room, which
// is the pacer's only view of how fast the wire is draining.
func (s *session) transmit(b []byte) error {
	start := s.now()
	err := s.conn.SendDatagram(b)
	at := s.now()
	if err != nil {
		return err
	}
	blocked := at.Sub(start) >= pacerBlocked
	if blocked {
		s.m.SendBlocked.Add(1)
	}
	s.pacer.sent(at, blocked)
	s.m.PacerIntervalUs.Store(s.pacer.interval.Microseconds())
	return nil
}

func (w work) dropInfo(d *wire.Data) DropInfo {
	end := d.Offset + uint32(len(d.Payload))
	return DropInfo{
		Packet0: d.Offset == 0,
		Final:   d.TotalSize > 0 && end == d.TotalSize,
		// Only the send loop writes r.next, and this runs on the send loop.
		Resend: w.kind == workResend || (w.kind == workPacket0 && w.r.next >= end),
	}
}

func (s *session) evictIdle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := s.now().Add(-s.cfg.IdleTimeout)
	for id, r := range s.rpcs {
		if r.lastActive.Before(cutoff) {
			delete(s.rpcs, id)
			s.m.RPCsEvicted.Add(1)
		}
	}
}
