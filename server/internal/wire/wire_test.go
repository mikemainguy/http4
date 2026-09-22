package wire

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strconv"
	"testing"
)

// vectors mirrors testdata/wire/vectors.json, shared with the TypeScript codec.
type vectors struct {
	Valid []struct {
		Name   string         `json:"name"`
		Hex    string         `json:"hex"`
		Packet map[string]any `json:"packet"`
	} `json:"valid"`
	Invalid []struct {
		Name string `json:"name"`
		Hex  string `json:"hex"`
	} `json:"invalid"`
}

func loadVectors(t testing.TB) vectors {
	t.Helper()
	raw, err := os.ReadFile("../../../testdata/wire/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func mustHex(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// packetFromJSON builds the expected packet from a vector's JSON description.
func packetFromJSON(t *testing.T, m map[string]any) Packet {
	t.Helper()
	id, err := strconv.ParseUint(m["rpcId"].(string), 16, 64)
	if err != nil {
		t.Fatal(err)
	}
	rpc := RPCID(id)
	u32 := func(k string) uint32 { return uint32(m[k].(float64)) }
	switch m["type"] {
	case "REQ":
		return &Req{RPCID: rpc, InitialGrant: u32("initialGrant"), AssetID: m["assetId"].(string)}
	case "DATA":
		return &Data{RPCID: rpc, TotalSize: u32("totalSize"), Offset: u32("offset"), Payload: mustHex(t, m["payload"].(string))}
	case "GRANT":
		return &Grant{RPCID: rpc, MaxOffset: u32("maxOffset"), Priority: uint8(u32("priority"))}
	case "RESEND":
		return &Resend{RPCID: rpc, Start: u32("start"), End: u32("end")}
	case "ERROR":
		return &Error{RPCID: rpc, Code: ErrorCode(u32("code"))}
	case "META":
		fields := []Field{}
		for _, f := range m["fields"].([]any) {
			kv := f.([]any)
			fields = append(fields, Field{Name: kv[0].(string), Value: kv[1].(string)})
		}
		return &Meta{RPCID: rpc, Fields: fields}
	case "HELLO":
		return &Hello{RPCID: rpc, Caps: u32("caps")}
	case "DATA_SEQ":
		d := Data{RPCID: rpc, TotalSize: u32("totalSize"), Offset: u32("offset"), Payload: mustHex(t, m["payload"].(string))}
		return &DataSeq{Data: d, Seq: u32("seq")}
	case "RESEND_SEQ":
		return &ResendSeq{RPCID: rpc, Start: u32("start"), End: u32("end")}
	}
	t.Fatalf("unknown vector type %v", m["type"])
	return nil
}

func TestVectorsValid(t *testing.T) {
	for _, v := range loadVectors(t).Valid {
		t.Run(v.Name, func(t *testing.T) {
			want := packetFromJSON(t, v.Packet)
			got, err := Decode(mustHex(t, v.Hex))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("decode = %+v, want %+v", got, want)
			}
			enc, err := Marshal(want)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			if h := hex.EncodeToString(enc); h != v.Hex {
				t.Errorf("encode = %s, want %s", h, v.Hex)
			}
		})
	}
}

func TestVectorsInvalid(t *testing.T) {
	for _, v := range loadVectors(t).Invalid {
		t.Run(v.Name, func(t *testing.T) {
			p, err := Decode(mustHex(t, v.Hex))
			if !errors.Is(err, ErrMalformed) {
				t.Errorf("decode = %+v, %v; want ErrMalformed", p, err)
			}
		})
	}
}

func TestEncodeRejectsWhatDecodeRejects(t *testing.T) {
	for name, p := range map[string]Packet{
		"empty asset id":      &Req{AssetID: ""},
		"asset id > 65535":    &Req{AssetID: string(make([]byte, 0x10000))},
		"non-UTF-8 id":        &Req{AssetID: "\xff"},
		"data past total":     &Data{TotalSize: 2, Offset: 1, Payload: []byte{1, 2}},
		"empty resend":        &Resend{Start: 5, End: 5},
		"meta bad name":       &Meta{Fields: []Field{{"server", "go"}}},
		"meta duplicate":      &Meta{Fields: []Field{{"etag", `"a"`}, {"etag", `"b"`}}},
		"meta empty value":    &Meta{Fields: []Field{{"etag", ""}}},
		"meta non-ASCII":      &Meta{Fields: []Field{{"content-type", "é"}}},
		"data_seq past total": &DataSeq{Data: Data{TotalSize: 2, Offset: 1, Payload: []byte{1, 2}}, Seq: 7},
		"empty resend_seq":    &ResendSeq{Start: 9, End: 9},
	} {
		if _, err := Marshal(p); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: err = %v, want ErrMalformed", name, err)
		}
	}
}

func TestMaxPayload(t *testing.T) {
	if got := MaxPayload(1024); got != 1007 {
		t.Errorf("MaxPayload(1024) = %d, want 1007", got)
	}
	if got := MaxPayload(10); got != 0 {
		t.Errorf("MaxPayload(10) = %d, want 0", got)
	}
}

// FuzzDecode: Decode never panics, and anything it accepts re-encodes to the
// identical bytes, so there is exactly one encoding per packet.
func FuzzDecode(f *testing.F) {
	v := loadVectors(f)
	for _, x := range v.Valid {
		f.Add(mustHex(f, x.Hex))
	}
	for _, x := range v.Invalid {
		f.Add(mustHex(f, x.Hex))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		p, err := Decode(b)
		if err != nil {
			return
		}
		enc, err := Marshal(p)
		if err != nil {
			t.Fatalf("decoded %+v but cannot re-encode: %v", p, err)
		}
		if !bytes.Equal(enc, b) {
			t.Fatalf("re-encode differs:\n in  %x\n out %x", b, enc)
		}
	})
}
