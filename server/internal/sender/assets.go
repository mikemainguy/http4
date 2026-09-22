package sender

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"mime"
	"net/http"
	"os"
	"path"
	"sync"
	"time"

	"http4/server/internal/wire"
)

var (
	ErrNotFound = errors.New("asset not found")
	ErrTooLarge = errors.New("asset larger than the u32 size field allows")
)

// Assets resolves an asset ID from a REQ to its bytes and metadata.
type Assets interface {
	Get(id string) (*Asset, error)
}

// Asset is a response body plus the metadata sent ahead of it in META.
type Asset struct {
	Body         []byte
	ContentType  string
	ETag         string    // quoted strong validator
	ModTime      time.Time // zero: no last-modified
	CacheControl string    // empty: none sent
}

// NewAsset derives an asset's metadata. Content-Type comes from the name's
// extension, falling back to sniffing the body. The ETag is a truncated
// SHA-256 of the body, so it changes exactly when the bytes do.
func NewAsset(name string, body []byte, modTime time.Time) *Asset {
	ct := mime.TypeByExtension(path.Ext(name))
	if ct == "" {
		ct = http.DetectContentType(body)
	}
	sum := sha256.Sum256(body)
	return &Asset{
		Body:        body,
		ContentType: ct,
		ETag:        `"` + hex.EncodeToString(sum[:8]) + `"`,
		ModTime:     modTime,
	}
}

// MaxMetaLen bounds a META datagram. It stays well under the smallest
// datagram size seen (1024 bytes from Chrome) so META never needs splitting.
const MaxMetaLen = 512

// Meta builds the META packet for this asset. Fields are dropped from the
// least important end (cache-control, last-modified, etag) if one is not a
// valid META value or the packet would exceed MaxMetaLen; content-type goes last.
func (a *Asset) Meta(id wire.RPCID) *wire.Meta {
	fields := []wire.Field{{Name: "content-type", Value: a.ContentType}, {Name: "etag", Value: a.ETag}}
	if !a.ModTime.IsZero() {
		fields = append(fields, wire.Field{Name: "last-modified", Value: a.ModTime.UTC().Format(http.TimeFormat)})
	}
	if a.CacheControl != "" {
		fields = append(fields, wire.Field{Name: "cache-control", Value: a.CacheControl})
	}
	for {
		m := &wire.Meta{RPCID: id, Fields: fields}
		if b, err := wire.Marshal(m); err == nil && len(b) <= MaxMetaLen {
			return m
		}
		fields = fields[:len(fields)-1]
	}
}

// DirAssets serves files under one directory, caching each after its first
// read. It uses os.Root, so an asset ID can never escape the directory
// (no "..", no absolute paths, no symlinks out).
type DirAssets struct {
	root  *os.Root
	mu    sync.Mutex
	cache map[string]*Asset
}

func OpenDir(dir string) (*DirAssets, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &DirAssets{root: root, cache: make(map[string]*Asset)}, nil
}

func (d *DirAssets) Get(id string) (*Asset, error) {
	d.mu.Lock()
	a, ok := d.cache[id]
	d.mu.Unlock()
	if ok {
		return a, nil
	}
	b, err := d.root.ReadFile(id)
	var info fs.FileInfo
	if err == nil {
		info, err = d.root.Stat(id)
	}
	if err != nil {
		// Anything that isn't a readable file inside the root is "not found":
		// the client doesn't learn why.
		// That includes paths os.Root refuses because they escape it.
		var pe *fs.PathError
		if errors.As(err, &pe) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if len(b) > math.MaxUint32 {
		return nil, fmt.Errorf("%w: %s is %d bytes", ErrTooLarge, id, len(b))
	}
	a = NewAsset(id, b, info.ModTime())
	d.mu.Lock()
	d.cache[id] = a
	d.mu.Unlock()
	return a, nil
}

func (d *DirAssets) Close() error { return d.root.Close() }

// MapAssets is an in-memory Assets, for tests. Metadata is derived from the
// name and bytes; there is no modification time.
type MapAssets map[string][]byte

func (m MapAssets) Get(id string) (*Asset, error) {
	if b, ok := m[id]; ok {
		return NewAsset(id, b, time.Time{}), nil
	}
	return nil, ErrNotFound
}
