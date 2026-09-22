package sender

import (
	"bytes"
	"testing"

	"http4/server/internal/wire"
)

func TestParseDropSpec(t *testing.T) {
	for _, bad := range []string{"every=1", "every=x", "rate=0", "rate=1", "rate=-1", "seed=-1", "bogus", "packet0,nope=3"} {
		if _, err := ParseDropSpec(bad); err == nil {
			t.Errorf("ParseDropSpec(%q) accepted", bad)
		}
	}
	if f, err := ParseDropSpec(" , "); err != nil || f != nil {
		t.Errorf("empty spec: dropper set=%t, err=%v; want no dropper, no error", f != nil, err)
	}
}

func TestDropRules(t *testing.T) {
	newDropper, err := ParseDropSpec("every=3,packet0,final")
	if err != nil {
		t.Fatal(err)
	}
	d := newDropper()
	plain := DropInfo{}
	got := []bool{d(plain), d(plain), d(plain), d(plain), d(plain), d(plain)}
	want := []bool{false, false, true, false, false, true}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("every=3 drops %v, want %v", got, want)
		}
	}
	d = newDropper() // fresh session: counter restarts
	if !d(DropInfo{Packet0: true}) || d(DropInfo{Packet0: true, Resend: true}) {
		t.Error("packet0 must drop the first transmission only")
	}
	if !d(DropInfo{Final: true}) || d(DropInfo{Final: true, Resend: true}) {
		t.Error("final must drop the first transmission only")
	}
	if d(DropInfo{Meta: true}) {
		t.Error("META dropped without the meta rule")
	}

	newDropper, _ = ParseDropSpec("meta,every=2")
	d = newDropper()
	if !d(DropInfo{Meta: true}) || d(DropInfo{Meta: true, Resend: true}) {
		t.Error("meta must drop the first transmission only")
	}
	// META doesn't advance the every=N counter: the 2nd DATA is still the one dropped.
	if d(DropInfo{}) || !d(DropInfo{}) {
		t.Error("every=2 must count DATA packets only")
	}
}

func TestDropRateIsSeededAndRoughlyRight(t *testing.T) {
	newDropper, _ := ParseDropSpec("rate=0.1,seed=9")
	a, b := newDropper(), newDropper()
	drops := 0
	for range 10_000 {
		x, y := a(DropInfo{}), b(DropInfo{})
		if x != y {
			t.Fatal("same seed gave different drops")
		}
		if x {
			drops++
		}
	}
	if drops < 800 || drops > 1200 {
		t.Errorf("rate=0.1 dropped %d of 10000", drops)
	}
}

// With a lossy sender, a client that RESENDs its gaps still gets every byte,
// and the server's G2 counter stays 0 (a resend is not an un-granted byte).
func TestRecoveryThroughDroppedData(t *testing.T) {
	a := asset(60_000)
	newDropper, err := ParseDropSpec("every=4,packet0,final")
	if err != nil {
		t.Fatal(err)
	}
	h := start(t, MapAssets{"a": a}, func(c *Config) { c.NewDropper = newDropper })
	h.send(&wire.Req{RPCID: 1, InitialGrant: 60_000, AssetID: "a"})

	buf := make([]byte, len(a))
	have := make([]bool, len(a))
	for round := 0; ; round++ {
		for _, d := range datas(h.drain(quiet)) {
			copy(buf[d.Offset:], d.Payload)
			for i := range d.Payload {
				have[int(d.Offset)+i] = true
			}
		}
		var gaps []span
		for i := 0; i < len(have); {
			if have[i] {
				i++
				continue
			}
			j := i
			for j < len(have) && !have[j] {
				j++
			}
			gaps = append(gaps, span{uint32(i), uint32(j)})
			i = j
		}
		if len(gaps) == 0 {
			break
		}
		if round == 20 {
			t.Fatalf("still missing %v after 20 rounds", gaps)
		}
		for _, g := range gaps {
			h.send(&wire.Resend{RPCID: 1, Start: g.start, End: g.end})
		}
	}
	if !bytes.Equal(buf, a) {
		t.Fatal("recovered asset differs")
	}
	if h.m.DroppedData.Load() == 0 || h.m.ResentBytes.Load() == 0 {
		t.Errorf("expected drops and resends, got %+v", h.m.Snapshot())
	}
}
