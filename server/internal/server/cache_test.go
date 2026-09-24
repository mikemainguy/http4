package server

import (
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"testing"
	"time"
)

func entry(bodyBytes int, ttl time.Duration, now time.Time) *CacheEntry {
	return &CacheEntry{Body: make([]byte, bodyBytes), Expires: now.Add(ttl)}
}

const hour = time.Hour

func TestCacheHoldsWithinItsBound(t *testing.T) {
	m := new(CacheMetrics)
	c := newResponseCache(1, m) // 1 MB
	now := time.Now()

	// Offer several times the budget.
	for i := 0; i < 40; i++ {
		c.put(fmt.Sprintf("k%d", i), entry(100<<10, hour, now), now) // 100 KiB each
	}
	bytes, entries, capacity := c.stats()
	if bytes > capacity {
		t.Fatalf("holding %d bytes against a %d byte bound", bytes, capacity)
	}
	if entries == 0 {
		t.Fatal("bounded to nothing: the cache holds no entries at all")
	}
	if m.Evictions == 0 {
		t.Error("no evictions recorded despite exceeding the bound")
	}
}

func TestCacheEvictsLeastRecentlyUsed(t *testing.T) {
	m := new(CacheMetrics)
	// Room for exactly three entries.
	c := newResponseCache(3, m)
	now := time.Now()
	one := 1 << 20

	c.put("a", entry(one, hour, now), now)
	c.put("b", entry(one, hour, now), now)
	c.put("c", entry(one, hour, now), now)
	// Touch a, so b becomes the least recently used.
	if _, ok := c.get("a", now); !ok {
		t.Fatal("a should still be cached")
	}
	c.put("d", entry(one, hour, now), now)

	if _, ok := c.get("b", now); ok {
		t.Error("b was least recently used and should have been evicted")
	}
	for _, k := range []string{"a", "c", "d"} {
		if _, ok := c.get(k, now); !ok {
			t.Errorf("%s should still be cached", k)
		}
	}
}

// An expired entry is dead weight. Reclaiming it must be preferred to evicting
// something still live and useful.
func TestCacheDropsExpiredBeforeEvictingLive(t *testing.T) {
	m := new(CacheMetrics)
	c := newResponseCache(3, m)
	now := time.Now()
	one := 1 << 20

	c.put("stale", entry(one, time.Minute, now), now)
	c.put("live1", entry(one, hour, now), now)
	c.put("live2", entry(one, hour, now), now)

	later := now.Add(2 * time.Minute) // stale has expired, the others have not
	c.put("new", entry(one, hour, later), later)

	if _, ok := c.get("stale", later); ok {
		t.Error("the expired entry should have been reclaimed")
	}
	for _, k := range []string{"live1", "live2", "new"} {
		if _, ok := c.get(k, later); !ok {
			t.Errorf("%s was live and should not have been evicted", k)
		}
	}
	if m.Evictions != 0 {
		t.Errorf("evicted %d live entries when reclaiming an expired one would do", m.Evictions)
	}
	if m.Expired == 0 {
		t.Error("no expiry recorded")
	}
}

func TestCacheNeverServesAnExpiredEntry(t *testing.T) {
	m := new(CacheMetrics)
	c := newResponseCache(4, m)
	now := time.Now()
	c.put("k", entry(1024, time.Minute, now), now)

	if _, ok := c.get("k", now.Add(30*time.Second)); !ok {
		t.Fatal("still live at 30s")
	}
	if _, ok := c.get("k", now.Add(time.Minute)); ok {
		t.Error("served an entry at exactly its expiry; it must be treated as stale")
	}
	if b, n, _ := c.stats(); n != 0 || b != 0 {
		t.Errorf("expired entry left behind: %d entries, %d bytes", n, b)
	}
}

// Evicting a working cache to make room for one oversized response is worse
// than refusing the response.
func TestCacheRefusesAnEntryLargerThanTheWholeBudget(t *testing.T) {
	m := new(CacheMetrics)
	c := newResponseCache(1, m)
	now := time.Now()
	c.put("keep", entry(500<<10, hour, now), now)
	c.put("huge", entry(4<<20, hour, now), now)

	if _, ok := c.get("huge", now); ok {
		t.Error("an entry larger than the budget was cached")
	}
	if _, ok := c.get("keep", now); !ok {
		t.Error("the existing entry was evicted to make room for one that could never fit")
	}
	if m.TooLarge != 1 {
		t.Errorf("TooLarge = %d, want 1", m.TooLarge)
	}
}

// Off means off, not "a very small cache".
func TestCacheDisabledStoresNothing(t *testing.T) {
	m := new(CacheMetrics)
	c := newResponseCache(0, m)
	now := time.Now()
	c.put("k", entry(10, hour, now), now)
	if _, ok := c.get("k", now); ok {
		t.Error("stored an entry with -cache-mb 0")
	}
	if b, n, capacity := c.stats(); b != 0 || n != 0 || capacity != 0 {
		t.Errorf("disabled cache reports %d bytes, %d entries, %d capacity", b, n, capacity)
	}
	if m.Stores != 0 {
		t.Errorf("Stores = %d with caching off", m.Stores)
	}
}

// Replacing a key must not double-count its bytes, which would silently shrink
// the usable cache every time an entry was refreshed.
func TestCacheReplacingAKeyAccountsOnce(t *testing.T) {
	m := new(CacheMetrics)
	c := newResponseCache(2, m)
	now := time.Now()
	c.put("k", entry(1<<20, hour, now), now)
	c.put("k", entry(1<<20, hour, now), now)
	bytes, entries, _ := c.stats()
	if entries != 1 {
		t.Errorf("entries = %d after replacing one key, want 1", entries)
	}
	if bytes != 1<<20 {
		t.Errorf("bytes = %d after replacing a 1 MiB entry with another, want %d", bytes, 1<<20)
	}
}

func TestCacheAccountsHeadersNotJustBodies(t *testing.T) {
	now := time.Now()
	e := &CacheEntry{Body: make([]byte, 100), ContentType: "text/javascript", CacheControl: "public, max-age=31536000, immutable", ETag: `"abc"`, Expires: now.Add(hour)}
	want := int64(100 + len("text/javascript") + len("public, max-age=31536000, immutable") + len(`"abc"`))
	if got := e.size(); got != want {
		t.Errorf("size = %d, want %d: the bound should reflect what is actually held", got, want)
	}
}

// The "cache is full" line is printed once. A cache doing its job evicts
// constantly, and a line per eviction teaches an operator to ignore the log.
func TestCacheWarnsOnceWhenFull(t *testing.T) {
	var buf strings.Builder
	restore := swapLogOutput(&buf)
	defer restore()

	c := newResponseCache(1, new(CacheMetrics))
	now := time.Now()
	for i := 0; i < 30; i++ {
		c.put(fmt.Sprintf("k%d", i), entry(200<<10, hour, now), now)
	}
	if n := strings.Count(buf.String(), "response cache full"); n != 1 {
		t.Errorf("logged the full-cache line %d times, want exactly 1:\n%s", n, buf.String())
	}
}

func TestCacheIsSafeUnderConcurrentUse(t *testing.T) {
	c := newResponseCache(2, new(CacheMetrics))
	now := time.Now()
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				k := fmt.Sprintf("k%d", i%50)
				c.put(k, entry(8<<10, hour, now), now)
				c.get(k, now)
				c.stats()
			}
		}(w)
	}
	wg.Wait()
	if bytes, _, capacity := c.stats(); bytes > capacity {
		t.Errorf("bound broken under concurrency: %d bytes against %d", bytes, capacity)
	}
}

// swapLogOutput redirects the standard logger so a test can assert what an
// operator would actually see. Returns a function that puts it back.
func swapLogOutput(w io.Writer) func() {
	prev := log.Writer()
	log.SetOutput(w)
	return func() { log.SetOutput(prev) }
}
