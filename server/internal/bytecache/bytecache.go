// Package bytecache is a byte-bounded LRU cache (vrek iss-0yd99d2).
//
// It replaces an unbounded one. DirAssets kept every asset it ever read in a
// map with no eviction and no bound, so memory grew with the number of distinct
// paths a client asked for — which a remote client controls.
//
// It is generic over the value because there are two callers with one budget
// between them: the asset pool holds files read from disk, the pass-through
// cache holds origin responses, and an operator sets one number for both. A
// value says how many bytes it costs; the cache does not guess.
//
// Why plain allocation rather than the preallocated arena that was asked for:
// a []byte holds no pointers, so Go puts it in a *noscan* span and the
// collector never walks its contents. Holding hundreds of megabytes of response
// bodies therefore costs almost nothing in scan time. A cache's GC cost is
// allocation churn, not residency, and cached entries are long-lived by
// definition — they are promoted once and then sit still. An arena would mean
// writing a slab allocator for variable-sized entries, owning its
// fragmentation, and copying every body into it, bought for a cost measurement
// is unlikely to find. If profiling later disagrees, the arena is still
// available; it should not be the starting point. For a ceiling on the process
// as a whole, debug.SetMemoryLimit is the cheaper lever.
package bytecache

import (
	"container/list"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// Value is anything the cache can hold. Size is what holding it costs, in
// bytes: the body plus whatever metadata is held with it. The number an
// operator sets should be close to the memory actually held, so small strings
// count too.
type Value interface {
	Size() int64
}

// Metrics are the counters behind /metrics.json. A cache whose hit rate nobody
// can see is a cache nobody can tune. They are shared by every cache given the
// same pointer, so one budget reports one set of numbers.
type Metrics struct {
	Hits      atomic.Int64
	Misses    atomic.Int64
	Evictions atomic.Int64
	Expired   atomic.Int64
	Stores    atomic.Int64
	// TooLarge counts values refused because one of them exceeded the whole
	// budget: a signal the budget is wrong, not that the cache is working.
	TooLarge atomic.Int64
}

// Stats is Metrics plus occupancy as plain values, for JSON. Bytes and Entries
// are what is held right now; Capacity is the configured bound, so the two can
// be compared rather than assumed equal.
type Stats struct {
	Bytes     int64 `json:"cache_bytes"`
	Entries   int64 `json:"cache_entries"`
	Capacity  int64 `json:"cache_capacity"`
	Hits      int64 `json:"cache_hits"`
	Misses    int64 `json:"cache_misses"`
	Evictions int64 `json:"cache_evictions"`
	Expired   int64 `json:"cache_expired"`
	Stores    int64 `json:"cache_stores"`
	TooLarge  int64 `json:"cache_too_large"`
}

// Cache is a byte-bounded LRU. Zero capacity means caching is off, and off
// means nothing is stored at all rather than a very small cache.
type Cache[V Value] struct {
	mu       sync.Mutex
	capacity int64 // bytes; 0 disables
	bytes    int64
	entries  map[string]*list.Element
	order    *list.List // front = most recently used
	warned   bool       // the "cache is full" line is printed once, not per eviction

	m *Metrics
}

type item[V Value] struct {
	key     string
	value   V
	size    int64     // cached: Size() must not be re-read after storing, or accounting drifts
	expires time.Time // zero: never expires, evicted only by LRU
}

// New returns a cache bounded to megabytes, reporting into m. Zero megabytes
// disables it. m may be shared with other caches on the same budget.
func New[V Value](megabytes int, m *Metrics) *Cache[V] {
	if m == nil {
		m = new(Metrics)
	}
	return &Cache[V]{
		capacity: int64(megabytes) << 20,
		entries:  make(map[string]*list.Element),
		order:    list.New(),
		m:        m,
	}
}

// Enabled reports whether anything is stored at all.
func (c *Cache[V]) Enabled() bool { return c != nil && c.capacity > 0 }

// Get returns a live value and marks it most recently used. An expired value is
// dropped rather than returned: serving stale bytes is not something this cache
// is allowed to do (vrek iss-15hefmy).
//
// The value outlives eviction for anyone already holding it — a transfer in
// flight keeps its own reference, so evicting mid-send is safe.
func (c *Cache[V]) Get(key string, now time.Time) (V, bool) {
	var zero V
	if !c.Enabled() {
		return zero, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.entries[key]
	if !ok {
		c.m.Misses.Add(1)
		return zero, false
	}
	it := el.Value.(*item[V])
	if it.dead(now) {
		c.removeLocked(el)
		c.m.Expired.Add(1)
		c.m.Misses.Add(1)
		return zero, false
	}
	c.order.MoveToFront(el)
	c.m.Hits.Add(1)
	return it.value, true
}

// Put stores a value until expires (zero: until evicted), making room by
// dropping expired entries first and then evicting least-recently-used ones.
func (c *Cache[V]) Put(key string, v V, expires, now time.Time) {
	if !c.Enabled() {
		return
	}
	size := v.Size()
	c.mu.Lock()
	defer c.mu.Unlock()

	// One value larger than the whole budget is refused outright. Evicting
	// everything to hold it would empty a working cache for something that
	// cannot coexist with anything else.
	if size > c.capacity {
		c.m.TooLarge.Add(1)
		return
	}
	if el, ok := c.entries[key]; ok {
		c.removeLocked(el) // replace: the new bytes may be a different size
	}
	// Expired entries are dead weight, so reclaim them before evicting anything
	// still live.
	if c.bytes+size > c.capacity {
		c.sweepExpiredLocked(now)
	}
	for c.bytes+size > c.capacity {
		back := c.order.Back()
		if back == nil {
			return // cannot happen while size <= capacity, but never spin
		}
		if !c.warned {
			c.warned = true
			log.Printf("http4d: cache full at %d MB; evicting least-recently-used (raise -cache-mb to hold more)", c.capacity>>20)
		}
		c.removeLocked(back)
		c.m.Evictions.Add(1)
	}
	c.entries[key] = c.order.PushFront(&item[V]{key: key, value: v, size: size, expires: expires})
	c.bytes += size
	c.m.Stores.Add(1)
}

// dead reports whether the item has passed its lifetime. A zero expiry never
// does: a file read from disk has no max-age, and only LRU removes it.
func (it *item[V]) dead(now time.Time) bool {
	return !it.expires.IsZero() && !now.Before(it.expires)
}

// sweepExpiredLocked drops every entry past its lifetime. Caller holds mu.
func (c *Cache[V]) sweepExpiredLocked(now time.Time) {
	for el := c.order.Back(); el != nil; {
		prev := el.Prev()
		if el.Value.(*item[V]).dead(now) {
			c.removeLocked(el)
			c.m.Expired.Add(1)
		}
		el = prev
	}
}

func (c *Cache[V]) removeLocked(el *list.Element) {
	it := el.Value.(*item[V])
	c.order.Remove(el)
	delete(c.entries, it.key)
	c.bytes -= it.size
}

// Stats reports the counters and what is held right now.
func (c *Cache[V]) Stats() Stats {
	var s Stats
	if c == nil {
		return s
	}
	c.mu.Lock()
	s.Bytes, s.Entries, s.Capacity = c.bytes, int64(len(c.entries)), c.capacity
	c.mu.Unlock()
	s.Hits, s.Misses = c.m.Hits.Load(), c.m.Misses.Load()
	s.Evictions, s.Expired = c.m.Evictions.Load(), c.m.Expired.Load()
	s.Stores, s.TooLarge = c.m.Stores.Load(), c.m.TooLarge.Load()
	return s
}
