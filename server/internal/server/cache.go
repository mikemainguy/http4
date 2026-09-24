package server

// A bounded in-memory store for cacheable origin responses (vrek iss-0yd99d2).
//
// It replaces an unbounded one. DirAssets kept every asset it ever read in a
// map with no eviction and no bound, so memory grew with the number of distinct
// paths a client asked for — which a remote client controls.
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

import (
	"container/list"
	"log"
	"net/http"
	"sync"
	"time"
)

// CacheEntry is one stored response: the bytes, the headers worth replaying,
// and when it stops being servable.
type CacheEntry struct {
	Body        []byte
	ContentType string
	// CacheControl is the origin's own header, replayed to the browser so its
	// cache keeps working in front of this one.
	CacheControl string
	ETag         string
	Expires      time.Time
}

// size is what this entry costs, body plus the headers held with it. The
// number an operator sets should be close to the memory actually held, so the
// strings count even though they are small.
func (e *CacheEntry) size() int64 {
	return int64(len(e.Body) + len(e.ContentType) + len(e.CacheControl) + len(e.ETag))
}

// responseCache is a byte-bounded LRU. Zero capacity means caching is off, and
// off means nothing is stored at all rather than a very small cache.
type responseCache struct {
	mu       sync.Mutex
	capacity int64 // bytes; 0 disables
	bytes    int64
	entries  map[string]*list.Element
	order    *list.List // front = most recently used
	warned   bool       // the "cache is full" line is printed once, not per eviction

	m *CacheMetrics
}

type cacheItem struct {
	key   string
	entry *CacheEntry
}

// CacheMetrics are reported in /metrics.json. A cache whose hit rate nobody can
// see is a cache nobody can tune.
type CacheMetrics struct {
	Hits      int64
	Misses    int64
	Evictions int64
	Expired   int64
	Stores    int64
	// TooLarge counts responses refused because one entry exceeded the whole
	// budget: a signal the budget is wrong, not that the cache is working.
	TooLarge int64
}

func newResponseCache(megabytes int, m *CacheMetrics) *responseCache {
	return &responseCache{
		capacity: int64(megabytes) << 20,
		entries:  make(map[string]*list.Element),
		order:    list.New(),
		m:        m,
	}
}

func (c *responseCache) enabled() bool { return c != nil && c.capacity > 0 }

// get returns a live entry and marks it most recently used. An expired entry is
// dropped rather than returned: serving stale bytes is not something this cache
// is allowed to do (vrek iss-15hefmy).
func (c *responseCache) get(key string, now time.Time) (*CacheEntry, bool) {
	if !c.enabled() {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.entries[key]
	if !ok {
		c.m.Misses++
		return nil, false
	}
	it := el.Value.(*cacheItem)
	if !now.Before(it.entry.Expires) {
		c.removeLocked(el)
		c.m.Expired++
		c.m.Misses++
		return nil, false
	}
	c.order.MoveToFront(el)
	c.m.Hits++
	return it.entry, true
}

// put stores an entry, making room by dropping expired entries first and then
// evicting least-recently-used ones.
func (c *responseCache) put(key string, e *CacheEntry, now time.Time) {
	if !c.enabled() {
		return
	}
	size := e.size()
	c.mu.Lock()
	defer c.mu.Unlock()

	// One entry larger than the whole budget is refused outright. Evicting
	// everything to hold it would empty a working cache for something that
	// cannot coexist with anything else.
	if size > c.capacity {
		c.m.TooLarge++
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
			log.Printf("http4d: response cache full at %d MB; evicting least-recently-used (raise -cache-mb to hold more)", c.capacity>>20)
		}
		c.removeLocked(back)
		c.m.Evictions++
	}
	c.entries[key] = c.order.PushFront(&cacheItem{key: key, entry: e})
	c.bytes += size
	c.m.Stores++
}

// sweepExpiredLocked drops every entry past its lifetime. Caller holds mu.
func (c *responseCache) sweepExpiredLocked(now time.Time) {
	for el := c.order.Back(); el != nil; {
		prev := el.Prev()
		if !now.Before(el.Value.(*cacheItem).entry.Expires) {
			c.removeLocked(el)
			c.m.Expired++
		}
		el = prev
	}
}

func (c *responseCache) removeLocked(el *list.Element) {
	it := el.Value.(*cacheItem)
	c.order.Remove(el)
	delete(c.entries, it.key)
	c.bytes -= it.entry.size()
}

// stats reports what is held, so the configured bound and the reality can be
// compared rather than assumed equal.
func (c *responseCache) stats() (bytes int64, entries int, capacity int64) {
	if c == nil {
		return 0, 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bytes, len(c.entries), c.capacity
}

// entryFrom builds a cache entry from an origin response's headers. The body is
// supplied separately, because it is read while being streamed to the client.
func entryFrom(h http.Header, body []byte, maxAge time.Duration, now time.Time) *CacheEntry {
	return &CacheEntry{
		Body:         body,
		ContentType:  h.Get("Content-Type"),
		CacheControl: h.Get("Cache-Control"),
		ETag:         h.Get("ETag"),
		Expires:      now.Add(maxAge),
	}
}
