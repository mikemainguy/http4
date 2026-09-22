package sender

import (
	"bytes"
	"testing"

	"http4/server/internal/wire"
)

// seqs returns the DATA_SEQ packets among ps, and fails if any plain DATA is mixed in.
func seqs(t *testing.T, ps []wire.Packet) []*wire.DataSeq {
	t.Helper()
	var out []*wire.DataSeq
	for _, p := range ps {
		switch p := p.(type) {
		case *wire.DataSeq:
			out = append(out, p)
		case *wire.Data:
			t.Errorf("plain DATA at offset %d after session sequence numbers were negotiated", p.Offset)
		}
	}
	return out
}

func noSeqs(t *testing.T, ps []wire.Packet) {
	t.Helper()
	for _, p := range ps {
		if _, ok := p.(*wire.DataSeq); ok {
			t.Fatal("DATA_SEQ sent without negotiation")
		}
	}
}

func hello() *wire.Hello { return &wire.Hello{Caps: wire.CapSessionSeq} }

// Compatibility: a client that never sends HELLO (every v1 client) gets
// exactly v1 behaviour, plain DATA.
func TestNoHelloMeansPlainData(t *testing.T) {
	a := asset(5000)
	h := start(t, MapAssets{"a": a}, nil)
	h.send(&wire.Req{RPCID: 1, InitialGrant: 5000, AssetID: "a"})
	ps := h.drain(quiet)
	noSeqs(t, ps)
	if got, _ := assemble(len(a), datas(ps)); !bytes.Equal(got, a) {
		t.Fatal("asset incomplete")
	}
}

// Compatibility: a server started with NoSeq ignores HELLO and stays on v1.
func TestNoSeqServerIgnoresHello(t *testing.T) {
	a := asset(5000)
	h := start(t, MapAssets{"a": a}, func(c *Config) { c.NoSeq = true })
	h.send(hello())
	h.send(&wire.Req{RPCID: 1, InitialGrant: 5000, AssetID: "a"})
	noSeqs(t, h.drain(quiet))
	if h.m.HellosIn.Load() != 1 || h.m.DataSeqPackets.Load() != 0 {
		t.Errorf("metrics %+v", h.m.Snapshot())
	}
}

// HELLO with unknown capability bits only turns on what the server knows,
// and a HELLO without CapSessionSeq changes nothing.
func TestHelloBits(t *testing.T) {
	h := start(t, MapAssets{"a": asset(100)}, nil)
	h.send(&wire.Hello{Caps: 0xfffffffe}) // every bit except SESSION_SEQ
	h.send(&wire.Req{RPCID: 1, InitialGrant: 100, AssetID: "a"})
	noSeqs(t, h.drain(quiet))

	h.send(&wire.Hello{Caps: 0xffffffff})
	h.send(&wire.Req{RPCID: 2, InitialGrant: 100, AssetID: "a"})
	if len(seqs(t, h.drain(quiet))) == 0 {
		t.Fatal("no DATA_SEQ after a HELLO with SESSION_SEQ and unknown bits")
	}
}

// Negotiated: every DATA is DATA_SEQ, numbered 0, 1, 2, ... across RPCs,
// with smaller payloads so the datagram size is unchanged.
func TestSeqNumbersAreSessionWideAndConsecutive(t *testing.T) {
	a, b := asset(7000), asset(3000)
	h := start(t, MapAssets{"a": a, "b": b}, nil)
	h.send(hello())
	h.send(&wire.Req{RPCID: 1, InitialGrant: 7000, AssetID: "a"})
	h.send(&wire.Req{RPCID: 2, InitialGrant: 3000, AssetID: "b"})
	ss := seqs(t, h.drain(quiet))
	for i, d := range ss {
		if d.Seq != uint32(i) {
			t.Fatalf("packet %d has seq %d", i, d.Seq)
		}
		if n := len(d.Payload); n > wire.MaxPayloadSeq(DefaultInitialMaxDatagram) {
			t.Fatalf("DATA_SEQ payload %d exceeds %d", n, wire.MaxPayloadSeq(DefaultInitialMaxDatagram))
		}
	}
	byRPC := map[wire.RPCID][]*wire.Data{}
	for _, d := range ss {
		byRPC[d.RPCID] = append(byRPC[d.RPCID], &d.Data)
	}
	if got, _ := assemble(len(a), byRPC[1]); !bytes.Equal(got, a) {
		t.Error("a incomplete")
	}
	if got, _ := assemble(len(b), byRPC[2]); !bytes.Equal(got, b) {
		t.Error("b incomplete")
	}
}

// RESEND_SEQ names lost datagrams by number. The server sends the same bytes
// again under new numbers, clipped like RESEND, and counts no un-granted bytes.
func TestResendSeqRepairsByNumber(t *testing.T) {
	a := asset(20_000)
	newDropper, err := ParseDropSpec("every=4")
	if err != nil {
		t.Fatal(err)
	}
	h := start(t, MapAssets{"a": a}, func(c *Config) { c.NewDropper = newDropper })
	h.send(hello())
	h.send(&wire.Req{RPCID: 1, InitialGrant: 20_000, AssetID: "a"})

	buf := make([]byte, len(a))
	have := make([]bool, len(a))
	seen := map[uint32]bool{}
	next := uint32(0) // numbers below this have been accounted for
	for round := 0; ; round++ {
		for _, d := range seqs(t, h.drain(quiet)) {
			seen[d.Seq] = true
			copy(buf[d.Offset:], d.Payload)
			for i := range d.Payload {
				have[int(d.Offset)+i] = true
			}
		}
		if !bytes.Contains(boolBytes(have), []byte{0}) {
			break
		}
		if round == 20 {
			t.Fatal("still incomplete after 20 rounds")
		}
		// Ask for each missing number once, in contiguous runs, as a client would.
		top := uint32(0)
		for s := range seen {
			top = max(top, s+1)
		}
		for s := next; s < top; s++ {
			if seen[s] {
				continue
			}
			e := s
			for e < top && !seen[e] {
				e++
			}
			h.send(&wire.ResendSeq{Start: s, End: e})
			s = e
		}
		next = top
	}
	if !bytes.Equal(buf, a) {
		t.Fatal("reassembled asset differs")
	}
	m := h.m.Snapshot()
	if m.SeqResends == 0 || m.ResentBytes == 0 || m.SeqResendMisses != 0 {
		t.Errorf("expected RESEND_SEQ repairs without misses, got %+v", m)
	}
}

// A RESEND_SEQ before negotiation is a protocol violation and is dropped; a
// number the server never sent is a miss, not a crash.
func TestResendSeqEdgeCases(t *testing.T) {
	h := start(t, MapAssets{"a": asset(3000)}, nil)
	h.send(&wire.ResendSeq{Start: 0, End: 5})
	h.drain(quiet)
	if h.m.MalformedIn.Load() != 1 {
		t.Errorf("MalformedIn = %d, want 1", h.m.MalformedIn.Load())
	}
	h.send(hello())
	h.send(&wire.Req{RPCID: 1, InitialGrant: 3000, AssetID: "a"})
	h.drain(quiet)
	h.send(&wire.ResendSeq{Start: 1000, End: 1003})
	if ps := h.drain(quiet); len(ps) != 0 {
		t.Errorf("unexpected reply %+v", ps)
	}
	if h.m.SeqResendMisses.Load() != 3 {
		t.Errorf("SeqResendMisses = %d, want 3", h.m.SeqResendMisses.Load())
	}
}

// A repeated RESEND_SEQ (the client re-asks in case the first was lost) must
// not send the data twice: each number is resent at most once.
func TestRepeatedResendSeqIsIgnored(t *testing.T) {
	a := asset(3000)
	// "final" drops the first transmission of the last chunk only, so the
	// repair itself gets through.
	newDropper, err := ParseDropSpec("final")
	if err != nil {
		t.Fatal(err)
	}
	h := start(t, MapAssets{"a": a}, func(c *Config) { c.NewDropper = newDropper })
	h.send(hello())
	h.send(&wire.Req{RPCID: 1, InitialGrant: 3000, AssetID: "a"})
	first := seqs(t, h.drain(quiet))
	if len(first) != 2 || first[0].Seq != 0 || first[1].Seq != 1 {
		t.Fatalf("expected seqs 0 and 1 with 2 (the final chunk) dropped, got %d packets", len(first))
	}
	for range 3 {
		h.send(&wire.ResendSeq{Start: 2, End: 3})
	}
	again := datas(h.drain(quiet))
	if len(again) != 1 {
		t.Fatalf("got %d packets back for one lost number asked three times", len(again))
	}
	if h.m.SeqResendRepeats.Load() != 2 {
		t.Errorf("SeqResendRepeats = %d, want 2", h.m.SeqResendRepeats.Load())
	}
}

// DATA_SEQ datagrams are 4 bytes bigger, so when QUIC refuses a size the
// chunk shrinks for DATA_SEQ's header too.
func TestSeqChunkShrinks(t *testing.T) {
	a := asset(20_000)
	h := start(t, MapAssets{"a": a}, nil)
	h.mu.Lock()
	h.maxSize = 900
	h.mu.Unlock()
	h.send(hello())
	h.send(&wire.Req{RPCID: 1, InitialGrant: 20_000, AssetID: "a"})
	ss := seqs(t, h.drain(quiet))
	for _, d := range ss {
		if wire.DataSeqHeaderLen+len(d.Payload) > 900-h3DatagramPrefixMax {
			t.Fatalf("DATA_SEQ with %d payload bytes exceeds the limit", len(d.Payload))
		}
	}
	if got, _ := assemble(len(a), datasOf(ss)); !bytes.Equal(got, a) {
		t.Fatal("asset incomplete after chunk shrink")
	}
}

func datasOf(ss []*wire.DataSeq) []*wire.Data {
	ds := make([]*wire.Data, len(ss))
	for i, d := range ss {
		ds[i] = &d.Data
	}
	return ds
}

func boolBytes(bs []bool) []byte {
	out := make([]byte, len(bs))
	for i, b := range bs {
		if b {
			out[i] = 1
		}
	}
	return out
}
