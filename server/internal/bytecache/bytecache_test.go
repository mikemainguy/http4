package bytecache

import (
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"testing"
	"time"
)

// blob is a value of a known size, so a test can reason in exact bytes.
type blob struct{ n int64 }

func (b blob) Size() int64 { return b.n }

const hour = time.Hour

func TestHoldsWithinItsBound(t *testing.T) {
	m := new(Metrics)
	c := New[blob](1, m) // 1 MB
	now := time.Now()

	// Offer several times the budget.
	for i := 0; i < 40; i++ {
		c.Put(fmt.Sprintf("k%d", i), blob{100 << 10}, now.Add(hour), now) // 100 KiB each
	}
	s := c.Stats()
	if s.Bytes > s.Capacity {
		t.Fatalf("holding %d bytes against a %d byte bound", s.Bytes, s.Capacity)
	}
	if s.Entries == 0 {
		t.Fatal("bounded to nothing: the cache holds no entries at all")
	}
	if s.Evictions == 0 {
		t.Error("no evictions recorded despite exceeding the bound")
	}
}

func TestEvictsLeastRecentlyUsed(t *testing.T) {
	c := New[blob](3, nil) // room for exactly three entries
	now := time.Now()
	one := blob{1 << 20}

	c.Put("a", one, now.Add(hour), now)
	c.Put("b", one, now.Add(hour), now)
	c.Put("c", one, now.Add(hour), now)
	// Touch a, so b becomes the least recently used.
	if _, ok := c.Get("a", now); !ok {
		t.Fatal("a should still be cached")
	}
	c.Put("d", one, now.Add(hour), now)

	if _, ok := c.Get("b", now); ok {
		t.Error("b was least recently used and should have been evicted")
	}
	for _, k := range []string{"a", "c", "d"} {
		if _, ok := c.Get(k, now); !ok {
			t.Errorf("%s should still be cached", k)
		}
	}
}

// An expired entry is dead weight. Reclaiming it must be preferred to evicting
// something still live and useful.
func TestDropsExpiredBeforeEvictingLive(t *testing.T) {
	m := new(Metrics)
	c := New[blob](3, m)
	now := time.Now()
	one := blob{1 << 20}

	c.Put("stale", one, now.Add(time.Minute), now)
	c.Put("live1", one, now.Add(hour), now)
	c.Put("live2", one, now.Add(hour), now)

	later := now.Add(2 * time.Minute) // stale has expired, the others have not
	c.Put("new", one, later.Add(hour), later)

	if _, ok := c.Get("stale", later); ok {
		t.Error("the expired entry should have been reclaimed")
	}
	for _, k := range []string{"live1", "live2", "new"} {
		if _, ok := c.Get(k, later); !ok {
			t.Errorf("%s was live and should not have been evicted", k)
		}
	}
	if n := m.Evictions.Load(); n != 0 {
		t.Errorf("evicted %d live entries when reclaiming an expired one would do", n)
	}
	if m.Expired.Load() == 0 {
		t.Error("no expiry recorded")
	}
}

func TestNeverServesAnExpiredEntry(t *testing.T) {
	c := New[blob](4, nil)
	now := time.Now()
	c.Put("k", blob{1024}, now.Add(time.Minute), now)

	if _, ok := c.Get("k", now.Add(30*time.Second)); !ok {
		t.Fatal("still live at 30s")
	}
	if _, ok := c.Get("k", now.Add(time.Minute)); ok {
		t.Error("served an entry at exactly its expiry; it must be treated as stale")
	}
	if s := c.Stats(); s.Entries != 0 || s.Bytes != 0 {
		t.Errorf("expired entry left behind: %d entries, %d bytes", s.Entries, s.Bytes)
	}
}

// A file read from disk has no max-age. A zero expiry must mean "until evicted",
// not "already stale" — reading it as stale would turn the asset pool into a
// cache that never hits.
func TestZeroExpiryNeverExpires(t *testing.T) {
	c := New[blob](1, nil)
	now := time.Now()
	c.Put("k", blob{1024}, time.Time{}, now)

	if _, ok := c.Get("k", now.Add(100*365*24*time.Hour)); !ok {
		t.Error("an entry stored with no expiry went stale")
	}
}

// Evicting a working cache to make room for one oversized value is worse than
// refusing the value.
func TestRefusesAValueLargerThanTheWholeBudget(t *testing.T) {
	m := new(Metrics)
	c := New[blob](1, m)
	now := time.Now()
	c.Put("keep", blob{500 << 10}, now.Add(hour), now)
	c.Put("huge", blob{4 << 20}, now.Add(hour), now)

	if _, ok := c.Get("huge", now); ok {
		t.Error("a value larger than the budget was cached")
	}
	if _, ok := c.Get("keep", now); !ok {
		t.Error("the existing entry was evicted to make room for one that could never fit")
	}
	if n := m.TooLarge.Load(); n != 1 {
		t.Errorf("TooLarge = %d, want 1", n)
	}
}

// Off means off, not "a very small cache".
func TestDisabledStoresNothing(t *testing.T) {
	m := new(Metrics)
	c := New[blob](0, m)
	now := time.Now()
	c.Put("k", blob{10}, now.Add(hour), now)
	if _, ok := c.Get("k", now); ok {
		t.Error("stored an entry with -cache-mb 0")
	}
	if s := c.Stats(); s.Bytes != 0 || s.Entries != 0 || s.Capacity != 0 {
		t.Errorf("disabled cache reports %d bytes, %d entries, %d capacity", s.Bytes, s.Entries, s.Capacity)
	}
	if n := m.Stores.Load(); n != 0 {
		t.Errorf("Stores = %d with caching off", n)
	}
}

// Replacing a key must not double-count its bytes, which would silently shrink
// the usable cache every time an entry was refreshed.
func TestReplacingAKeyAccountsOnce(t *testing.T) {
	c := New[blob](2, nil)
	now := time.Now()
	c.Put("k", blob{1 << 20}, now.Add(hour), now)
	c.Put("k", blob{1 << 20}, now.Add(hour), now)
	s := c.Stats()
	if s.Entries != 1 {
		t.Errorf("entries = %d after replacing one key, want 1", s.Entries)
	}
	if s.Bytes != 1<<20 {
		t.Errorf("bytes = %d after replacing a 1 MiB entry with another, want %d", s.Bytes, 1<<20)
	}
}

// growing reports a different size on each call. The cache must account by what
// it measured when it stored the value, or bytes drift away from reality and
// the bound stops holding.
type growing struct{ n *int64 }

func (g growing) Size() int64 { *g.n += 1 << 20; return *g.n }

func TestAccountingSurvivesAValueThatChangesItsMind(t *testing.T) {
	c := New[growing](4, nil)
	now := time.Now()
	var n int64
	c.Put("k", growing{&n}, now.Add(hour), now) // measured at 1 MiB
	c.Put("k", growing{&n}, now.Add(hour), now) // replacing it must subtract the 1 MiB, not 3

	if s := c.Stats(); s.Bytes != 2<<20 {
		t.Errorf("bytes = %d, want %d: accounting must use the size measured at store time", s.Bytes, 2<<20)
	}
}

// The "cache is full" line is printed once. A cache doing its job evicts
// constantly, and a line per eviction teaches an operator to ignore the log.
func TestWarnsOnceWhenFull(t *testing.T) {
	var buf strings.Builder
	defer swapLogOutput(&buf)()

	c := New[blob](1, nil)
	now := time.Now()
	for i := 0; i < 30; i++ {
		c.Put(fmt.Sprintf("k%d", i), blob{200 << 10}, now.Add(hour), now)
	}
	if n := strings.Count(buf.String(), "cache full"); n != 1 {
		t.Errorf("logged the full-cache line %d times, want exactly 1:\n%s", n, buf.String())
	}
}

func TestIsSafeUnderConcurrentUse(t *testing.T) {
	c := New[blob](2, nil)
	now := time.Now()
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				k := fmt.Sprintf("k%d", i%50)
				c.Put(k, blob{8 << 10}, now.Add(hour), now)
				c.Get(k, now)
				c.Stats()
			}
		}()
	}
	wg.Wait()
	if s := c.Stats(); s.Bytes > s.Capacity {
		t.Errorf("bound broken under concurrency: %d bytes against %d", s.Bytes, s.Capacity)
	}
}

// swapLogOutput redirects the standard logger so a test can assert what an
// operator would actually see. Returns a function that puts it back.
func swapLogOutput(w io.Writer) func() {
	prev := log.Writer()
	log.SetOutput(w)
	return func() { log.SetOutput(prev) }
}
