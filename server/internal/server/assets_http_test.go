package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"http4/server/internal/sender"
)

// The fallback route must serve the same bytes, Content-Type and ETag that
// HTTP4 sends for the same asset ID.
func TestAssetsOverHTTP(t *testing.T) {
	s := startTestServer(t, map[string][]byte{"app.js": []byte("export const x = 1;\n"), "pic.png": {0x89, 'P', 'N', 'G'}})
	a, err := s.assets.Get("app.js")
	if err != nil {
		t.Fatal(err)
	}

	rsp, err := http.Get(s.HTTPURL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(rsp.Body)
	rsp.Body.Close()
	if rsp.StatusCode != 200 || !bytes.Equal(body, a.Body) {
		t.Fatalf("GET /assets/app.js: %s %q", rsp.Status, body)
	}
	if got := rsp.Header.Get("Content-Type"); got != a.ContentType {
		t.Errorf("Content-Type %q, META says %q", got, a.ContentType)
	}
	if got := rsp.Header.Get("ETag"); got != a.ETag {
		t.Errorf("ETag %q, META says %q", got, a.ETag)
	}

	req, _ := http.NewRequest(http.MethodGet, s.HTTPURL+"/assets/app.js", nil)
	req.Header.Set("If-None-Match", a.ETag)
	rsp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	rsp.Body.Close()
	if rsp.StatusCode != http.StatusNotModified {
		t.Errorf("If-None-Match: %s, want 304", rsp.Status)
	}
}

func TestAssetsOverHTTPRejects(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", StaticDir: t.TempDir(), AssetsDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	for _, c := range []struct {
		method, path string
		want         int
	}{
		{"GET", "/assets/missing.txt", 404},
		{"GET", "/assets/", 404},    // no listing
		{"GET", "/assets/sub", 404}, // a directory is not an asset
		{"GET", "/assets/sub/", 404},
		{"POST", "/assets/a.txt", 405},
		{"HEAD", "/assets/a.txt", 200},
	} {
		req, _ := http.NewRequest(c.method, s.HTTPURL+c.path, nil)
		rsp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		rsp.Body.Close()
		if rsp.StatusCode != c.want {
			t.Errorf("%s %s: %d, want %d", c.method, c.path, rsp.StatusCode, c.want)
		}
	}
}

// The mux cleans "/assets/../x" before routing, so test the handler directly:
// an ID that escapes the assets directory is refused by os.Root.
func TestAssetHandlerRefusesEscape(t *testing.T) {
	// No listeners needed: the handler only uses the asset store.
	assets, err := sender.OpenDir(t.TempDir(), 8, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { assets.Close() })
	s := &Server{assets: assets, pool: assets}
	for _, id := range []string{"../index.html", "../../etc/passwd", "/etc/passwd"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.URL.Path = id
		s.handleAsset(w, r)
		if w.Code != http.StatusNotFound {
			t.Errorf("id %q: %d, want 404", id, w.Code)
		}
	}
}

func TestAssetPrefixValidation(t *testing.T) {
	for _, p := range []string{"assets/", "/assets", "/"} {
		if checkAssetPrefix(p) == nil {
			t.Errorf("prefix %q accepted", p)
		}
	}
	if err := checkAssetPrefix("/static/files/"); err != nil {
		t.Error(err)
	}
}
