package server

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"http4/server/internal/sender"
)

// DefaultAssetPrefix is where the asset pool is served over plain HTTP. An
// asset with HTTP4 ID "img/a.png" is also at "/assets/img/a.png", so a client
// that can't use HTTP4 (no WebTransport, UDP blocked, a failed transfer)
// fetches the same bytes by the same name.
const DefaultAssetPrefix = "/assets/"

func checkAssetPrefix(p string) error {
	if !strings.HasPrefix(p, "/") || !strings.HasSuffix(p, "/") || p == "/" {
		return fmt.Errorf("asset prefix %q must start and end with / and not be the root", p)
	}
	return nil
}

// handleAsset serves one asset over HTTP, read-only and with no directory
// listings. It reads through the same DirAssets as the HTTP4 sender, so the
// Content-Type and ETag match the ones sent in META.
func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := r.URL.Path // prefix already stripped
	if id == "" || strings.HasSuffix(id, "/") {
		http.NotFound(w, r)
		return
	}
	a, err := s.assets.Get(id)
	if errors.Is(err, sender.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", a.ContentType)
	h.Set("ETag", a.ETag)
	if a.CacheControl != "" {
		h.Set("Cache-Control", a.CacheControl)
	}
	// ServeContent handles HEAD, Range, If-None-Match and If-Modified-Since.
	http.ServeContent(w, r, "", a.ModTime, bytes.NewReader(a.Body))
}
