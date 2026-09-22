// Package sender is the HTTP4 passive sender: it answers REQs and emits DATA
// only inside the byte ranges the client has granted (docs/wire-format.md).
//
// Each session runs two goroutines. The receive loop decodes packets and
// updates state; it never sends, so a slow send can't delay it. The send
// loop picks the next packet and hands it to QUIC. QUIC's SendDatagram blocks
// while its queue is full, which paces the send loop at the congestion
// controller's rate.
package sender

import (
	"context"
	"errors"
	"log"
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
}

const (
	DefaultInitialMaxDatagram = 1200
	DefaultIdleTimeout        = 60 * time.Second
	// The HTTP/3 layer prefixes each datagram with a quarter-stream-ID varint
	// (1–8 bytes) that QUIC's too-large error doesn't account for.
	h3DatagramPrefixMax = 8
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
		conn:  conn,
		cfg:   cfg,
		m:     cfg.Metrics,
		rpcs:  make(map[wire.RPCID]*rpc),
		wake:  make(chan struct{}, 1),
		chunk: wire.MaxPayload(cfg.InitialMaxDatagram),
		now:   time.Now,
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
	size  uint32

	// All fields below are guarded by session.mu.
	// Written by the receive loop:
	granted    uint32 // may send [0, granted); only ever rises, capped at size
	resends    []span // requested ranges, clipped to what was granted and sent
	packet0Req uint64 // bumped by each REQ; packet 0 is due while > packet0Sent
	lastActive time.Time

	// Written by the send loop:
	next        uint32 // first byte never sent
	packet0Sent uint64
}

type session struct {
	conn Conn
	cfg  Config
	m    *Metrics
	now  func() time.Time

	mu      sync.Mutex
	rpcs    map[wire.RPCID]*rpc
	pending []wire.Packet // control replies (ERROR), sent before any DATA
	chunk   int           // DATA payload bytes per datagram

	wake chan struct{}
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
			asset, err := s.cfg.Assets.Get(p.AssetID)
			switch {
			case errors.Is(err, ErrNotFound):
				s.reply(&wire.Error{RPCID: p.RPCID, Code: wire.CodeNotFound})
				return
			case err != nil:
				log.Printf("asset %q: %v", p.AssetID, err)
				s.reply(&wire.Error{RPCID: p.RPCID, Code: wire.CodeBadRequest})
				return
			}
			r = &rpc{id: p.RPCID, asset: asset, size: uint32(len(asset))}
			s.rpcs[p.RPCID] = r
			s.m.RPCs.Add(1)
		}
		// A repeated REQ means the client never saw packet 0: send it again.
		// Its initial_grant counts like any other grant.
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

	default: // DATA or ERROR from a client is a protocol violation
		s.m.MalformedIn.Add(1)
	}
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
	packet0 uint64 // for workPacket0: the request generation this answers
}

type workKind int

const (
	workControl workKind = iota
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

// pick chooses the next packet. Order: control replies, then packet 0s, then
// resends, then new data. Among RPCs it takes the one with the fewest bytes
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
	switch bestKind {
	case workPacket0:
		n := min(uint32(s.chunk), r.granted)
		return work{pkt: r.data(0, n), r: r, kind: workPacket0, packet0: r.packet0Req}, true
	case workResend:
		sp := r.resends[0]
		n := min(uint32(s.chunk), sp.end-sp.start)
		return work{pkt: r.data(sp.start, n), r: r, kind: workResend}, true
	default:
		n := min(uint32(s.chunk), r.granted-r.next)
		return work{pkt: r.data(r.next, n), r: r, kind: workNew}, true
	}
}

// due reports the most urgent kind of packet r has waiting, if any.
func (r *rpc) due() (workKind, bool) {
	switch {
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

	b, err := wire.Marshal(w.pkt)
	if err != nil {
		log.Printf("BUG: cannot encode %+v: %v", w.pkt, err)
		return false
	}
	if err := s.conn.SendDatagram(b); err != nil {
		var tooLarge *quic.DatagramTooLargeError
		if errors.As(err, &tooLarge) && isData {
			// Nothing was sent and nothing was recorded, so the same work is
			// picked again next time, at the smaller chunk size.
			s.mu.Lock()
			s.chunk = max(1, wire.MaxPayload(int(tooLarge.MaxDatagramPayloadSize)-h3DatagramPrefixMax))
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
	s.m.DataPackets.Add(1)
	s.m.DataBytes.Add(int64(len(d.Payload)))
	return true
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
