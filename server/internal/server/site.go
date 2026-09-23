package server

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"http4/server/internal/clientdist"
	"http4/server/internal/sender"
)

// Paths `http4d serve` adds on the HTTP listener. The client files live under
// ClientPath; the Service Worker script sits at the root so its scope covers
// the whole site. Site files with these names are shadowed.
const (
	ClientPath        = "/http4/"
	ServiceWorker     = "/http4-sw.js"
	serviceWorkerFile = "http4-sw.js"
)

// handleSite serves the site directory over HTTP in serve mode: the pages
// themselves, and every asset as the fallback for HTTP4, by the same name.
// A directory path serves its index.html; there are no listings.
func (s *Server) handleSite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// The path under the mount prefix is the asset ID, so a mounted build
	// keeps the same IDs it would have at the root.
	id := strings.TrimPrefix(r.URL.Path, s.assetPrefix)
	if id == "" || strings.HasSuffix(id, "/") {
		id += "index.html"
	}
	a, err := s.pool.Get(id)
	if errors.Is(err, sender.ErrNotFound) {
		// "/docs" names a directory with an index: send the browser to "/docs/"
		// so the page's relative links resolve against the directory.
		if !strings.HasSuffix(r.URL.Path, "/") {
			if _, err := s.pool.Get(id + "/index.html"); err == nil {
				target := r.URL.Path + "/"
				if r.URL.RawQuery != "" {
					target += "?" + r.URL.RawQuery
				}
				http.Redirect(w, r, target, http.StatusMovedPermanently)
				return
			}
		}
		// A single-page app routes in the browser, so a deep link like
		// /dashboard/settings names no file and must still load the shell.
		if s.spa && isNavigation(r) {
			if idx, err := s.pool.Get("index.html"); err == nil {
				writeAsset(w, r, idx)
				return
			}
		}
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	writeAsset(w, r, a)
}

// isNavigation reports whether this request is a browser asking for a page,
// as opposed to a subresource. The SPA fallback must not answer a missing
// script or stylesheet with HTML: the browser would reject it on MIME type and
// the real error — the file is missing — would be hidden behind a confusing
// one. Accept is the reliable signal; an extension in the path is a second,
// weaker one, kept because some tooling omits Accept.
func isNavigation(r *http.Request) bool {
	if !strings.Contains(r.Header.Get("Accept"), "text/html") {
		return false
	}
	return path.Ext(r.URL.Path) == ""
}

// handleClient serves a built client file from the embedded bundle or
// -client-dir: always `file` if set (the Service Worker at the root),
// otherwise the path under ClientPath.
func (s *Server) handleClient(file string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !clientdist.Built(s.clientFS) {
			http.Error(w, "HTTP4 client bundle not built into this http4d: run `npm run build` before building it, or pass -client-dir", http.StatusServiceUnavailable)
			return
		}
		name := file
		if name == "" {
			name = strings.TrimPrefix(r.URL.Path, ClientPath)
		}
		if !fs.ValidPath(name) || hidden(name) {
			http.NotFound(w, r)
			return
		}
		f, err := s.clientFS.Open(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || st.IsDir() {
			http.NotFound(w, r)
			return
		}
		body, ok := f.(io.ReadSeeker)
		if !ok {
			b, err := io.ReadAll(f)
			if err != nil {
				http.Error(w, "client file unavailable", http.StatusInternalServerError)
				return
			}
			body = bytes.NewReader(b)
		}
		// The bundle changes with every build of the client; let the browser
		// revalidate (a Service Worker script must never be cached stale).
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, name, st.ModTime(), body)
	}
}

// visibleAssets hides dotfiles (.git, .env, …) of a served site, over HTTP
// and HTTP4 alike, except .well-known.
type visibleAssets struct{ sender.Assets }

func (v visibleAssets) Get(id string) (*sender.Asset, error) {
	if hidden(id) {
		return nil, sender.ErrNotFound
	}
	return v.Assets.Get(id)
}

func hidden(p string) bool {
	for seg := range strings.SplitSeq(p, "/") {
		if strings.HasPrefix(seg, ".") && seg != ".well-known" {
			return true
		}
	}
	return false
}
