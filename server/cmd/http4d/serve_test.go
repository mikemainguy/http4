package main

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseServeDefaults(t *testing.T) {
	site := t.TempDir()
	var out bytes.Buffer
	cfg, err := parseServe([]string{site}, &out)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SiteDir != site || cfg.HTTPAddr != "127.0.0.1:8080" || cfg.WTAddr != "127.0.0.1:4433" || !cfg.NoH3 || cfg.ClientFS == nil {
		t.Errorf("defaults: %+v", cfg)
	}
}

func TestParseServeFlags(t *testing.T) {
	site, client := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(client, "http4.js"), []byte("export {}"), 0o644)
	cfg, err := parseServe([]string{"-http", "127.0.0.1:0", "-wt", "127.0.0.1:0", "-h3", "-client-dir", client, "-drop", "every=5", site}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NoH3 || cfg.DropSpec != "every=5" || cfg.HTTPAddr != "127.0.0.1:0" {
		t.Errorf("flags not applied: %+v", cfg)
	}
}

func TestParseServeRejects(t *testing.T) {
	site := t.TempDir()
	file := filepath.Join(site, "f")
	os.WriteFile(file, nil, 0o644)
	for name, args := range map[string][]string{
		"no site":             {},
		"two sites":           {site, site},
		"flag after site":     {site, "-h3"},
		"site is a file":      {file},
		"unknown cert mode":   {"-cert", "acme", site},
		"client-dir no entry": {"-client-dir", t.TempDir(), site},
	} {
		if _, err := parseServe(args, &bytes.Buffer{}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParseServeHelpGroupsTestingFlags(t *testing.T) {
	var out bytes.Buffer
	if _, err := parseServe([]string{"-h"}, &out); err != flag.ErrHelp {
		t.Fatalf("err = %v, want flag.ErrHelp", err)
	}
	usage := out.String()
	testing := strings.Index(usage, "Testing only:")
	if !strings.HasPrefix(usage, "Usage: http4d serve") || testing < 0 {
		t.Fatalf("usage:\n%s", usage)
	}
	for _, f := range []string{"-http", "-wt", "-cert", "-h3", "-client-dir"} {
		if i := flagLine(usage, f); i < 0 || i > testing {
			t.Errorf("%s missing from the main flags", f)
		}
	}
	for _, f := range []string{"-drop", "-advertise-wt"} {
		if i := flagLine(usage, f); i < testing {
			t.Errorf("%s not under Testing only", f)
		}
	}
}

// flagLine is the offset of the usage line for flag f, or -1.
func flagLine(usage, f string) int {
	for _, end := range []string{" ", "\n"} {
		if i := strings.Index(usage, "\n  "+f+end); i >= 0 {
			return i
		}
	}
	return -1
}
