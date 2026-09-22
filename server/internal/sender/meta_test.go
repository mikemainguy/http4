package sender

import (
	"strings"
	"testing"
	"time"

	"http4/server/internal/wire"
)

func metas(ps []wire.Packet) []*wire.Meta {
	var ms []*wire.Meta
	for _, p := range ps {
		if m, ok := p.(*wire.Meta); ok {
			ms = append(ms, m)
		}
	}
	return ms
}

func TestMetaLeadsPacket0(t *testing.T) {
	h := start(t, MapAssets{"style.css": asset(3000)}, nil)
	h.send(&wire.Req{RPCID: 1, InitialGrant: 3000, AssetID: "style.css"})
	ps := h.drain(quiet)
	if len(ps) < 2 {
		t.Fatalf("got %d packets", len(ps))
	}
	m, ok := ps[0].(*wire.Meta)
	if !ok {
		t.Fatalf("first packet is %T, want META", ps[0])
	}
	if d, ok := ps[1].(*wire.Data); !ok || d.Offset != 0 {
		t.Fatalf("second packet is %+v, want packet 0", ps[1])
	}
	if ct, _ := m.Get("content-type"); !strings.HasPrefix(ct, "text/css") {
		t.Errorf("content-type = %q", ct)
	}
	if etag, _ := m.Get("etag"); len(etag) != 18 || etag[0] != '"' {
		t.Errorf("etag = %q, want a quoted 16-hex-digit validator", etag)
	}
	if n := h.m.MetaPackets.Load(); n != 1 {
		t.Errorf("MetaPackets = %d, want 1", n)
	}
}

func TestMetaContentTypes(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR")
	assets := MapAssets{"app.js": []byte("1"), "a.css": []byte("b{}"), "p.png": png, "d.json": []byte("{}"),
		"noext": png, "blob.bin": []byte{0, 1, 2}}
	want := map[string]string{"app.js": "text/javascript", "a.css": "text/css", "p.png": "image/png",
		"d.json": "application/json", "noext": "image/png", "blob.bin": "application/octet-stream"}
	h := start(t, assets, nil)
	ids := map[wire.RPCID]string{}
	i := wire.RPCID(1)
	for name := range assets {
		ids[i] = name
		h.send(&wire.Req{RPCID: i, InitialGrant: 100, AssetID: name})
		i++
	}
	got := metas(h.drain(quiet))
	if len(got) != len(assets) {
		t.Fatalf("%d META packets for %d assets", len(got), len(assets))
	}
	for _, m := range got {
		name := ids[m.RPCID]
		if ct, _ := m.Get("content-type"); !strings.HasPrefix(ct, want[name]) {
			t.Errorf("%s: content-type %q, want %s", name, ct, want[name])
		}
	}
}

func TestRepeatedReqResendsMetaThenPacket0(t *testing.T) {
	h := start(t, MapAssets{"a.json": asset(5000)}, nil)
	h.send(&wire.Req{RPCID: 4, InitialGrant: 0, AssetID: "a.json"})
	h.drain(quiet)
	h.send(&wire.Req{RPCID: 4, InitialGrant: 0, AssetID: "a.json"})
	ps := h.drain(quiet)
	if len(ps) != 2 {
		t.Fatalf("got %+v, want META then packet 0", ps)
	}
	if _, ok := ps[0].(*wire.Meta); !ok {
		t.Fatalf("first is %T, want META", ps[0])
	}
	if d, ok := ps[1].(*wire.Data); !ok || d.Offset != 0 || len(d.Payload) != 0 {
		t.Fatalf("second is %+v, want empty packet 0", ps[1])
	}
	if n := h.m.MetaPackets.Load(); n != 2 {
		t.Errorf("MetaPackets = %d, want 2", n)
	}
}

// A dropped META is recovered the way a lost packet 0 is: the client repeats
// its REQ. META never needs a grant, so none of this touches the G2 counter
// (checked in the harness cleanup).
func TestDroppedMetaRecoveredByRepeatedReq(t *testing.T) {
	newDropper, err := ParseDropSpec("meta")
	if err != nil {
		t.Fatal(err)
	}
	h := start(t, MapAssets{"a.png": asset(2000)}, func(c *Config) { c.NewDropper = newDropper })
	h.send(&wire.Req{RPCID: 1, InitialGrant: 2000, AssetID: "a.png"})
	if ms := metas(h.drain(quiet)); len(ms) != 0 {
		t.Fatalf("first META should have been dropped, got %d", len(ms))
	}
	h.send(&wire.Req{RPCID: 1, InitialGrant: 2000, AssetID: "a.png"})
	if ms := metas(h.drain(quiet)); len(ms) != 1 {
		t.Fatalf("repeated REQ gave %d META packets, want 1", len(ms))
	}
	if h.m.DroppedMeta.Load() != 1 || h.m.DroppedData.Load() != 0 {
		t.Errorf("drops: meta %d, data %d; want 1, 0", h.m.DroppedMeta.Load(), h.m.DroppedData.Load())
	}
}

func TestMetaDropsOptionalFieldsToFit(t *testing.T) {
	a := NewAsset("x.css", []byte("x"), time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC))
	a.CacheControl = "max-age=" + strings.Repeat("9", 600) // too long to fit
	m := a.Meta(1)
	names := []string{}
	for _, f := range m.Fields {
		names = append(names, f.Name)
	}
	if strings.Join(names, ",") != "content-type,etag,last-modified" {
		t.Errorf("fields %v, want cache-control dropped", names)
	}
	if lm, _ := m.Get("last-modified"); lm != "Tue, 22 Sep 2026 12:00:00 GMT" {
		t.Errorf("last-modified = %q", lm)
	}
	b, err := wire.Marshal(m)
	if err != nil || len(b) > MaxMetaLen {
		t.Errorf("META is %d bytes (err %v), limit %d", len(b), err, MaxMetaLen)
	}

	a.ContentType = "text/plain\n" // not a valid META value
	a.CacheControl = ""
	if _, ok := a.Meta(1).Get("content-type"); ok {
		t.Error("an invalid content-type must be dropped, not sent")
	}
}
