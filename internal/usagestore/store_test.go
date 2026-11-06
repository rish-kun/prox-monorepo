package usagestore

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// fixedClock is a controllable clock for tests.
type fixedClock struct{ t time.Time }

func (c *fixedClock) now() time.Time { return c.t }

func newTestStore(t *testing.T) (*Store, *fixedClock) {
	t.Helper()
	clock := &fixedClock{t: time.Unix(1_760_000_000, 0).UTC()}
	s, errNew := newStore(filepath.Join(t.TempDir(), "usage", "hourly.json"), clock.now)
	if errNew != nil {
		t.Fatalf("newStore: %v", errNew)
	}
	return s, clock
}

// breakdownDetail builds a Detail with a valid canonical breakdown.
func breakdownDetail(uncached, cacheRead, cacheWrite, output, reasoning int64) usage.Detail {
	input := uncached + cacheRead + cacheWrite
	return usage.Detail{TokenBreakdown: usage.TokenBreakdown{
		SchemaVersion: usage.TokenAccountingSchemaVersion,
		Quality:       usage.TokenAccountingQualityComplete,
		TotalTokens:   input + output,
		Input: usage.TokenInputBreakdown{
			TotalTokens:      input,
			UncachedTokens:   uncached,
			CacheReadTokens:  cacheRead,
			CacheWriteTokens: cacheWrite,
		},
		Output: usage.TokenOutputBreakdown{
			TotalTokens:        output,
			NonReasoningTokens: output - reasoning,
			ReasoningTokens:    reasoning,
		},
	}}
}

func rowsOf(s *Store) map[rowKey]Counters {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[rowKey]Counters, len(s.rows))
	for k, v := range s.rows {
		out[k] = *v
	}
	return out
}

func TestHandleUsageAggregatesByHourAndKey(t *testing.T) {
	s, _ := newTestStore(t)
	base := time.Unix(1_760_000_400, 0)
	hour := hourStart(base.Unix())
	if hour != 1_760_000_400 {
		t.Fatalf("hourStart=%d", hour)
	}
	rec := usage.Record{
		Provider:    "Claude",
		AuthIndex:   "a1",
		Model:       "claude-opus-5-5",
		RequestedAt: base,
		Detail:      breakdownDetail(100, 1000, 50, 30, 10),
	}
	s.HandleUsage(context.Background(), rec)
	rec.RequestedAt = base.Add(10 * time.Minute)
	rec.Failed = true
	s.HandleUsage(context.Background(), rec)
	// Different hour.
	rec.RequestedAt = time.Unix(hour+3600, 0)
	rec.Failed = false
	s.HandleUsage(context.Background(), rec)
	// Different model and auth index in the first hour.
	s.HandleUsage(context.Background(), usage.Record{Provider: "claude", AuthIndex: "a2", Model: "claude-haiku-5-5", RequestedAt: base, Detail: breakdownDetail(1, 0, 0, 1, 0)})

	rows := rowsOf(s)
	if len(rows) != 3 {
		t.Fatalf("rows=%d want 3: %+v", len(rows), rows)
	}
	got := rows[rowKey{hour: hour, provider: "claude", authIndex: "a1", model: "claude-opus-5-5"}]
	want := Counters{Requests: 2, Failed: 1, InputTokens: 200, CacheReadTokens: 2000, CacheWriteTokens: 100, OutputTokens: 60, ReasoningTokens: 20}
	if got != want {
		t.Fatalf("first hour counters=%+v want %+v", got, want)
	}
	next := rows[rowKey{hour: hour + 3600, provider: "claude", authIndex: "a1", model: "claude-opus-5-5"}]
	if next.Requests != 1 || next.InputTokens != 100 {
		t.Fatalf("second hour counters=%+v", next)
	}
	if !s.dirty {
		t.Fatal("store should be dirty after HandleUsage")
	}
}

func TestHandleUsageRawProviderDetail(t *testing.T) {
	s, _ := newTestStore(t)
	s.HandleUsage(context.Background(), usage.Record{
		Provider:    "claude",
		Model:       "claude-sonnet-5-5",
		RequestedAt: time.Unix(1_760_000_000, 0),
		Detail:      usage.Detail{InputTokens: 1000, CacheReadTokens: 500, CacheCreationTokens: 200, OutputTokens: 300},
	})
	breakdown := usage.EnsureTokenBreakdownForProvider(usage.Detail{InputTokens: 1000, CacheReadTokens: 500, CacheCreationTokens: 200, OutputTokens: 300}, "claude", "").TokenBreakdown
	for _, c := range rowsOf(s) {
		if c.InputTokens != breakdown.Input.UncachedTokens || c.CacheReadTokens != breakdown.Input.CacheReadTokens ||
			c.CacheWriteTokens != breakdown.Input.CacheWriteTokens || c.OutputTokens != breakdown.Output.TotalTokens {
			t.Fatalf("counters=%+v breakdown=%+v", c, breakdown)
		}
		if c.InputTokens+c.CacheReadTokens+c.CacheWriteTokens != 1700 || c.OutputTokens != 300 {
			t.Fatalf("unexpected prompt/output split: %+v", c)
		}
	}
}

func TestHandleUsageModelFallbackAndDefaults(t *testing.T) {
	s, clock := newTestStore(t)
	ctx := context.Background()
	s.HandleUsage(ctx, usage.Record{Provider: "codex", ResponseModel: "gpt-resp", Alias: "alias"})
	s.HandleUsage(ctx, usage.Record{Provider: "codex", Alias: " alias "})
	s.HandleUsage(ctx, usage.Record{})
	hour := hourStart(clock.t.Unix()) // zero RequestedAt falls back to the clock
	rows := rowsOf(s)
	for _, key := range []rowKey{
		{hour: hour, provider: "codex", model: "gpt-resp"},
		{hour: hour, provider: "codex", model: "alias"},
		{hour: hour, provider: "unknown", model: "unknown"},
	} {
		if rows[key].Requests != 1 {
			t.Errorf("missing row %+v in %+v", key, rows)
		}
	}
}

func TestHandleUsageSkipsNonGenerate(t *testing.T) {
	s, _ := newTestStore(t)
	s.dirty = false
	s.HandleUsage(context.Background(), usage.Record{Provider: "claude", Model: "m", Generate: usage.GenerateFlag(false), Detail: breakdownDetail(5, 0, 0, 0, 0)})
	if len(rowsOf(s)) != 0 || s.dirty {
		t.Fatal("count-tokens style record should be skipped")
	}
	s.HandleUsage(context.Background(), usage.Record{Provider: "claude", Model: "m", Generate: usage.GenerateFlag(true)})
	if len(rowsOf(s)) != 1 {
		t.Fatal("explicit generate=true should be recorded")
	}
}

func TestHandleUsageLabelsOnlyOAuth(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()
	at := time.Unix(1_760_000_000, 0)
	s.HandleUsage(ctx, usage.Record{Provider: "Claude", AuthIndex: "oauth1", AuthType: "oauth", Source: "user@example.com", RequestedAt: at})
	s.HandleUsage(ctx, usage.Record{Provider: "claude", AuthIndex: "key1", AuthType: "apikey", Source: "sk-secret", APIKey: "sk-client", RequestedAt: at})
	s.HandleUsage(ctx, usage.Record{Provider: "claude", AuthIndex: "unk1", AuthType: "", Source: "sk-maybe", RequestedAt: at})
	s.HandleUsage(ctx, usage.Record{Provider: "claude", AuthIndex: "", AuthType: "oauth", Source: "nobody@example.com", RequestedAt: at})

	if got := s.accounts["oauth1"]; got.Label != "user@example.com" || got.Provider != "claude" || got.LastSeen != at.Unix() {
		t.Fatalf("oauth account=%+v", got)
	}
	if got := s.accounts["key1"]; got.Label != "" || got.Provider != "claude" {
		t.Fatalf("api key account must not have a label: %+v", got)
	}
	if got := s.accounts["unk1"]; got.Label != "" {
		t.Fatalf("unknown auth type must not have a label: %+v", got)
	}
	if _, ok := s.accounts[""]; ok {
		t.Fatal("empty auth index must not create an account")
	}
	if errFlush := s.Flush(); errFlush != nil {
		t.Fatal(errFlush)
	}
	raw, errRead := os.ReadFile(s.path)
	if errRead != nil {
		t.Fatal(errRead)
	}
	for _, secret := range []string{"sk-secret", "sk-client", "sk-maybe"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("persisted file leaks %q: %s", secret, raw)
		}
	}
	// A later API-key style record never overwrites an OAuth label with a key.
	s.HandleUsage(ctx, usage.Record{Provider: "claude", AuthIndex: "oauth1", AuthType: "apikey", Source: "sk-x", RequestedAt: at.Add(time.Hour)})
	if got := s.accounts["oauth1"]; got.Label != "user@example.com" || got.LastSeen != at.Add(time.Hour).Unix() {
		t.Fatalf("oauth account after api-key record=%+v", got)
	}
}

func TestPromptTierThresholds(t *testing.T) {
	cases := []struct {
		uncached, cacheRead, cacheWrite int64
		want                            int
	}{
		{0, 0, 0, 0},
		{100_000, 0, 0, 0},
		{100_001, 0, 0, 1},
		{1, 99_999, 1, 1},     // 100,001 across all three input buckets
		{0, 99_000, 1_000, 0}, // exactly 100,000
		{272_000, 0, 0, 1},
		{272_001, 0, 0, 2},
		{2_000, 270_000, 1, 2}, // 272,001
		{1_000_000, 0, 0, 2},
	}
	for _, tc := range cases {
		s, _ := newTestStore(t)
		s.HandleUsage(context.Background(), usage.Record{Provider: "p", Model: "m", RequestedAt: time.Unix(0, 0), Detail: breakdownDetail(tc.uncached, tc.cacheRead, tc.cacheWrite, 10, 0)})
		rows := rowsOf(s)
		if len(rows) != 1 {
			t.Fatalf("rows=%d", len(rows))
		}
		for key := range rows {
			if key.promptTier != tc.want {
				t.Errorf("prompt %d+%d+%d tier=%d want %d", tc.uncached, tc.cacheRead, tc.cacheWrite, key.promptTier, tc.want)
			}
		}
	}
	// Output tokens never affect the tier.
	if promptTier(100_000) != 0 || promptTier(100_001) != 1 || promptTier(272_000) != 1 || promptTier(272_001) != 2 {
		t.Fatal("promptTier boundaries")
	}
}

func TestPromptTierSplitsRows(t *testing.T) {
	s, _ := newTestStore(t)
	at := time.Unix(1_760_000_000, 0)
	for _, prompt := range []int64{10, 150_000, 300_000, 20} {
		s.HandleUsage(context.Background(), usage.Record{Provider: "codex", AuthIndex: "a", Model: "gpt", RequestedAt: at, Detail: breakdownDetail(prompt, 0, 0, 1, 0)})
	}
	rows := rowsOf(s)
	if len(rows) != 3 {
		t.Fatalf("rows=%d want 3", len(rows))
	}
	hour := hourStart(at.Unix())
	if rows[rowKey{hour: hour, provider: "codex", authIndex: "a", model: "gpt", promptTier: 0}].Requests != 2 {
		t.Fatalf("tier 0 should merge two requests: %+v", rows)
	}
}

func TestPersistenceRoundTrip(t *testing.T) {
	s, clock := newTestStore(t)
	at := time.Unix(1_760_000_000, 0)
	s.HandleUsage(context.Background(), usage.Record{Provider: "claude", AuthIndex: "a1", AuthType: "oauth", Source: "u@example.com", Model: "m1", RequestedAt: at, Failed: true, Detail: breakdownDetail(10, 20, 30, 40, 5)})
	s.HandleUsage(context.Background(), usage.Record{Provider: "codex", AuthIndex: "a2", Model: "m2", RequestedAt: at, Detail: breakdownDetail(300_000, 0, 0, 1, 0)})
	if errFlush := s.Flush(); errFlush != nil {
		t.Fatal(errFlush)
	}
	if s.dirty {
		t.Fatal("flush should clear dirty")
	}

	info, errStat := os.Stat(s.path)
	if errStat != nil {
		t.Fatal(errStat)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file perm=%o want 600", perm)
	}
	dirInfo, errStatDir := os.Stat(filepath.Dir(s.path))
	if errStatDir != nil {
		t.Fatal(errStatDir)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Fatalf("dir perm=%o want 700", perm)
	}
	entries, errReadDir := os.ReadDir(filepath.Dir(s.path))
	if errReadDir != nil {
		t.Fatal(errReadDir)
	}
	if len(entries) != 1 || entries[0].Name() != "hourly.json" {
		t.Fatalf("unexpected files after atomic write: %v", entries)
	}

	var data map[string]any
	raw, _ := os.ReadFile(s.path)
	if errUnmarshal := json.Unmarshal(raw, &data); errUnmarshal != nil {
		t.Fatal(errUnmarshal)
	}
	if data["version"] != float64(1) || data["first_recorded_at"] != float64(clock.t.Unix()) {
		t.Fatalf("header=%v", data)
	}
	firstRow := data["rows"].([]any)[0].(map[string]any)
	for _, field := range []string{"hour", "provider", "auth_index", "model", "prompt_tier", "requests", "failed", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens", "unclassified_tokens"} {
		if _, ok := firstRow[field]; !ok {
			t.Errorf("row missing field %q: %v", field, firstRow)
		}
	}

	clock.t = clock.t.Add(48 * time.Hour)
	reloaded, errNew := newStore(s.path, clock.now)
	if errNew != nil {
		t.Fatal(errNew)
	}
	if reloaded.firstRecordedAt != s.firstRecordedAt {
		t.Fatalf("first_recorded_at=%d want %d", reloaded.firstRecordedAt, s.firstRecordedAt)
	}
	if got, want := rowsOf(reloaded), rowsOf(s); len(got) != len(want) {
		t.Fatalf("rows=%v want %v", got, want)
	} else {
		for k, v := range want {
			if got[k] != v {
				t.Fatalf("row %+v=%+v want %+v", k, got[k], v)
			}
		}
	}
	if reloaded.accounts["a1"] != s.accounts["a1"] || reloaded.accounts["a2"] != s.accounts["a2"] {
		t.Fatalf("accounts=%v want %v", reloaded.accounts, s.accounts)
	}
	if reloaded.dirty {
		t.Fatal("freshly loaded store should not be dirty")
	}
	// Flushing a clean store is a no-op.
	if errFlush := reloaded.Flush(); errFlush != nil {
		t.Fatal(errFlush)
	}
}

func TestFlushFailureKeepsDirtyAndOriginalFile(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "usage")
	clock := &fixedClock{t: time.Unix(1_760_000_000, 0)}
	s, errNew := newStore(filepath.Join(blocker, "hourly.json"), clock.now)
	if errNew != nil {
		t.Fatal(errNew)
	}
	// Occupy the usage directory path with a regular file so the write fails.
	if errWrite := os.WriteFile(blocker, []byte("not a dir"), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	s.HandleUsage(context.Background(), usage.Record{Provider: "p", Model: "m"})
	if errFlush := s.Flush(); errFlush == nil {
		t.Fatal("expected flush to fail when the usage dir is a file")
	}
	if !s.dirty {
		t.Fatal("failed flush must keep the store dirty")
	}
	if raw, _ := os.ReadFile(blocker); string(raw) != "not a dir" {
		t.Fatal("failed flush must not touch existing files")
	}
}

func TestAtomicWriteReplacesExistingFile(t *testing.T) {
	s, _ := newTestStore(t)
	s.HandleUsage(context.Background(), usage.Record{Provider: "p", Model: "m1"})
	if errFlush := s.Flush(); errFlush != nil {
		t.Fatal(errFlush)
	}
	s.HandleUsage(context.Background(), usage.Record{Provider: "p", Model: "m2"})
	if errFlush := s.Flush(); errFlush != nil {
		t.Fatal(errFlush)
	}
	raw, _ := os.ReadFile(s.path)
	if !strings.Contains(string(raw), `"m1"`) || !strings.Contains(string(raw), `"m2"`) {
		t.Fatalf("file=%s", raw)
	}
	entries, _ := os.ReadDir(filepath.Dir(s.path))
	if len(entries) != 1 {
		t.Fatalf("leftover temp files: %v", entries)
	}
}

func TestCorruptFileRecovery(t *testing.T) {
	for name, content := range map[string]string{
		"garbage":     "{not json",
		"bad version": `{"version":99,"rows":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "usage")
			if errMkdir := os.MkdirAll(dir, 0o700); errMkdir != nil {
				t.Fatal(errMkdir)
			}
			path := filepath.Join(dir, "hourly.json")
			if errWrite := os.WriteFile(path, []byte(content), 0o600); errWrite != nil {
				t.Fatal(errWrite)
			}
			clock := &fixedClock{t: time.Unix(1_760_000_123, 0)}
			s, errNew := newStore(path, clock.now)
			if errNew != nil {
				t.Fatalf("corrupt file must not fail open: %v", errNew)
			}
			if len(rowsOf(s)) != 0 || s.firstRecordedAt != clock.t.Unix() {
				t.Fatalf("store should start empty: rows=%v first=%d", rowsOf(s), s.firstRecordedAt)
			}
			corrupt := path + ".corrupt-1760000123"
			raw, errRead := os.ReadFile(corrupt)
			if errRead != nil || string(raw) != content {
				t.Fatalf("corrupt file not preserved: %v %q", errRead, raw)
			}
			if _, errStat := os.Stat(path); !os.IsNotExist(errStat) {
				t.Fatalf("original path should be moved aside: %v", errStat)
			}
		})
	}
}

func TestMissingFileStartsEmptyAndDirty(t *testing.T) {
	s, clock := newTestStore(t)
	if len(rowsOf(s)) != 0 || s.firstRecordedAt != clock.t.Unix() || !s.dirty {
		t.Fatalf("rows=%v first=%d dirty=%v", rowsOf(s), s.firstRecordedAt, s.dirty)
	}
}

func TestOpenCloseFlushes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage", "hourly.json")
	s, errOpen := Open(path)
	if errOpen != nil {
		t.Fatal(errOpen)
	}
	s.HandleUsage(context.Background(), usage.Record{Provider: "p", Model: "m"})
	if errClose := s.Close(); errClose != nil {
		t.Fatal(errClose)
	}
	if errClose := s.Close(); errClose != nil {
		t.Fatalf("second close: %v", errClose)
	}
	raw, errRead := os.ReadFile(path)
	if errRead != nil || !strings.Contains(string(raw), `"model":"m"`) {
		t.Fatalf("close did not flush: %v %s", errRead, raw)
	}
}

func TestPathForConfig(t *testing.T) {
	got := PathForConfig("/home/u/.cli-proxy-api/config.yaml")
	if got != filepath.Join("/home/u/.cli-proxy-api", "usage", "hourly.usage") {
		t.Fatalf("path=%s", got)
	}
}

func TestDefault(t *testing.T) {
	prev := Default()
	t.Cleanup(func() { SetDefault(prev) })
	s, _ := newTestStore(t)
	SetDefault(s)
	if Default() != s {
		t.Fatal("Default should return the installed store")
	}
	SetDefault(nil)
	if Default() != nil {
		t.Fatal("Default should be nil after clearing")
	}
}

func TestOpenMigratesLegacyJSONFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "usage")
	if errMkdir := os.MkdirAll(dir, 0o700); errMkdir != nil {
		t.Fatal(errMkdir)
	}
	legacy := filepath.Join(dir, "hourly.json")
	data := `{"version":1,"first_recorded_at":100,"rows":[{"hour":3600,"provider":"claude","auth_index":"a","model":"m","prompt_tier":0,"requests":7}],"accounts":{}}`
	if errWrite := os.WriteFile(legacy, []byte(data), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	s, errOpen := Open(filepath.Join(dir, "hourly.usage"))
	if errOpen != nil {
		t.Fatal(errOpen)
	}
	defer func() { _ = s.Close() }()
	if _, errStat := os.Stat(legacy); !os.IsNotExist(errStat) {
		t.Fatalf("legacy hourly.json should be gone, stat err = %v", errStat)
	}
	if s.firstRecordedAt != 100 || len(s.rows) != 1 {
		t.Fatalf("migrated data not loaded: first=%d rows=%d", s.firstRecordedAt, len(s.rows))
	}
}
