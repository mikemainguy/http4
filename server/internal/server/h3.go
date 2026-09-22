package server

import (
	"bytes"
	"errors"
	"net/http"
	"strings"

	"http4/server/internal/sender"
)

// handleH3Asset serves an asset over ordinary HTTP/3 streams: the baseline
// the benchmarks compare HTTP4 against. It runs on the same QUIC listener,
// certificate and quic-go configuration as WebTransport, so both stacks share
// one UDP port and, behind the impairment proxy, the same impaired path.
//
// The page is on another origin (the TCP server), so allowed origins get CORS
// and Timing-Allow-Origin; without the latter, Resource Timing hides
// nextHopProtocol and the benchmark can't prove the fetch really used h3.
func (s *Server) handleH3Asset(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" && s.allowedOrigin(r) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Timing-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
	case http.MethodOptions:
		// Benchmark requests are simple (GET, no custom headers), so no
		// preflight is expected; answer one anyway rather than fail oddly.
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD")
		w.WriteHeader(http.StatusNoContent)
		return
	default:
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, H3Path)
	a, err := s.pool.Get(id)
	if err != nil {
		if errors.Is(err, sender.ErrNotFound) {
			http.NotFound(w, r)
		} else {
			http.Error(w, "bad request", http.StatusBadRequest)
		}
		return
	}
	w.Header().Set("Content-Type", a.ContentType)
	w.Header().Set("ETag", a.ETag)
	// Every benchmark fetch must cross the network, never the browser cache.
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, id, a.ModTime, bytes.NewReader(a.Body))
}
