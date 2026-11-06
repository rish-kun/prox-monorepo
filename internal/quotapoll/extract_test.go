package quotapoll

import (
	"testing"
	"time"
)

func TestClassifyWindow(t *testing.T) {
	cases := map[time.Duration]string{
		0:                   "",
		-time.Hour:          "",
		3 * time.Hour:       Window5h,
		5 * time.Hour:       Window5h,
		6 * time.Hour:       Window5h,
		7 * time.Hour:       "",
		24 * time.Hour:      "",
		6 * 24 * time.Hour:  WindowWeekly,
		7 * 24 * time.Hour:  WindowWeekly,
		30 * 24 * time.Hour: WindowWeekly,
	}
	for length, want := range cases {
		if got := classifyWindow(length); got != want {
			t.Errorf("classifyWindow(%v) = %q, want %q", length, got, want)
		}
	}
}

func TestExtractClaudeUsage(t *testing.T) {
	body := []byte(`{"five_hour":{"utilization":"33.5","resets_at":"2026-10-26T15:00:00.123+00:00"},"seven_day":{"utilization":80,"resets_at":null},"seven_day_opus":{"utilization":99}}`)
	got := extractPollSamples(ProviderClaude, body, testStart)
	if len(got) != 2 {
		t.Fatalf("samples = %+v", got)
	}
	if got[0].window != Window5h || got[0].used != 33.5 || got[0].resetsAt != time.Date(2026, 10, 26, 15, 0, 0, 0, time.UTC).Unix() {
		t.Fatalf("5h = %+v", got[0])
	}
	if got[1].window != WindowWeekly || got[1].used != 80 || got[1].resetsAt != 0 {
		t.Fatalf("weekly = %+v", got[1])
	}

	if got := extractPollSamples(ProviderClaude, []byte(`{"five_hour":null,"seven_day":{"resets_at":"x"}}`), testStart); len(got) != 0 {
		t.Fatalf("missing utilization should be skipped: %+v", got)
	}
	if got := extractPollSamples(ProviderClaude, []byte(`not json`), testStart); got != nil {
		t.Fatalf("invalid body: %+v", got)
	}
}

func TestExtractCodexUsage(t *testing.T) {
	body := []byte(`{"rate_limit":{
		"primary_window":{"used_percent":"12","limit_window_seconds":"18000","reset_at":1793030400000},
		"secondary_window":{"used_percent":40.5,"limit_window_seconds":604800,"reset_after_seconds":"7200"}}}`)
	got := extractPollSamples(ProviderCodex, body, testStart)
	if len(got) != 2 {
		t.Fatalf("samples = %+v", got)
	}
	if got[0].window != Window5h || got[0].used != 12 || got[0].resetsAt != 1793030400 {
		t.Fatalf("primary = %+v", got[0])
	}
	if got[1].window != WindowWeekly || got[1].used != 40.5 || got[1].resetsAt != testStart.Unix()+7200 {
		t.Fatalf("secondary = %+v", got[1])
	}

	// A one-day window and a window without a length are ignored; a weekly primary
	// (free plans) is classified as weekly.
	body = []byte(`{"rateLimit":{"primaryWindow":{"usedPercent":5,"limitWindowSeconds":604800},"secondary_window":{"used_percent":5,"limit_window_seconds":86400}}}`)
	got = extractPollSamples(ProviderCodex, body, testStart)
	if len(got) != 1 || got[0].window != WindowWeekly || got[0].resetsAt != 0 {
		t.Fatalf("samples = %+v", got)
	}
	if got := extractPollSamples(ProviderCodex, []byte(`{"rate_limit":{"primary_window":{"used_percent":5}}}`), testStart); len(got) != 0 {
		t.Fatalf("window without length: %+v", got)
	}
	if got := extractPollSamples(ProviderCodex, []byte(`{"rate_limit":null}`), testStart); len(got) != 0 {
		t.Fatalf("null rate_limit: %+v", got)
	}
}

func TestExtractHeaderSamples(t *testing.T) {
	claude := extractHeaderSamples(ProviderClaude, map[string]string{
		"Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
		"Anthropic-Ratelimit-Unified-5h-Reset":       "1793030400",
	}, testStart)
	if len(claude) != 1 || claude[0].window != Window5h || claude[0].used < 41.99 || claude[0].used > 42.01 || claude[0].resetsAt != 1793030400 {
		t.Fatalf("claude = %+v", claude)
	}

	codexSamples := extractHeaderSamples(ProviderCodex, map[string]string{
		"X-Codex-Primary-Used-Percent":                "10",
		"X-Codex-Primary-Window-Minutes":              "10080",
		"X-Codex-Primary-Reset-After-Seconds":         "60",
		"X-Codex-Secondary-Used-Percent":              "10",
		"X-Codex-Secondary-Window-Minutes":            "1440",
		"X-Codex-Bengalfox-Primary-Used-Percent":      "99",
		"X-Codex-Bengalfox-Primary-Window-Minutes":    "300",
		"X-Codex-Additional-Foo-Primary-Used-Percent": "99",
	}, testStart)
	if len(codexSamples) != 1 || codexSamples[0].window != WindowWeekly || codexSamples[0].resetsAt != testStart.Unix()+60 {
		t.Fatalf("codex = %+v", codexSamples)
	}
	if got := extractHeaderSamples(ProviderCodex, map[string]string{"X-Codex-Primary-Used-Percent": "10"}, testStart); len(got) != 0 {
		t.Fatalf("missing window minutes: %+v", got)
	}
}

func TestThinning(t *testing.T) {
	h := newHistory()
	base := testStart.Unix()
	add := func(offset int64, used float64, resetsAt int64) bool {
		return h.add(Sample{T: base + offset, AuthIndex: "a", Provider: "claude", Window: Window5h, Used: used, ResetsAt: resetsAt}, false)
	}
	if !add(0, 10, 1000) {
		t.Fatal("first sample must be kept")
	}
	if add(300, 10.4, 1000) {
		t.Fatal("small change must be thinned")
	}
	if !add(600, 10.5, 1000) {
		t.Fatal("0.5 change must be kept")
	}
	if add(900, 10.5, 1060) {
		t.Fatal("reset drift within tolerance must be thinned")
	}
	if !add(1200, 10.5, 20000) {
		t.Fatal("reset change must be kept")
	}
	if add(1200+3599, 10.5, 20000) {
		t.Fatal("unchanged sample within an hour must be thinned")
	}
	if !add(1200+3600, 10.5, 20000) {
		t.Fatal("hourly sample must be kept")
	}
	if add(100, 90, 1000) {
		t.Fatal("out-of-order sample must be dropped")
	}
	if h.add(Sample{T: base + 99999, AuthIndex: "a", Provider: "claude", Window: "1d", Used: 1}, false) {
		t.Fatal("unknown window must be rejected")
	}
	_, samples := h.query("claude", Window5h, 0, base+99999)
	if len(samples) != 4 {
		t.Fatalf("samples = %+v", samples)
	}
	if !h.add(Sample{T: base + 99999, AuthIndex: "b", Provider: "claude", Window: Window5h, Used: 150}, false) {
		t.Fatal("new series sample must be kept")
	}
	if _, samples = h.query("claude", Window5h, base+99999, base+99999); len(samples) != 2 || samples[1].Used != 100 {
		t.Fatalf("used must be clamped: %+v", samples)
	}
}
