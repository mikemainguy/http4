package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The header only ever advertises a port, never a host: RFC 7838 reads ":443"
// as "same host, this port", which stays right however the client reached us.
func TestAltSvcValue(t *testing.T) {
	for _, tc := range []struct {
		name, wtURL, listen, want string
	}{
		{"advertised host and port", "https://demo.example:4433/wt", "[::]:4433", `h3=":4433"; ma=86400`},
		{"https with no port means 443", "https://demo.example/wt", "[::]:443", `h3=":443"; ma=86400`},
		{"falls back to the listener", "", "127.0.0.1:8443", `h3=":8443"; ma=86400`},
		{"the advertised port wins over the listener's", "https://demo.example:9000/wt", "127.0.0.1:4433", `h3=":9000"; ma=86400`},
		// Advertising a port that doesn't answer is worse than advertising
		// nothing: a browser would retry HTTP/3 and fall back every request.
		{"no port anywhere", "", "", ""},
		{"port 0 is not a real port", "", "127.0.0.1:0", ""},
		{"unparseable", "://bad", "nonsense", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := altSvcValue(tc.wtURL, tc.listen); got != tc.want {
				t.Errorf("altSvcValue(%q, %q) = %q, want %q", tc.wtURL, tc.listen, got, tc.want)
			}
		})
	}
}

func TestWithAltSvcSetsHeaderOnEveryResponse(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A handler writing its own headers and status must not lose it.
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusNotFound)
	})
	rec := httptest.NewRecorder()
	withAltSvc(inner, `h3=":443"; ma=86400`).ServeHTTP(rec, httptest.NewRequest("GET", "/missing", nil))
	if got := rec.Header().Get("Alt-Svc"); got != `h3=":443"; ma=86400` {
		t.Errorf("Alt-Svc = %q", got)
	}
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

// Off by default, because Alt-Svc applies to the whole origin and would move
// the plain-HTTP baseline from HTTP/2 to HTTP/3 without anything saying so.
func TestAltSvcOffByDefault(t *testing.T) {
	s := startTestServer(t, map[string][]byte{"a.txt": []byte("hi")})
	rsp, err := http.Get(s.HTTPURL + "/config.json")
	if err != nil {
		t.Fatal(err)
	}
	defer rsp.Body.Close()
	if got := rsp.Header.Get("Alt-Svc"); got != "" {
		t.Errorf("Alt-Svc = %q with the zero Config; want none", got)
	}
	if strings.Contains(s.WebTransportURL, "[::]") {
		t.Errorf("test server advertised a wildcard address: %q", s.WebTransportURL)
	}
}
