package server

import (
	"math/rand/v2"
	"net/http"
	"testing"
	"time"
)

func getReq(reqHeaders ...string) *http.Request {
	r, _ := http.NewRequest(http.MethodGet, "https://example.test/a.js", nil)
	for i := 0; i+1 < len(reqHeaders); i += 2 {
		r.Header.Set(reqHeaders[i], reqHeaders[i+1])
	}
	return r
}

func respWith(status int, headers ...string) *http.Response {
	h := http.Header{}
	for i := 0; i+1 < len(headers); i += 2 {
		h.Add(headers[i], headers[i+1])
	}
	return &http.Response{StatusCode: status, Header: h}
}

// The table from the issue, one row per case, with the real headers the
// frameworks emit rather than invented ones.
func TestCacheable(t *testing.T) {
	for _, tc := range []struct {
		name   string
		req    *http.Request
		resp   *http.Response
		want   bool
		maxAge time.Duration
	}{
		{
			name: "Next.js static chunk: content-hashed and immutable",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, max-age=31536000, immutable"),
			want: true, maxAge: 31536000 * time.Second,
		},
		{
			name: "Next.js SSR page",
			req:  getReq(), resp: respWith(200, "Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate"),
			want: false,
		},
		{
			name: "Next.js ISR page: s-maxage is the shared-cache directive",
			req:  getReq(), resp: respWith(200, "Cache-Control", "s-maxage=60, stale-while-revalidate"),
			want: true, maxAge: 60 * time.Second,
		},
		{
			name: "s-maxage wins over max-age for a shared cache",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, max-age=10, s-maxage=600"),
			want: true, maxAge: 600 * time.Second,
		},
		{
			name: "Next.js public/ default: public but nothing to reuse",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, max-age=0"),
			want: false,
		},
		{
			name: "public with no lifetime is held briefly, not forever",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public"),
			want: true, maxAge: defaultPublicTTL,
		},
		{
			name: "a cookie makes it per-user whatever else it says",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, max-age=600", "Set-Cookie", "session=abc"),
			want: false,
		},
		{
			name: "Vary: Cookie varies on something we do not key on",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, max-age=600", "Vary", "Cookie"),
			want: false,
		},
		{
			name: "Vary: Accept-Encoding is the one variation we can key on",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, max-age=600", "Vary", "Accept-Encoding"),
			want: true, maxAge: 600 * time.Second,
		},
		{
			name: "Vary: * is refused, not guessed at",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, max-age=600", "Vary", "*"),
			want: false,
		},
		{
			name: "Vary listing Accept-Encoding among others is still refused",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, max-age=600", "Vary", "Accept-Encoding, Cookie"),
			want: false,
		},
		{
			name: "an authenticated request cannot produce a shared response",
			req:  getReq("Authorization", "Bearer x"), resp: respWith(200, "Cache-Control", "public, max-age=600"),
			want: false,
		},
		{
			name: "a request carrying cookies is personalised",
			req:  getReq("Cookie", "session=abc"), resp: respWith(200, "Cache-Control", "public, max-age=600"),
			want: false,
		},
		{
			name: "no Cache-Control at all: the origin did not say, so we do not guess",
			req:  getReq(), resp: respWith(200),
			want: false,
		},
		{
			name: "no-cache permits storing but requires revalidation, which is out of scope",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, no-cache, max-age=600"),
			want: false,
		},
		{
			name: "a redirect is not a body to reuse",
			req:  getReq(), resp: respWith(302, "Cache-Control", "public, max-age=600"),
			want: false,
		},
		{
			name: "a range response is a fragment, not the resource",
			req:  getReq(), resp: respWith(206, "Cache-Control", "public, max-age=600"),
			want: false,
		},
		{
			name: "a 404 is not cached even when it says it may be",
			req:  getReq(), resp: respWith(404, "Cache-Control", "public, max-age=600"),
			want: false,
		},
		{
			name: "a malformed max-age says nothing, so nothing is cached",
			req:  getReq(), resp: respWith(200, "Cache-Control", "max-age=abc"),
			want: false,
		},
		{
			name: "directives are case-insensitive and whitespace-tolerant",
			req:  getReq(), resp: respWith(200, "Cache-Control", "  PUBLIC ,  Max-Age=120  "),
			want: true, maxAge: 120 * time.Second,
		},
		{
			name: "Cache-Control split across repeated headers is still read whole",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public", "Cache-Control", "max-age=300"),
			want: true, maxAge: 300 * time.Second,
		},
		{
			name: "no-store in a second header still refuses",
			req:  getReq(), resp: respWith(200, "Cache-Control", "public, max-age=300", "Cache-Control", "no-store"),
			want: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := cacheable(tc.req, tc.resp)
			if d.ok != tc.want {
				t.Fatalf("cacheable = %v (%s), want %v", d.ok, d.reason, tc.want)
			}
			if d.ok && d.maxAge != tc.maxAge {
				t.Errorf("maxAge = %v, want %v", d.maxAge, tc.maxAge)
			}
			if !d.ok && d.reason == "" {
				t.Error(`refused with no reason; "not cached" with no explanation is unactionable`)
			}
		})
	}
}

// The invariant, over randomised combinations rather than the cases someone
// thought to write down: nothing personalised is ever reported cacheable. This
// is the property that makes a bug here a data leak rather than a slow page.
func TestCacheableNeverSharesPersonalisedResponses(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	ccParts := []string{"public", "private", "no-store", "no-cache", "max-age=600", "s-maxage=600", "max-age=0", "immutable", "must-revalidate", "stale-while-revalidate"}
	varys := []string{"", "Accept-Encoding", "Cookie", "*", "Accept-Encoding, Cookie", "Origin"}

	for i := 0; i < 20000; i++ {
		h := http.Header{}
		var cc []string
		for _, p := range ccParts {
			if rng.IntN(3) == 0 {
				cc = append(cc, p)
			}
		}
		for _, p := range cc {
			h.Add("Cache-Control", p)
		}
		setCookie := rng.IntN(4) == 0
		if setCookie {
			h.Add("Set-Cookie", "s=1")
		}
		vary := varys[rng.IntN(len(varys))]
		if vary != "" {
			h.Add("Vary", vary)
		}
		r, _ := http.NewRequest(http.MethodGet, "https://example.test/x", nil)
		authed := rng.IntN(5) == 0
		if authed {
			if rng.IntN(2) == 0 {
				r.Header.Set("Authorization", "Bearer x")
			} else {
				r.Header.Set("Cookie", "s=1")
			}
		}
		status := []int{200, 200, 200, 204, 301, 404, 500}[rng.IntN(7)]

		d := cacheable(r, &http.Response{StatusCode: status, Header: h})
		if !d.ok {
			continue
		}
		// Everything below must be impossible for a cacheable response.
		if setCookie {
			t.Fatalf("cached a response with Set-Cookie: %v", h)
		}
		if authed {
			t.Fatalf("cached a response to a personalised request: %v", r.Header)
		}
		if status != http.StatusOK {
			t.Fatalf("cached status %d", status)
		}
		if vary != "" && vary != "Accept-Encoding" {
			t.Fatalf("cached with Vary: %q", vary)
		}
		joined := h.Values("Cache-Control")
		for _, bad := range []string{"private", "no-store", "no-cache"} {
			for _, v := range joined {
				if v == bad {
					t.Fatalf("cached despite Cache-Control: %s", bad)
				}
			}
		}
		if d.maxAge <= 0 {
			t.Fatalf("cached with a non-positive lifetime %v: %v", d.maxAge, joined)
		}
	}
}
