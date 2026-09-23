package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Next.js shape: the app's static build is mounted and travels over HTTP4,
// while the app itself keeps serving everything else over plain HTTP
// (vrek iss-sz6a8zk).
func TestMountAndPassThrough(t *testing.T) {
	chunk := []byte("export const x = 1;\n")
	build := t.TempDir()
	if err := os.MkdirAll(filepath.Join(build, "chunks"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(build, "chunks", "main.js"), chunk, 0o600); err != nil {
		t.Fatal(err)
	}

	var gotHost, gotFwd, gotPath string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost, gotFwd, gotPath = r.Host, r.Header.Get("X-Forwarded-For"), r.URL.Path
		if r.Method == http.MethodPost {
			b, _ := io.ReadAll(r.Body)
			w.WriteHeader(http.StatusCreated)
			w.Write(append([]byte("posted:"), b...))
			return
		}
		w.Header().Set("Set-Cookie", "session=abc; Path=/")
		w.Write([]byte("app says " + r.URL.Path))
	}))
	t.Cleanup(app.Close)

	s, err := Start(Config{
		HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0",
		SiteDir: build, MountAt: "/_next/static/", PassThrough: app.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })

	// The advertised prefix is the mount, so the worker forwards only those
	// paths to HTTP4 and leaves the application's alone.
	if cfg := fetchConfig(t, s); cfg.AssetPrefix != "/_next/static/" {
		t.Errorf("advertised assetPrefix %q, want the mount", cfg.AssetPrefix)
	}

	// Mounted file: served by http4d itself, not proxied.
	rsp, err := http.Get(s.HTTPURL + "/_next/static/chunks/main.js")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(rsp.Body)
	rsp.Body.Close()
	if rsp.StatusCode != http.StatusOK || !bytes.Equal(body, chunk) {
		t.Fatalf("mounted chunk: %s %q", rsp.Status, body)
	}
	if ct := rsp.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Errorf("mounted chunk Content-Type %q", ct)
	}
	if gotPath == "/_next/static/chunks/main.js" {
		t.Error("the mounted path reached the application; it must be served locally")
	}

	// And the same asset ID over HTTP4, so the two agree byte for byte.
	a, err := s.pool.Get("chunks/main.js")
	if err != nil || !bytes.Equal(a.Body, chunk) {
		t.Fatalf("HTTP4 asset chunks/main.js: %v", err)
	}

	// Everything else reaches the application, with its own headers intact.
	rsp, err = http.Get(s.HTTPURL + "/dashboard")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(rsp.Body)
	rsp.Body.Close()
	if string(body) != "app says /dashboard" {
		t.Fatalf("proxied page: %q", body)
	}
	if c := rsp.Header.Get("Set-Cookie"); !strings.Contains(c, "session=abc") {
		t.Errorf("Set-Cookie lost in the proxy: %q", c)
	}
	// The app is behind us and cannot see the browser's request, so it must be
	// told: it builds absolute URLs and cookie domains from these.
	if gotHost != s.hostOnly() {
		t.Errorf("upstream saw Host %q, want the browser's %q", gotHost, s.hostOnly())
	}
	if gotFwd == "" {
		t.Error("no X-Forwarded-For reached the application")
	}

	// A method HTTP4 cannot carry still works, because it never goes near it.
	rsp, err = http.Post(s.HTTPURL+"/api/items", "text/plain", strings.NewReader("hi"))
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(rsp.Body)
	rsp.Body.Close()
	if rsp.StatusCode != http.StatusCreated || string(body) != "posted:hi" {
		t.Fatalf("proxied POST: %s %q", rsp.Status, body)
	}
}

func TestPassThroughRejectsBadOrigins(t *testing.T) {
	for _, bad := range []string{"localhost:3000", "ftp://x", "http://", "http://x/base/path"} {
		if _, err := newPassThrough(bad); err == nil {
			t.Errorf("newPassThrough(%q) accepted it", bad)
		}
	}
	if _, err := newPassThrough("http://localhost:3000"); err != nil {
		t.Errorf("newPassThrough rejected a good origin: %v", err)
	}
	// A bare trailing slash is an origin, not a path.
	if _, err := newPassThrough("http://localhost:3000/"); err != nil {
		t.Errorf("newPassThrough rejected a trailing slash: %v", err)
	}
}

// A mount that covered the client's own files would serve the page's bootstrap
// out of the application's build.
func TestMountMayNotCoverTheClientsFiles(t *testing.T) {
	// "/http4/" is the harmful one: it is the client path exactly, so the mux
	// would carry two handlers for it. A prefix like "/config.json/" is merely
	// odd — it is a different pattern from "/config.json", which still wins —
	// so it is not rejected.
	for _, at := range []string{"/http4/"} {
		_, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", SiteDir: t.TempDir(), MountAt: at})
		if err == nil {
			t.Errorf("-mount-at %q was accepted", at)
		}
	}
	// Malformed prefixes are refused too.
	for _, at := range []string{"_next/static/", "/_next/static"} {
		if _, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", SiteDir: t.TempDir(), MountAt: at}); err == nil {
			t.Errorf("-mount-at %q was accepted", at)
		}
	}
}
