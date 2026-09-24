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
	"time"

	"http4/server/internal/bytecache"
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

// Size is what holding this asset costs, body plus the metadata held with it,
// for the cache's byte budget (bytecache.Value). The strings are small but they
// count: the number an operator sets should be close to the memory held.
func (a *Asset) Size() int64 {
	return int64(len(a.Body) + len(a.ContentType) + len(a.ETag) + len(a.CacheControl))
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
//
// The cache is bounded (vrek iss-0yd99d2). It used to be a map with no eviction
// and no bound, which meant memory grew with the number of distinct paths a
// client asked for — and a remote client chooses those paths. Over the bound,
// the least recently used file is dropped and re-read from disk next time.
type DirAssets struct {
	root  *os.Root
	cache *bytecache.Cache[*Asset]
}

// OpenDir opens dir as an asset pool holding up to cacheMB megabytes of file
// contents in memory, reporting into m (which may be nil, or shared with other
// caches on the same budget). Zero megabytes reads every asset from disk every
// time.
func OpenDir(dir string, cacheMB int, m *bytecache.Metrics) (*DirAssets, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &DirAssets{root: root, cache: bytecache.New[*Asset](cacheMB, m)}, nil
}

func (d *DirAssets) Get(id string) (*Asset, error) {
	// No expiry: a file is evicted by the bound, never by age. Nothing here
	// watches the directory, so a file edited underneath a live server is not
	// noticed — as it was not before the cache became bounded.
	if a, ok := d.cache.Get(id, time.Time{}); ok {
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
	a := NewAsset(id, b, info.ModTime())
	d.cache.Put(id, a, time.Time{}, time.Time{})
	return a, nil
}

// CacheStats reports the asset cache's occupancy and counters. Nil-safe, so a
// half-built server can still answer /metrics.json rather than panicking on it.
func (d *DirAssets) CacheStats() bytecache.Stats {
	if d == nil {
		return bytecache.Stats{}
	}
	return d.cache.Stats()
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
