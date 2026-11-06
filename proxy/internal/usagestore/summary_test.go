package usagestore

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// 2025-10-09T00:00:00Z
const dayUTC int64 = 1_759_968_000

func record(at int64, provider, authIndex, model string, uncached int64) usage.Record {
	return usage.Record{
		Provider:    provider,
		AuthIndex:   authIndex,
		AuthType:    "oauth",
		Source:      authIndex + "@example.com",
		Model:       model,
		RequestedAt: time.Unix(at, 0),
		Detail:      breakdownDetail(uncached, 0, 0, 1, 0),
	}
}

func TestSummaryHourBucketsAndRange(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()
	s.HandleUsage(ctx, record(dayUTC+10, "claude", "a1", "m", 1))
	s.HandleUsage(ctx, record(dayUTC+20, "claude", "a1", "m", 2))
	s.HandleUsage(ctx, record(dayUTC+3600+5, "claude", "a1", "m", 4))
	s.HandleUsage(ctx, record(dayUTC+2*3600, "codex", "a2", "gpt", 8)) // excluded: hour == to
	s.HandleUsage(ctx, record(dayUTC-1, "codex", "a3", "gpt", 16))     // excluded: before from

	got := s.Summary(Query{From: dayUTC, To: dayUTC + 2*3600, Bucket: BucketHour})
	if got.Bucket != "hour" || got.From != dayUTC || got.To != dayUTC+2*3600 || got.FirstRecordedAt == 0 {
		t.Fatalf("header=%+v", got)
	}
	if len(got.Rows) != 2 {
		t.Fatalf("rows=%+v", got.Rows)
	}
	if got.Rows[0].Start != dayUTC || got.Rows[0].Requests != 2 || got.Rows[0].InputTokens != 3 {
		t.Fatalf("row0=%+v", got.Rows[0])
	}
	if got.Rows[1].Start != dayUTC+3600 || got.Rows[1].InputTokens != 4 {
		t.Fatalf("row1=%+v", got.Rows[1])
	}
	if len(got.Accounts) != 1 || got.Accounts["a1"] != (SummaryAccount{Provider: "claude", Label: "a1@example.com"}) {
		t.Fatalf("accounts should only include referenced credentials: %+v", got.Accounts)
	}
}

func TestSummaryDayBucketsUTC(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()
	s.HandleUsage(ctx, record(dayUTC+1*3600, "claude", "a1", "m", 1))
	s.HandleUsage(ctx, record(dayUTC+23*3600, "claude", "a1", "m", 2))
	s.HandleUsage(ctx, record(dayUTC+24*3600, "claude", "a1", "m", 4))

	got := s.Summary(Query{From: dayUTC, To: dayUTC + 3*86400, Bucket: BucketDay})
	if len(got.Rows) != 2 {
		t.Fatalf("rows=%+v", got.Rows)
	}
	if got.Rows[0].Start != dayUTC || got.Rows[0].InputTokens != 3 || got.Rows[1].Start != dayUTC+86400 || got.Rows[1].InputTokens != 4 {
		t.Fatalf("rows=%+v", got.Rows)
	}
}

func TestSummaryDayBucketsWithTZOffset(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()
	// IST (UTC+5:30): local midnight of 2025-10-09 is dayUTC - 5.5h.
	const ist = 330
	localMidnight := dayUTC - 330*60
	s.HandleUsage(ctx, record(dayUTC-6*3600, "claude", "a1", "m", 1))  // 23:30 local on Oct 8
	s.HandleUsage(ctx, record(dayUTC-5*3600, "claude", "a1", "m", 2))  // hour 19:00Z -> 00:30 local Oct 9
	s.HandleUsage(ctx, record(dayUTC+18*3600, "claude", "a1", "m", 4)) // 23:30 local Oct 9
	s.HandleUsage(ctx, record(dayUTC+19*3600, "claude", "a1", "m", 8)) // 00:30 local Oct 10

	got := s.Summary(Query{From: dayUTC - 2*86400, To: dayUTC + 2*86400, Bucket: BucketDay, TZOffsetMinutes: ist})
	if got.TZOffsetMinutes != ist {
		t.Fatalf("tz=%d", got.TZOffsetMinutes)
	}
	want := []struct{ start, input int64 }{
		{localMidnight - 86400, 1},
		{localMidnight, 6},
		{localMidnight + 86400, 8},
	}
	if len(got.Rows) != len(want) {
		t.Fatalf("rows=%+v", got.Rows)
	}
	for i, w := range want {
		if got.Rows[i].Start != w.start || got.Rows[i].InputTokens != w.input {
			t.Errorf("row %d=%+v want start=%d input=%d", i, got.Rows[i], w.start, w.input)
		}
	}

	// Negative offset (UTC-7): local midnight is dayUTC + 7h.
	got = s.Summary(Query{From: dayUTC - 2*86400, To: dayUTC + 2*86400, Bucket: BucketDay, TZOffsetMinutes: -420})
	for _, row := range got.Rows {
		if (row.Start-(dayUTC+7*3600))%86400 != 0 {
			t.Errorf("row start %d is not a UTC-7 local midnight", row.Start)
		}
	}
}

func TestSummaryKeepsKeyDimensionsSeparate(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()
	s.HandleUsage(ctx, record(dayUTC, "claude", "a1", "m", 1))
	s.HandleUsage(ctx, record(dayUTC, "claude", "a1", "m", 200_000)) // tier 1
	s.HandleUsage(ctx, record(dayUTC, "claude", "a1", "m2", 1))
	s.HandleUsage(ctx, record(dayUTC, "claude", "a2", "m", 1))
	s.HandleUsage(ctx, record(dayUTC, "codex", "a1", "m", 1))
	got := s.Summary(Query{From: dayUTC, To: dayUTC + 86400, Bucket: BucketDay})
	if len(got.Rows) != 5 {
		t.Fatalf("rows=%+v", got.Rows)
	}
	// Sorted by start, provider, auth_index, model, prompt_tier.
	if got.Rows[0].Model != "m" || got.Rows[0].PromptTier != 0 || got.Rows[1].PromptTier != 1 || got.Rows[2].Model != "m2" || got.Rows[4].Provider != "codex" {
		t.Fatalf("order=%+v", got.Rows)
	}
}

func TestSummaryJSONContract(t *testing.T) {
	s, _ := newTestStore(t)
	empty := s.Summary(Query{From: 0, To: 10, Bucket: "weird"})
	raw, errMarshal := json.Marshal(empty)
	if errMarshal != nil {
		t.Fatal(errMarshal)
	}
	var decoded map[string]any
	if errUnmarshal := json.Unmarshal(raw, &decoded); errUnmarshal != nil {
		t.Fatal(errUnmarshal)
	}
	if decoded["bucket"] != "hour" {
		t.Fatalf("bucket=%v", decoded["bucket"])
	}
	if rows, ok := decoded["rows"].([]any); !ok || len(rows) != 0 {
		t.Fatalf("rows must be an empty array: %s", raw)
	}
	if accounts, ok := decoded["accounts"].(map[string]any); !ok || len(accounts) != 0 {
		t.Fatalf("accounts must be an empty object: %s", raw)
	}
	for _, field := range []string{"from", "to", "bucket", "tz_offset_minutes", "first_recorded_at"} {
		if _, ok := decoded[field]; !ok {
			t.Errorf("missing %q", field)
		}
	}

	s.HandleUsage(context.Background(), record(dayUTC, "claude", "a1", "m", 1))
	raw, _ = json.Marshal(s.Summary(Query{From: dayUTC, To: dayUTC + 3600}))
	decoded = nil
	_ = json.Unmarshal(raw, &decoded)
	row := decoded["rows"].([]any)[0].(map[string]any)
	for _, field := range []string{"start", "provider", "auth_index", "model", "prompt_tier", "requests", "failed", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens", "unclassified_tokens"} {
		if _, ok := row[field]; !ok {
			t.Errorf("row missing %q: %s", field, raw)
		}
	}
	account := decoded["accounts"].(map[string]any)["a1"].(map[string]any)
	if account["provider"] != "claude" || account["label"] != "a1@example.com" || len(account) != 2 {
		t.Fatalf("account=%v", account)
	}
}

func TestSummaryNilStore(t *testing.T) {
	var s *Store
	got := s.Summary(Query{From: 1, To: 2, Bucket: BucketDay})
	if got.Rows == nil || got.Accounts == nil || got.Bucket != BucketDay {
		t.Fatalf("got=%+v", got)
	}
}
