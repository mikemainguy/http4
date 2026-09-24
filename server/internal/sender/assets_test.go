package sender

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// writeFiles fills a directory with n files of the given size and returns it.
func writeFiles(t *testing.T, n, size int) string {
	t.Helper()
	dir := t.TempDir()
	body := make([]byte, size)
	for i := range n {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("a%d.bin", i)), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// The regression this cache exists for (vrek iss-0yd99d2): the asset pool used
// to keep every file it ever read, so memory grew with the number of distinct
// paths asked for — and a remote client chooses the paths.
func TestDirAssetsDoesNotGrowWithoutBound(t *testing.T) {
	const files, size = 200, 64 << 10 // 12.5 MiB of files
	dir := writeFiles(t, files, size)

	d, err := OpenDir(dir, 1, nil) // a 1 MB budget for 12.5 MiB of files
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	for i := range files {
		if _, err := d.Get(fmt.Sprintf("a%d.bin", i)); err != nil {
			t.Fatalf("a%d.bin: %v", i, err)
		}
	}
	s := d.CacheStats()
	if s.Bytes > s.Capacity {
		t.Errorf("holding %d bytes against a %d byte bound", s.Bytes, s.Capacity)
	}
	if s.Evictions == 0 {
		t.Error("read 12.5 MiB of files into a 1 MB cache with no evictions: the bound is not binding")
	}
}

// Every asset must still be served correctly once the cache is too small to
// hold them: a miss re-reads from disk, it does not fail or return short.
func TestDirAssetsServesCorrectlyUnderEviction(t *testing.T) {
	dir := t.TempDir()
	for i := range 50 {
		body := []byte(fmt.Sprintf("body-%d", i))
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("a%d.txt", i)), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	d, err := OpenDir(dir, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	// Twice over, so the second pass reads entries that may have been evicted.
	for pass := range 2 {
		for i := range 50 {
			a, err := d.Get(fmt.Sprintf("a%d.txt", i))
			if err != nil {
				t.Fatalf("pass %d, a%d.txt: %v", pass, i, err)
			}
			if got, want := string(a.Body), fmt.Sprintf("body-%d", i); got != want {
				t.Fatalf("pass %d: a%d.txt = %q, want %q", pass, i, got, want)
			}
		}
	}
}

// -cache-mb 0 must still serve every asset, straight from disk.
func TestDirAssetsWithCachingOff(t *testing.T) {
	dir := writeFiles(t, 3, 128)
	d, err := OpenDir(dir, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	for i := range 3 {
		a, err := d.Get(fmt.Sprintf("a%d.bin", i))
		if err != nil {
			t.Fatalf("a%d.bin: %v", i, err)
		}
		if len(a.Body) != 128 {
			t.Errorf("a%d.bin: %d bytes, want 128", i, len(a.Body))
		}
	}
	if s := d.CacheStats(); s.Entries != 0 || s.Bytes != 0 {
		t.Errorf("cache off but holding %d entries, %d bytes", s.Entries, s.Bytes)
	}
}

// A cached asset must be served whole. An earlier bug class here is accounting
// that drifts from what is held; this asserts the bytes themselves survive.
func TestDirAssetsHitReturnsTheSameBytes(t *testing.T) {
	dir := t.TempDir()
	want := []byte("the quick brown fox")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), want, 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := OpenDir(dir, 4, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	first, err := d.Get("f.txt")
	if err != nil {
		t.Fatal(err)
	}
	second, err := d.Get("f.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(second.Body) != string(want) {
		t.Errorf("cached body = %q, want %q", second.Body, want)
	}
	if first.ETag != second.ETag {
		t.Errorf("ETag changed between reads: %s then %s", first.ETag, second.ETag)
	}
	if s := d.CacheStats(); s.Hits != 1 {
		t.Errorf("hits = %d after a repeat read, want 1", s.Hits)
	}
}

// An asset ID that escapes the root is "not found", cached or not.
func TestDirAssetsStillRefusesEscapes(t *testing.T) {
	dir := writeFiles(t, 1, 16)
	d, err := OpenDir(dir, 4, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	for _, id := range []string{"../etc/passwd", "/etc/passwd", "a0.bin/../../x"} {
		if _, err := d.Get(id); err != ErrNotFound {
			t.Errorf("Get(%q) = %v, want ErrNotFound", id, err)
		}
	}
}
