package sender

import (
	"bytes"
	"context"
	"errors"
	"math/rand/v2"
	"sync"
	"testing"
	"time"

	"github.com/quic-go/quic-go"

	"http4/server/internal/wire"
)

// fakeConn is an in-memory datagram pipe. It checks every DATA the server
// sends against the highest grant the test has sent for that RPC. That check
// is independent of the server's own G2 counter.
type fakeConn struct {
	t      *testing.T
	in     chan []byte
	out    chan wire.Packet
	closed chan struct{}

	mu        sync.Mutex
	maxSize   int           // > 0: refuse larger datagrams like QUIC does
	gate      chan struct{} // non-nil: each send waits for a token
	ceiling   map[wire.RPCID]uint32
	violation []string
}

func newFakeConn(t *testing.T) *fakeConn {
	return &fakeConn{
		t:       t,
		in:      make(chan []byte, 1024),
		out:     make(chan wire.Packet, 1<<16),
		closed:  make(chan struct{}),
		ceiling: make(map[wire.RPCID]uint32),
	}
}

func (c *fakeConn) ReceiveDatagram(ctx context.Context) ([]byte, error) {
	select {
	case b := <-c.in:
		return b, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.closed:
		return nil, errors.New("closed")
	}
}

func (c *fakeConn) SendDatagram(b []byte) error {
	c.mu.Lock()
	maxSize, gate := c.maxSize, c.gate
	c.mu.Unlock()
	if maxSize > 0 && len(b) > maxSize {
		return &quic.DatagramTooLargeError{MaxDatagramPayloadSize: int64(maxSize)}
	}
	if gate != nil {
		select {
		case <-gate:
		case <-c.closed:
			return errors.New("closed")
		}
	}
	p, err := wire.Decode(b)
	if err != nil {
		c.t.Errorf("server sent undecodable datagram %x: %v", b, err)
		return nil
	}
	if d, ok := p.(*wire.Data); ok {
		c.mu.Lock()
		if end := d.Offset + uint32(len(d.Payload)); end > c.ceiling[d.RPCID] {
			c.violation = append(c.violation, "DATA past grant")
			c.t.Errorf("rpc %x: DATA [%d, %d) past client grant %d", d.RPCID, d.Offset, end, c.ceiling[d.RPCID])
		}
		c.mu.Unlock()
	}
	select {
	case c.out <- p:
		return nil
	case <-c.closed:
		return errors.New("closed")
	}
}

// send encodes p as the client, raising the oracle's ceiling before the
// server can possibly act on the grant.
func (c *fakeConn) send(p wire.Packet) {
	c.t.Helper()
	c.mu.Lock()
	switch p := p.(type) {
	case *wire.Req:
		c.ceiling[p.RPCID] = max(c.ceiling[p.RPCID], p.InitialGrant)
	case *wire.Grant:
		c.ceiling[p.RPCID] = max(c.ceiling[p.RPCID], p.MaxOffset)
	}
	c.mu.Unlock()
	b, err := wire.Marshal(p)
	if err != nil {
		c.t.Fatal(err)
	}
	c.in <- b
}

// drain collects what the server sends until it has been quiet for `quiet`.
func (c *fakeConn) drain(quiet time.Duration) []wire.Packet {
	var got []wire.Packet
	for {
		select {
		case p := <-c.out:
			got = append(got, p)
		case <-time.After(quiet):
			return got
		}
	}
}

type harness struct {
	*fakeConn
	m *Metrics
}

func start(t *testing.T, assets MapAssets, tweak func(*Config)) harness {
	t.Helper()
	c := newFakeConn(t)
	m := new(Metrics)
	cfg := Config{Assets: assets, Metrics: m}
	if tweak != nil {
		tweak(&cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Serve(ctx, c, cfg)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		close(c.closed)
		<-done
		if n := m.UngrantedSent.Load(); n != 0 {
			t.Errorf("server's own G2 counter: %d un-granted bytes", n)
		}
	})
	return harness{c, m}
}

const quiet = 50 * time.Millisecond

func asset(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7 + i>>8)
	}
	return b
}

func datas(ps []wire.Packet) []*wire.Data {
	var ds []*wire.Data
	for _, p := range ps {
		if d, ok := p.(*wire.Data); ok {
			ds = append(ds, d)
		}
	}
	return ds
}

// assemble writes every DATA into a buffer and returns it with the number of payload bytes received.
func assemble(size int, ds []*wire.Data) ([]byte, int) {
	buf := make([]byte, size)
	n := 0
	for _, d := range ds {
		copy(buf[d.Offset:], d.Payload)
		n += len(d.Payload)
	}
	return buf, n
}

func TestInitialGrantCoversWholeAsset(t *testing.T) {
	a := asset(5000)
	h := start(t, MapAssets{"a": a}, nil)
	h.send(&wire.Req{RPCID: 1, InitialGrant: 5000, AssetID: "a"})
	ds := datas(h.drain(quiet))
	got, n := assemble(len(a), ds)
	if !bytes.Equal(got, a) || n != len(a) {
		t.Fatalf("got %d bytes in %d packets, want exactly the asset", n, len(ds))
	}
	if ds[0].Offset != 0 || ds[0].TotalSize != 5000 {
		t.Errorf("first packet %+v is not packet 0", ds[0])
	}
}

func TestZeroInitialGrantSendsOnlySize(t *testing.T) {
	h := start(t, MapAssets{"a": asset(5000)}, nil)
	h.send(&wire.Req{RPCID: 1, InitialGrant: 0, AssetID: "a"})
	ds := datas(h.drain(quiet))
	if len(ds) != 1 || len(ds[0].Payload) != 0 || ds[0].TotalSize != 5000 {
		t.Fatalf("got %+v, want one empty packet 0 carrying total_size", ds)
	}
}

func TestGrantsAreCumulativeAndMonotone(t *testing.T) {
	a := asset(10_000)
	h := start(t, MapAssets{"a": a}, nil)
	h.send(&wire.Req{RPCID: 7, InitialGrant: 0, AssetID: "a"})
	h.drain(quiet)

	h.send(&wire.Grant{RPCID: 7, MaxOffset: 3000})
	h.send(&wire.Grant{RPCID: 7, MaxOffset: 1000}) // late and lower: ignored
	h.send(&wire.Grant{RPCID: 7, MaxOffset: 3000}) // duplicate
	_, n := assemble(len(a), datas(h.drain(quiet)))
	if n != 3000 {
		t.Fatalf("sent %d bytes, want exactly 3000", n)
	}

	h.send(&wire.Grant{RPCID: 7, MaxOffset: 1 << 30}) // past the end: clamped
	_, n = assemble(len(a), datas(h.drain(quiet)))
	if n != 7000 {
		t.Fatalf("sent %d more bytes, want the remaining 7000", n)
	}
}

func TestEmptyAsset(t *testing.T) {
	h := start(t, MapAssets{"e": {}}, nil)
	h.send(&wire.Req{RPCID: 1, InitialGrant: 100, AssetID: "e"})
	ds := datas(h.drain(quiet))
	if len(ds) != 1 || ds[0].TotalSize != 0 || len(ds[0].Payload) != 0 {
		t.Fatalf("got %+v, want one empty packet 0", ds)
	}
}

func TestErrors(t *testing.T) {
	h := start(t, MapAssets{"a": asset(10)}, nil)
	h.send(&wire.Req{RPCID: 1, InitialGrant: 10, AssetID: "missing"})
	h.send(&wire.Grant{RPCID: 2, MaxOffset: 10})
	h.send(&wire.Resend{RPCID: 3, Start: 0, End: 10})
	want := map[wire.RPCID]wire.ErrorCode{1: wire.CodeNotFound, 2: wire.CodeUnknownRPC, 3: wire.CodeUnknownRPC}
	got := map[wire.RPCID]wire.ErrorCode{}
	for _, p := range h.drain(quiet) {
		e, ok := p.(*wire.Error)
		if !ok {
			t.Fatalf("unexpected %+v", p)
		}
		got[e.RPCID] = e.Code
	}
	if len(got) != len(want) {
		t.Fatalf("errors %v, want %v", got, want)
	}
	for id, code := range want {
		if got[id] != code {
			t.Errorf("rpc %d: code %d, want %d", id, got[id], code)
		}
	}
}

func TestMalformedAndClientOnlyPacketsAreDropped(t *testing.T) {
	a := asset(100)
	h := start(t, MapAssets{"a": a}, nil)
	h.in <- []byte{0xff}
	h.send(&wire.Data{RPCID: 1, TotalSize: 1, Offset: 0, Payload: []byte{1}})
	h.send(&wire.Req{RPCID: 1, InitialGrant: 100, AssetID: "a"})
	if got, _ := assemble(len(a), datas(h.drain(quiet))); !bytes.Equal(got, a) {
		t.Fatal("session did not keep working after bad packets")
	}
	if n := h.m.MalformedIn.Load(); n != 2 {
		t.Errorf("MalformedIn = %d, want 2", n)
	}
}

func TestResendIsClippedToWhatWasGrantedAndSent(t *testing.T) {
	a := asset(10_000)
	h := start(t, MapAssets{"a": a}, nil)
	h.send(&wire.Req{RPCID: 1, InitialGrant: 4000, AssetID: "a"})
	h.drain(quiet)

	h.send(&wire.Resend{RPCID: 1, Start: 1000, End: 9000})
	ds := datas(h.drain(quiet))
	lo, hi := uint32(1<<31), uint32(0)
	n := 0
	for _, d := range ds {
		lo, hi = min(lo, d.Offset), max(hi, d.Offset+uint32(len(d.Payload)))
		n += len(d.Payload)
		if !bytes.Equal(d.Payload, a[d.Offset:d.Offset+uint32(len(d.Payload))]) {
			t.Errorf("resent bytes at %d are wrong", d.Offset)
		}
	}
	if lo != 1000 || hi != 4000 || n != 3000 {
		t.Fatalf("resent [%d, %d) %d bytes, want [1000, 4000) 3000 bytes", lo, hi, n)
	}
	if got := h.m.ResentBytes.Load(); got != 3000 {
		t.Errorf("ResentBytes = %d, want 3000", got)
	}
}

func TestRepeatedReqResendsPacket0WithoutNewRPC(t *testing.T) {
	a := asset(3000)
	h := start(t, MapAssets{"a": a}, nil)
	h.send(&wire.Req{RPCID: 9, InitialGrant: 500, AssetID: "a"})
	first := datas(h.drain(quiet))
	h.send(&wire.Req{RPCID: 9, InitialGrant: 500, AssetID: "a"})
	again := datas(h.drain(quiet))
	if len(first) != 1 || len(again) != 1 || again[0].Offset != 0 || !bytes.Equal(again[0].Payload, a[:500]) {
		t.Fatalf("first %+v, again %+v; want packet 0 with 500 bytes both times", first, again)
	}
	if n := h.m.RPCs.Load(); n != 1 {
		t.Errorf("RPCs = %d, want 1", n)
	}
}

func TestChunkShrinksWhenQUICRefusesSize(t *testing.T) {
	a := asset(20_000)
	h := start(t, MapAssets{"a": a}, nil)
	h.mu.Lock()
	h.maxSize = 900
	h.mu.Unlock()
	h.send(&wire.Req{RPCID: 1, InitialGrant: 20_000, AssetID: "a"})
	ds := datas(h.drain(quiet))
	if got, _ := assemble(len(a), ds); !bytes.Equal(got, a) {
		t.Fatal("asset incomplete after chunk shrink")
	}
	for _, d := range ds {
		if wire.DataHeaderLen+len(d.Payload) > 900-h3DatagramPrefixMax {
			t.Fatalf("packet of %d payload bytes exceeds the limit", len(d.Payload))
		}
	}
	if h.m.ChunkShrinks.Load() == 0 {
		t.Error("ChunkShrinks not counted")
	}
}

// While a send is stuck (QUIC's queue is full), incoming grants must still be
// processed. Here the receive side keeps handling packets while every send waits.
func TestReceiveNotBlockedBySend(t *testing.T) {
	h := start(t, MapAssets{"a": asset(50_000)}, nil)
	gate := make(chan struct{})
	h.mu.Lock()
	h.gate = gate
	h.mu.Unlock()
	h.send(&wire.Req{RPCID: 1, InitialGrant: 50_000, AssetID: "a"})
	for i := range 100 {
		h.send(&wire.Grant{RPCID: 1, MaxOffset: uint32(i)})
	}
	deadline := time.Now().Add(2 * time.Second)
	for h.m.PacketsIn.Load() < 101 {
		if time.Now().After(deadline) {
			t.Fatalf("only %d packets processed while send was blocked", h.m.PacketsIn.Load())
		}
		time.Sleep(time.Millisecond)
	}
	close(gate)
}

func TestIdleRPCsAreEvicted(t *testing.T) {
	h := start(t, MapAssets{"a": asset(10)}, func(c *Config) { c.IdleTimeout = 20 * time.Millisecond })
	h.send(&wire.Req{RPCID: 1, InitialGrant: 10, AssetID: "a"})
	h.drain(quiet)
	time.Sleep(100 * time.Millisecond)
	h.send(&wire.Grant{RPCID: 1, MaxOffset: 10})
	ps := h.drain(quiet)
	if len(ps) != 1 {
		t.Fatalf("got %+v, want one UNKNOWN_RPC error", ps)
	}
	if e, ok := ps[0].(*wire.Error); !ok || e.Code != wire.CodeUnknownRPC {
		t.Fatalf("got %+v, want UNKNOWN_RPC", ps[0])
	}
	if h.m.RPCsEvicted.Load() != 1 {
		t.Error("eviction not counted")
	}
}

// Many RPCs, grants in random order (some lower, some repeated), repeated
// REQs, random RESENDs, and a chunk limit that changes mid-run. Every DATA is
// checked against the grant oracle as it is sent. Finally everything is
// granted and each asset must reassemble exactly.
func TestRandomizedGrantDiscipline(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	assets := MapAssets{}
	sizes := map[wire.RPCID]int{}
	for i := range 12 {
		n := rng.IntN(40_000)
		assets[string(rune('a'+i))] = asset(n)
		sizes[wire.RPCID(i+1)] = n
	}
	h := start(t, assets, nil)
	for i := range 12 {
		id := wire.RPCID(i + 1)
		h.send(&wire.Req{RPCID: id, InitialGrant: uint32(rng.IntN(2000)), AssetID: string(rune('a' + i))})
	}
	var all []wire.Packet
	for step := range 400 {
		id := wire.RPCID(rng.IntN(12) + 1)
		size := sizes[id]
		switch rng.IntN(10) {
		case 0:
			h.send(&wire.Req{RPCID: id, InitialGrant: uint32(rng.IntN(2000)), AssetID: string(rune('a' + int(id) - 1))})
		case 1, 2:
			if size > 0 {
				s := uint32(rng.IntN(size))
				h.send(&wire.Resend{RPCID: id, Start: s, End: s + 1 + uint32(rng.IntN(size-int(s)))})
			}
		default:
			h.send(&wire.Grant{RPCID: id, MaxOffset: uint32(rng.IntN(size + 1)), Priority: uint8(rng.IntN(4))})
		}
		if step == 200 {
			h.mu.Lock()
			h.maxSize = 700
			h.mu.Unlock()
		}
		if step%50 == 0 {
			all = append(all, h.drain(5*time.Millisecond)...)
		}
	}
	for id, size := range sizes {
		h.send(&wire.Grant{RPCID: id, MaxOffset: uint32(size)})
	}
	all = append(all, h.drain(quiet)...)

	byRPC := map[wire.RPCID][]*wire.Data{}
	for _, d := range datas(all) {
		byRPC[d.RPCID] = append(byRPC[d.RPCID], d)
	}
	for id, size := range sizes {
		got, _ := assemble(size, byRPC[id])
		if !bytes.Equal(got, assets[string(rune('a'+int(id)-1))]) {
			t.Errorf("rpc %d (%d bytes) did not reassemble", id, size)
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.violation) > 0 {
		t.Fatalf("%d grant violations", len(h.violation))
	}
}
