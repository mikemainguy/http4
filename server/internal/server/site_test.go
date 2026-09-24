package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/quic-go/webtransport-go"

	"http4/server/internal/sender"
	"http4/server/internal/wire"
)

var siteFiles = map[string]string{
	"index.html":          "<h1>home</h1>",
	"css/site.css":        "body{}",
	"docs/index.html":     "<h1>docs</h1>",
	"nodir/readme.txt":    "no index here",
	"data.json":           `{"a":1}`,
	".env":                "SECRET=1",
	".git/config":         "[core]",
	".well-known/ok.txt":  "ok",
	"img/.hidden/pic.png": "x",
}

var clientFiles = fstest.MapFS{
	"http4.js":     {Data: []byte("export const x = 1;")},
	"http4-sw.js":  {Data: []byte("self.onfetch = () => {};")},
	"auto.js":      {Data: []byte("import './http4.js';")},
	".hidden.js":   {Data: []byte("nope")},
	"types/x.d.ts": {Data: []byte("export {};")},
}

// startSite runs the server in serve mode on a fresh site directory, which
// also holds escape.txt: a symlink to a secret outside the site.
func startSite(t *testing.T, client fstest.MapFS, noH3 bool) *Server {
	t.Helper()
	root := t.TempDir()
	site := filepath.Join(root, "site")
	for name, body := range siteFiles {
		p := filepath.Join(site, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(root, "secret.txt"), []byte("outside"), 0o644)
	if err := os.Symlink(filepath.Join(root, "secret.txt"), filepath.Join(site, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	cfg := Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", SiteDir: site, NoH3: noH3}
	if client != nil {
		cfg.ClientFS = client
	}
	s, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

var noRedirect = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func get(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	rsp, err := noRedirect.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer rsp.Body.Close()
	b, _ := io.ReadAll(rsp.Body)
	return rsp, string(b)
}

func TestSiteServesPagesAndAssetsOverHTTP(t *testing.T) {
	s := startSite(t, clientFiles, true)
	for path, want := range map[string]string{
		"/":                    "<h1>home</h1>",
		"/index.html":          "<h1>home</h1>",
		"/docs/":               "<h1>docs</h1>",
		"/css/site.css":        "body{}",
		"/data.json":           `{"a":1}`,
		"/.well-known/ok.txt":  "ok",
		"/nodir/readme.txt":    "no index here",
		"/css/site.css?v=2":    "body{}",
		"/docs/index.html?q=1": "<h1>docs</h1>",
	} {
		rsp, body := get(t, s.HTTPURL+path)
		if rsp.StatusCode != 200 || body != want {
			t.Errorf("GET %s: %d %q, want 200 %q", path, rsp.StatusCode, body, want)
		}
	}
	rsp, _ := get(t, s.HTTPURL+"/css/site.css")
	if ct := rsp.Header.Get("Content-Type"); ct != "text/css; charset=utf-8" {
		t.Errorf("site.css Content-Type %q", ct)
	}
	if rsp.Header.Get("ETag") == "" {
		t.Error("no ETag on a site asset")
	}
}

func TestSiteRefusesListingsDotfilesAndEscapes(t *testing.T) {
	s := startSite(t, clientFiles, true)
	for _, path := range []string{
		"/nodir/", "/nodir", "/css/", "/missing.html",
		"/.env", "/.git/config", "/img/.hidden/pic.png",
		"/escape.txt", // symlink out of the site: os.Root refuses it
	} {
		if rsp, body := get(t, s.HTTPURL+path); rsp.StatusCode != 404 {
			t.Errorf("GET %s: %d %q, want 404", path, rsp.StatusCode, body)
		}
	}
	// A directory with an index, named without its slash, redirects to it.
	rsp, _ := get(t, s.HTTPURL+"/docs?x=1")
	if rsp.StatusCode != http.StatusMovedPermanently || rsp.Header.Get("Location") != "/docs/?x=1" {
		t.Errorf("GET /docs: %d Location %q, want 301 /docs/?x=1", rsp.StatusCode, rsp.Header.Get("Location"))
	}
	if rsp, err := http.Post(s.HTTPURL+"/data.json", "text/plain", nil); err != nil || rsp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST: %v %v, want 405", rsp.StatusCode, err)
	}
}

// The mux cleans ".." before routing, so test the handler directly. No
// listeners: starting and at once closing a server trips the known
// Serve/Close race in webtransport-go (vrek iss-ag6h0a6).
func TestSiteHandlerRefusesTraversal(t *testing.T) {
	root := t.TempDir()
	site := filepath.Join(root, "site")
	os.MkdirAll(site, 0o755)
	os.WriteFile(filepath.Join(root, "secret.txt"), []byte("outside"), 0o644)
	assets, err := sender.OpenDir(site, 8, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { assets.Close() })
	s := &Server{assets: assets, pool: visibleAssets{assets}}
	for _, p := range []string{"/../secret.txt", "/../../etc/passwd", "//etc/passwd"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.URL.Path = p
		s.handleSite(w, r)
		if w.Code != http.StatusNotFound {
			t.Errorf("path %q: %d, want 404", p, w.Code)
		}
	}
}

func TestSiteServesClientBundle(t *testing.T) {
	s := startSite(t, clientFiles, true)
	for path, want := range map[string]string{
		"/http4/http4.js": "export const x = 1;",
		"/http4/auto.js":  "import './http4.js';",
		"/http4-sw.js":    "self.onfetch = () => {};",
	} {
		rsp, body := get(t, s.HTTPURL+path)
		if rsp.StatusCode != 200 || body != want {
			t.Errorf("GET %s: %d %q", path, rsp.StatusCode, body)
			continue
		}
		if ct := rsp.Header.Get("Content-Type"); ct != "text/javascript; charset=utf-8" {
			t.Errorf("%s Content-Type %q", path, ct)
		}
		if cc := rsp.Header.Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("%s Cache-Control %q", path, cc)
		}
	}
	for _, path := range []string{"/http4/", "/http4/types", "/http4/.hidden.js", "/http4/missing.js"} {
		if rsp, _ := get(t, s.HTTPURL+path); rsp.StatusCode != 404 {
			t.Errorf("GET %s: %d, want 404", path, rsp.StatusCode)
		}
	}
}

func TestSiteClientBundleMissing(t *testing.T) {
	// A bundle without http4.js is unbuilt: 503 with a hint, not a silent 404.
	s := startSite(t, fstest.MapFS{"placeholder": {}}, true)
	for _, path := range []string{"/http4/http4.js", "/http4-sw.js"} {
		if rsp, body := get(t, s.HTTPURL+path); rsp.StatusCode != http.StatusServiceUnavailable || !bytes.Contains([]byte(body), []byte("npm run build")) {
			t.Errorf("GET %s: %d %q, want 503 with a build hint", path, rsp.StatusCode, body)
		}
	}
	// A built bundle without the Service Worker (yet) answers 404 for it.
	s = startSite(t, fstest.MapFS{"http4.js": {Data: []byte("x")}}, true)
	if rsp, _ := get(t, s.HTTPURL+"/http4-sw.js"); rsp.StatusCode != 404 {
		t.Errorf("missing SW: %d, want 404", rsp.StatusCode)
	}
}

func TestSiteConfigAdvertisesRootAssetPrefix(t *testing.T) {
	s := startSite(t, clientFiles, true)
	cfg := fetchConfig(t, s)
	if cfg.AssetPrefix != "/" {
		t.Errorf("assetPrefix %q, want /", cfg.AssetPrefix)
	}
	if cfg.H3URL != "" {
		t.Errorf("h3Url %q with h3 off, want empty", cfg.H3URL)
	}
	if s := startSite(t, clientFiles, false); fetchConfig(t, s).H3URL == "" {
		t.Error("h3Url empty with h3 on")
	}
	// Sandbox mode is unchanged: its fallback prefix.
	if got := fetchConfig(t, startTestServer(t, nil)).AssetPrefix; got != DefaultAssetPrefix {
		t.Errorf("sandbox assetPrefix %q, want %q", got, DefaultAssetPrefix)
	}
}

// HTTP4 asset IDs are the site's paths: the same file over HTTP4 and HTTP,
// with the same Content-Type. Hidden files are hidden over HTTP4 too.
func TestSiteHTTP4IDsMatchHTTPPaths(t *testing.T) {
	s := startSite(t, clientFiles, true)
	cfg := fetchConfig(t, s)
	_, sess, err := dial(t, cfg, cfg.WebTransportURL, s.HTTPURL)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.CloseWithError(0, "")
	for i, id := range []string{"css/site.css", "docs/index.html", "data.json", ".well-known/ok.txt"} {
		body, meta, err := fetchHTTP4(t, sess, wire.RPCID(i+1), id)
		if err != nil {
			t.Fatalf("%s over HTTP4: %v", id, err)
		}
		rsp, want := get(t, s.HTTPURL+"/"+id)
		if string(body) != want {
			t.Errorf("%s: HTTP4 %q vs HTTP %q", id, body, want)
		}
		if meta["content-type"] != rsp.Header.Get("Content-Type") || meta["etag"] != rsp.Header.Get("ETag") {
			t.Errorf("%s: META %v vs HTTP %v", id, meta, rsp.Header)
		}
	}
	for i, id := range []string{".env", ".git/config", "escape.txt", "index.html/.."} {
		if _, _, err := fetchHTTP4(t, sess, wire.RPCID(100+i), id); !errors.Is(err, errNotFound) {
			t.Errorf("%s over HTTP4: %v, want NOT_FOUND", id, err)
		}
	}
}

var errNotFound = errors.New("NOT_FOUND")

// fetchHTTP4 fetches one small asset: a REQ granting everything, re-sent if
// nothing complete arrives within 200 ms. It returns the body and META fields.
func fetchHTTP4(t *testing.T, sess *webtransport.Session, rpc wire.RPCID, id string) ([]byte, map[string]string, error) {
	t.Helper()
	req, err := wire.Marshal(&wire.Req{RPCID: rpc, InitialGrant: 1 << 20, AssetID: id})
	if err != nil {
		t.Fatal(err)
	}
	var body []byte
	var have int
	var meta map[string]string
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if err := sess.SendDatagram(req); err != nil {
			t.Fatal(err)
		}
		for {
			rctx, rcancel := context.WithTimeout(ctx, 200*time.Millisecond)
			b, err := sess.ReceiveDatagram(rctx)
			rcancel()
			if err != nil {
				if ctx.Err() != nil {
					return nil, nil, ctx.Err()
				}
				break // stalled: send the REQ again
			}
			p, err := wire.Decode(b)
			if err != nil || p.RPC() != rpc {
				continue
			}
			switch p := p.(type) {
			case *wire.Error:
				if p.Code == wire.CodeNotFound {
					return nil, nil, errNotFound
				}
				return nil, nil, errors.New("ERROR " + p.Type().String())
			case *wire.Meta:
				meta = map[string]string{}
				for _, f := range p.Fields {
					meta[f.Name] = f.Value
				}
			case *wire.Data:
				if body == nil {
					body = make([]byte, p.TotalSize)
				}
				have += copy(body[p.Offset:], p.Payload)
			}
			if body != nil && have >= len(body) && meta != nil {
				return body, meta, nil
			}
		}
	}
}

// A single-page app routes in the browser, so a deep link names no file and
// must still load the shell. Off by default, because for an ordinary site a
// missing page should be a 404 rather than the home page with status 200.
func TestSPAFallback(t *testing.T) {
	site := t.TempDir()
	index := []byte("<!doctype html><title>app</title>")
	for name, body := range map[string][]byte{"index.html": index, "app.js": []byte("//js")} {
		if err := os.WriteFile(filepath.Join(site, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	get := func(s *Server, path, accept string) (*http.Response, []byte) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, s.HTTPURL+path, nil)
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		rsp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer rsp.Body.Close()
		b, _ := io.ReadAll(rsp.Body)
		return rsp, b
	}

	off, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", SiteDir: site})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { off.Close() })
	if rsp, _ := get(off, "/dashboard/settings", "text/html"); rsp.StatusCode != http.StatusNotFound {
		t.Errorf("without -spa: deep link gave %s, want 404", rsp.Status)
	}

	on, err := Start(Config{HTTPAddr: "127.0.0.1:0", WTAddr: "127.0.0.1:0", SiteDir: site, SPA: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { on.Close() })

	rsp, body := get(on, "/dashboard/settings", "text/html,application/xhtml+xml")
	if rsp.StatusCode != http.StatusOK || !bytes.Equal(body, index) {
		t.Errorf("deep link gave %s, %q; want 200 and the shell", rsp.Status, body)
	}
	// A real file still wins over the fallback.
	if rsp, body := get(on, "/app.js", "*/*"); rsp.StatusCode != http.StatusOK || string(body) != "//js" {
		t.Errorf("/app.js gave %s, %q", rsp.Status, body)
	}
	// A MISSING subresource must still 404: answering it with HTML would fail
	// the browser's MIME check and hide the real error behind a confusing one.
	if rsp, _ := get(on, "/missing.js", "*/*"); rsp.StatusCode != http.StatusNotFound {
		t.Errorf("missing subresource gave %s, want 404", rsp.Status)
	}
	// Extensionless but not a navigation (no text/html): not the shell either.
	if rsp, _ := get(on, "/api/thing", "application/json"); rsp.StatusCode != http.StatusNotFound {
		t.Errorf("non-navigation gave %s, want 404", rsp.Status)
	}
}
