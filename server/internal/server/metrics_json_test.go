package server

import (
	"encoding/json"
	"strings"
	"testing"
)

// The cache counters reach /metrics.json. MetricsSnapshot embeds two structs,
// and encoding/json silently drops BOTH sides of a name collision at the same
// depth — so a field added to either half could take a counter off the wire
// with no error anywhere.
func TestMetricsSnapshotCarriesTheCacheCounters(t *testing.T) {
	b, err := json.Marshal(MetricsSnapshot{})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{
		"cache_bytes", "cache_entries", "cache_capacity", "cache_hits",
		"cache_misses", "cache_evictions", "cache_expired", "cache_stores", "cache_too_large",
		"rpcs", "data_bytes", "ungranted_bytes_sent", // the sender half must survive too
	} {
		if _, ok := got[k]; !ok {
			t.Errorf("%s missing from /metrics.json; fields: %s", k, strings.Join(keys(got), " "))
		}
	}
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
