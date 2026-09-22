// Package wire encodes and decodes HTTP4 datagrams as specified in
// docs/wire-format.md. It only checks structure; protocol state (grants,
// which RPCs exist) lives in the sender.
package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
	"unicode/utf8"
)

type Type uint8

const (
	TypeReq    Type = 0x01
	TypeData   Type = 0x02
	TypeGrant  Type = 0x03
	TypeResend Type = 0x04
	TypeError  Type = 0x05
	TypeMeta   Type = 0x06
)

func (t Type) String() string {
	switch t {
	case TypeReq:
		return "REQ"
	case TypeData:
		return "DATA"
	case TypeGrant:
		return "GRANT"
	case TypeResend:
		return "RESEND"
	case TypeError:
		return "ERROR"
	case TypeMeta:
		return "META"
	}
	return fmt.Sprintf("Type(0x%02x)", uint8(t))
}

type ErrorCode uint8

const (
	CodeNotFound   ErrorCode = 0x01
	CodeBadRequest ErrorCode = 0x02
	CodeUnknownRPC ErrorCode = 0x03
)

const (
	HeaderLen     = 9             // type + rpc_id
	DataHeaderLen = HeaderLen + 8 // + total_size + offset
	reqFixedLen   = HeaderLen + 6 // + initial_grant + id_len
	grantLen      = HeaderLen + 5
	resendLen     = HeaderLen + 8
	errorLen      = HeaderLen + 1
	metaFixedLen  = HeaderLen + 1 // + count
)

// MetaNames are the only field names a META packet may carry, in the order
// the server sends them. Bodies are always raw bytes, so there is no
// content-encoding.
var MetaNames = []string{"content-type", "etag", "last-modified", "cache-control"}

// MaxPayload is the most asset bytes one DATA packet can carry in a datagram
// of maxDatagramSize bytes.
func MaxPayload(maxDatagramSize int) int {
	return max(0, maxDatagramSize-DataHeaderLen)
}

// RPCID correlates every packet of one request/response.
type RPCID uint64

type Packet interface {
	Type() Type
	RPC() RPCID
}

type Req struct {
	RPCID        RPCID
	InitialGrant uint32 // server may send [0, InitialGrant) before any GRANT
	AssetID      string
}

type Data struct {
	RPCID     RPCID
	TotalSize uint32
	Offset    uint32
	Payload   []byte // aliases the decoded buffer
}

type Grant struct {
	RPCID     RPCID
	MaxOffset uint32 // server may send [0, MaxOffset)
	Priority  uint8  // 0 = most urgent
}

type Resend struct {
	RPCID      RPCID
	Start, End uint32 // missing range [Start, End)
}

type Error struct {
	RPCID RPCID
	Code  ErrorCode
}

// Meta carries an RPC's response metadata. Fields keep their wire order.
type Meta struct {
	RPCID  RPCID
	Fields []Field
}

type Field struct {
	Name, Value string
}

// Get returns the value of the named field.
func (p *Meta) Get(name string) (string, bool) {
	for _, f := range p.Fields {
		if f.Name == name {
			return f.Value, true
		}
	}
	return "", false
}

func (p *Req) Type() Type    { return TypeReq }
func (p *Data) Type() Type   { return TypeData }
func (p *Grant) Type() Type  { return TypeGrant }
func (p *Resend) Type() Type { return TypeResend }
func (p *Error) Type() Type  { return TypeError }
func (p *Meta) Type() Type   { return TypeMeta }
func (p *Req) RPC() RPCID    { return p.RPCID }
func (p *Data) RPC() RPCID   { return p.RPCID }
func (p *Grant) RPC() RPCID  { return p.RPCID }
func (p *Resend) RPC() RPCID { return p.RPCID }
func (p *Error) RPC() RPCID  { return p.RPCID }
func (p *Meta) RPC() RPCID   { return p.RPCID }

// ErrMalformed is wrapped by every decode and encode rejection.
var ErrMalformed = errors.New("wire: malformed packet")

func malformed(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrMalformed, fmt.Sprintf(format, args...))
}

// Decode parses one datagram. A DATA packet's Payload aliases b.
func Decode(b []byte) (Packet, error) {
	if len(b) < HeaderLen {
		return nil, malformed("%d bytes, shorter than the header", len(b))
	}
	t := Type(b[0])
	id := RPCID(binary.BigEndian.Uint64(b[1:9]))
	switch t {
	case TypeReq:
		if len(b) < reqFixedLen {
			return nil, malformed("REQ is %d bytes, need at least %d", len(b), reqFixedLen)
		}
		n := int(binary.BigEndian.Uint16(b[13:15]))
		if n == 0 {
			return nil, malformed("REQ with empty asset_id")
		}
		if len(b) != reqFixedLen+n {
			return nil, malformed("REQ is %d bytes, id_len says %d", len(b), reqFixedLen+n)
		}
		assetID := b[15:]
		if !utf8.Valid(assetID) {
			return nil, malformed("REQ asset_id is not UTF-8")
		}
		return &Req{RPCID: id, InitialGrant: binary.BigEndian.Uint32(b[9:13]), AssetID: string(assetID)}, nil

	case TypeData:
		if len(b) < DataHeaderLen {
			return nil, malformed("DATA is %d bytes, need at least %d", len(b), DataHeaderLen)
		}
		p := &Data{
			RPCID:     id,
			TotalSize: binary.BigEndian.Uint32(b[9:13]),
			Offset:    binary.BigEndian.Uint32(b[13:17]),
			Payload:   b[17:],
		}
		if err := p.checkBounds(); err != nil {
			return nil, err
		}
		return p, nil

	case TypeGrant:
		if len(b) != grantLen {
			return nil, malformed("GRANT is %d bytes, want %d", len(b), grantLen)
		}
		return &Grant{RPCID: id, MaxOffset: binary.BigEndian.Uint32(b[9:13]), Priority: b[13]}, nil

	case TypeResend:
		if len(b) != resendLen {
			return nil, malformed("RESEND is %d bytes, want %d", len(b), resendLen)
		}
		p := &Resend{RPCID: id, Start: binary.BigEndian.Uint32(b[9:13]), End: binary.BigEndian.Uint32(b[13:17])}
		if p.Start >= p.End {
			return nil, malformed("RESEND range [%d, %d) is empty", p.Start, p.End)
		}
		return p, nil

	case TypeError:
		if len(b) != errorLen {
			return nil, malformed("ERROR is %d bytes, want %d", len(b), errorLen)
		}
		return &Error{RPCID: id, Code: ErrorCode(b[9])}, nil

	case TypeMeta:
		if len(b) < metaFixedLen {
			return nil, malformed("META is %d bytes, need at least %d", len(b), metaFixedLen)
		}
		p := &Meta{RPCID: id, Fields: []Field{}}
		rest := b[metaFixedLen:]
		for range int(b[9]) {
			if len(rest) < 1 {
				return nil, malformed("META truncated before field %d", len(p.Fields))
			}
			n := int(rest[0])
			if len(rest) < 1+n+2 {
				return nil, malformed("META field %d truncated", len(p.Fields))
			}
			name := string(rest[1 : 1+n])
			m := int(binary.BigEndian.Uint16(rest[1+n : 3+n]))
			rest = rest[3+n:]
			if len(rest) < m {
				return nil, malformed("META value of %q truncated", name)
			}
			p.Fields = append(p.Fields, Field{Name: name, Value: string(rest[:m])})
			rest = rest[m:]
		}
		if len(rest) != 0 {
			return nil, malformed("META has %d trailing bytes", len(rest))
		}
		if err := p.check(); err != nil {
			return nil, err
		}
		return p, nil
	}
	return nil, malformed("unknown type 0x%02x", uint8(t))
}

func (p *Data) checkBounds() error {
	// Sum in 64 bits so offset + len can't wrap past u32.
	if uint64(p.Offset)+uint64(len(p.Payload)) > uint64(p.TotalSize) {
		return malformed("DATA [%d, %d) runs past total_size %d", p.Offset, uint64(p.Offset)+uint64(len(p.Payload)), p.TotalSize)
	}
	return nil
}

// check enforces the per-field rules shared by Decode and Append.
func (p *Meta) check() error {
	if len(p.Fields) > len(MetaNames) {
		return malformed("META has %d fields, at most %d allowed", len(p.Fields), len(MetaNames))
	}
	for i, f := range p.Fields {
		if !slices.Contains(MetaNames, f.Name) {
			return malformed("META field name %q not allowed", f.Name)
		}
		for _, g := range p.Fields[:i] {
			if g.Name == f.Name {
				return malformed("META field %q repeated", f.Name)
			}
		}
		if !validMetaValue(f.Value) {
			return malformed("META value of %q must be 1..%d printable ASCII bytes without surrounding spaces", f.Name, maxMetaValue)
		}
	}
	return nil
}

const maxMetaValue = 0xffff

// validMetaValue accepts non-empty printable ASCII (0x20-0x7e) with no
// leading or trailing space: the safe subset of an HTTP field value.
func validMetaValue(v string) bool {
	if len(v) == 0 || len(v) > maxMetaValue || v[0] == ' ' || v[len(v)-1] == ' ' {
		return false
	}
	for i := 0; i < len(v); i++ {
		if v[i] < 0x20 || v[i] > 0x7e {
			return false
		}
	}
	return true
}

// Append encodes p onto dst. It refuses any packet Decode would reject, so
// only well-formed datagrams are ever sent.
func Append(dst []byte, p Packet) ([]byte, error) {
	dst = append(dst, byte(p.Type()))
	dst = binary.BigEndian.AppendUint64(dst, uint64(p.RPC()))
	switch p := p.(type) {
	case *Req:
		n := len(p.AssetID)
		if n == 0 || n > 0xffff {
			return nil, malformed("REQ asset_id length %d outside 1..65535", n)
		}
		if !utf8.ValidString(p.AssetID) {
			return nil, malformed("REQ asset_id is not UTF-8")
		}
		dst = binary.BigEndian.AppendUint32(dst, p.InitialGrant)
		dst = binary.BigEndian.AppendUint16(dst, uint16(n))
		return append(dst, p.AssetID...), nil
	case *Data:
		if err := p.checkBounds(); err != nil {
			return nil, err
		}
		dst = binary.BigEndian.AppendUint32(dst, p.TotalSize)
		dst = binary.BigEndian.AppendUint32(dst, p.Offset)
		return append(dst, p.Payload...), nil
	case *Grant:
		dst = binary.BigEndian.AppendUint32(dst, p.MaxOffset)
		return append(dst, p.Priority), nil
	case *Resend:
		if p.Start >= p.End {
			return nil, malformed("RESEND range [%d, %d) is empty", p.Start, p.End)
		}
		dst = binary.BigEndian.AppendUint32(dst, p.Start)
		return binary.BigEndian.AppendUint32(dst, p.End), nil
	case *Error:
		return append(dst, byte(p.Code)), nil
	case *Meta:
		if err := p.check(); err != nil {
			return nil, err
		}
		dst = append(dst, byte(len(p.Fields)))
		for _, f := range p.Fields {
			dst = append(dst, byte(len(f.Name)))
			dst = append(dst, f.Name...)
			dst = binary.BigEndian.AppendUint16(dst, uint16(len(f.Value)))
			dst = append(dst, f.Value...)
		}
		return dst, nil
	}
	return nil, fmt.Errorf("wire: cannot encode %T", p)
}

// Marshal encodes p into a new buffer.
func Marshal(p Packet) ([]byte, error) {
	return Append(nil, p)
}
