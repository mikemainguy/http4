package sender

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"sync"
)

var (
	ErrNotFound = errors.New("asset not found")
	ErrTooLarge = errors.New("asset larger than the u32 size field allows")
)

// Assets resolves an asset ID from a REQ to its bytes.
type Assets interface {
	Get(id string) ([]byte, error)
}

// DirAssets serves files under one directory, caching each after its first
// read. It uses os.Root, so an asset ID can never escape the directory
// (no "..", no absolute paths, no symlinks out).
type DirAssets struct {
	root  *os.Root
	mu    sync.Mutex
	cache map[string][]byte
}

func OpenDir(dir string) (*DirAssets, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &DirAssets{root: root, cache: make(map[string][]byte)}, nil
}

func (d *DirAssets) Get(id string) ([]byte, error) {
	d.mu.Lock()
	b, ok := d.cache[id]
	d.mu.Unlock()
	if ok {
		return b, nil
	}
	b, err := d.root.ReadFile(id)
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
	d.mu.Lock()
	d.cache[id] = b
	d.mu.Unlock()
	return b, nil
}

func (d *DirAssets) Close() error { return d.root.Close() }

// MapAssets is an in-memory Assets, for tests.
type MapAssets map[string][]byte

func (m MapAssets) Get(id string) ([]byte, error) {
	if b, ok := m[id]; ok {
		return b, nil
	}
	return nil, ErrNotFound
}
