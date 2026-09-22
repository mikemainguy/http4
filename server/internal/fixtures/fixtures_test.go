package fixtures

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The committed manifest is the golden record: generating on this machine
// must reproduce it exactly, byte for byte, including the manifest file.
func TestGenerateMatchesCommittedManifest(t *testing.T) {
	golden, err := os.ReadFile("../../../testdata/assets/" + ManifestName)
	if err != nil {
		t.Fatalf("committed manifest missing (run scripts/gen-fixtures): %v", err)
	}
	dir := t.TempDir()
	if _, err := Generate(dir, Set); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, golden) {
		t.Fatalf("generated manifest differs from testdata/assets/%s:\n%s", ManifestName, got)
	}
	m, _ := ReadManifest(filepath.Join(dir, ManifestName))
	if problems := Check(dir, m); len(problems) > 0 {
		t.Fatal(problems)
	}
}

func TestGenerateTwiceIsIdentical(t *testing.T) {
	small := Set[:8] // everything up to 1 MiB; the golden test covers the large ones
	a, b := t.TempDir(), t.TempDir()
	ma, err := Generate(a, small)
	if err != nil {
		t.Fatal(err)
	}
	mb, err := Generate(b, small)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ma, mb) {
		t.Fatal("manifests differ between runs")
	}
	for _, s := range small {
		x, _ := os.ReadFile(filepath.Join(a, s.Name))
		y, _ := os.ReadFile(filepath.Join(b, s.Name))
		if !bytes.Equal(x, y) || int64(len(x)) != s.Size {
			t.Errorf("%s differs between runs or has the wrong size", s.Name)
		}
	}
}

// Reading the stream in different chunk sizes must give the same bytes, so
// the output doesn't depend on buffer sizes in the generator.
func TestStreamIsChunkingIndependent(t *testing.T) {
	whole := make([]byte, 100_000)
	io.ReadFull(Stream("x"), whole)
	var pieces []byte
	r := Stream("x")
	for _, n := range []int{1, 7, 4096, 13, 50_000, 45_883} {
		buf := make([]byte, n)
		io.ReadFull(r, buf)
		pieces = append(pieces, buf...)
	}
	if !bytes.Equal(whole, pieces) {
		t.Fatal("chunked reads differ from one read")
	}
	other := make([]byte, 64)
	io.ReadFull(Stream("y"), other)
	if bytes.Equal(other, whole[:64]) {
		t.Fatal("different names gave the same stream")
	}
}

func TestCheckDetectsCorruption(t *testing.T) {
	dir := t.TempDir()
	m, err := Generate(dir, Set[:6])
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "1k.bin"))
	b[500] ^= 1
	os.WriteFile(filepath.Join(dir, "1k.bin"), b, 0o644)
	os.Remove(filepath.Join(dir, "edge-1007.bin"))
	if got := len(Check(dir, m)); got != 2 {
		t.Fatalf("Check found %d problems, want 2", got)
	}
}
