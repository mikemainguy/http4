// Package fixtures generates the integrity suite's asset pool: files of fixed
// sizes filled with a deterministic pseudo-random stream, plus a manifest of
// their SHA-256 hashes.
//
// Each file's bytes come from ChaCha8Rand (math/rand/v2.ChaCha8, specified at
// c2sp.org/chacha8rand) seeded with SHA-256("http4-fixture/v1:" + name). The
// output is therefore identical on every machine and Go version, and the
// committed manifest can serve as a golden check. Random bytes also can't
// compress, so no layer can shrink them in transit.
package fixtures

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
)

// ManifestName is the file the manifest is written to, inside the output directory.
const ManifestName = "manifest.json"

type Spec struct {
	Name string
	Size int64
	Why  string
}

// Set is the fixture pool. The edge sizes sit on DATA payload boundaries:
// 1183 bytes for the server's 1200-byte datagrams, and 1007 bytes if the
// server has to shrink to the 1024 bytes Chrome reports as maxDatagramSize.
var Set = []Spec{
	{"edge-0.bin", 0, "empty asset: packet 0 only"},
	{"edge-1007.bin", 1007, "exactly one payload at a 1024-byte datagram"},
	{"edge-1008.bin", 1008, "one payload + 1 at a 1024-byte datagram"},
	{"edge-1183.bin", 1183, "exactly one payload at a 1200-byte datagram"},
	{"edge-1184.bin", 1184, "one payload + 1 at a 1200-byte datagram"},
	{"1k.bin", 1 << 10, ""},
	{"4k.bin", 4 << 10, "API-sized response (G3 workload)"},
	{"64k.bin", 64 << 10, ""},
	{"1m.bin", 1 << 20, ""},
	{"10m.bin", 10 << 20, ""},
	{"50m.bin", 50 << 20, ""},
}

type Entry struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type Manifest struct {
	Version   int     `json:"version"`
	Generator string  `json:"generator"`
	Assets    []Entry `json:"assets"`
}

const generator = "ChaCha8Rand seeded with SHA-256(\"http4-fixture/v1:\" + name); regenerate with scripts/gen-fixtures"

// Stream returns the deterministic byte stream for a fixture name.
func Stream(name string) io.Reader {
	return rand.NewChaCha8(sha256.Sum256([]byte("http4-fixture/v1:" + name)))
}

// Generate writes every fixture in set and the manifest into dir.
func Generate(dir string, set []Spec) (*Manifest, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	m := &Manifest{Version: 1, Generator: generator}
	for _, s := range set {
		sum, err := writeOne(filepath.Join(dir, s.Name), s)
		if err != nil {
			return nil, err
		}
		m.Assets = append(m.Assets, Entry{Name: s.Name, Size: s.Size, SHA256: sum})
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return m, os.WriteFile(filepath.Join(dir, ManifestName), append(b, '\n'), 0o644)
}

func writeOne(path string, s Spec) (string, error) {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	w := bufio.NewWriterSize(io.MultiWriter(f, h), 1<<20)
	_, err = io.CopyN(w, Stream(s.Name), s.Size)
	err = errors.Join(err, w.Flush(), f.Close())
	if err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("%s: %w", s.Name, err)
	}
	// Rename last so an interrupted run never leaves a truncated fixture in place.
	return hex.EncodeToString(h.Sum(nil)), os.Rename(tmp, path)
}

// ReadManifest loads a manifest written by Generate.
func ReadManifest(path string) (*Manifest, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &m, nil
}

// Check verifies that every file in m exists in dir with the recorded size
// and hash. It returns one problem per bad file.
func Check(dir string, m *Manifest) []error {
	var problems []error
	for _, e := range m.Assets {
		f, err := os.Open(filepath.Join(dir, e.Name))
		if err != nil {
			problems = append(problems, err)
			continue
		}
		h := sha256.New()
		n, err := io.Copy(h, f)
		f.Close()
		switch {
		case err != nil:
			problems = append(problems, fmt.Errorf("%s: %w", e.Name, err))
		case n != e.Size:
			problems = append(problems, fmt.Errorf("%s: %d bytes, manifest says %d", e.Name, n, e.Size))
		case hex.EncodeToString(h.Sum(nil)) != e.SHA256:
			problems = append(problems, fmt.Errorf("%s: SHA-256 differs from manifest", e.Name))
		}
	}
	return problems
}
