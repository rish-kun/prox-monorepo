package management

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quotapoll"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func newQuotaBurstTestHandler(t *testing.T, now time.Time) *Handler {
	t.Helper()
	coreauth.SetPriorityOverrides(nil)
	t.Cleanup(func() { coreauth.SetPriorityOverrides(nil) })
	manager := coreauth.NewManager(nil, nil, nil)
	running := &coreauth.Auth{
		ID: "burst-claude-running", Index: "running-idx", Provider: "claude",
		Attributes: map[string]string{"auth_kind": "oauth", "priority": "2"},
		Metadata:   map[string]any{"email": "running@example.com"},
		Quota: coreauth.QuotaState{ObservedAt: now, Signals: map[string]string{
			"Anthropic-Ratelimit-Unified-5h-Utilization": "0.25",
			"Anthropic-Ratelimit-Unified-5h-Reset":       strconv.FormatInt(now.Add(90*time.Minute).Unix(), 10),
			"Anthropic-Ratelimit-Unified-7d-Utilization": "0.4",
			"Anthropic-Ratelimit-Unified-7d-Reset":       strconv.FormatInt(now.Add(72*time.Hour).Unix(), 10),
		}},
	}
	idle := &coreauth.Auth{
		ID: "burst-claude-idle", Index: "idle-idx", Provider: "claude",
		Attributes: map[string]string{"auth_kind": "oauth"},
		Metadata:   map[string]any{"email": "idle@example.com"},
	}
	gemini := &coreauth.Auth{ID: "burst-gemini", Index: "gemini-idx", Provider: "gemini", Attributes: map[string]string{"api_key": "k"}}
	for _, auth := range []*coreauth.Auth{running, idle, gemini} {
		if _, errRegister := manager.Register(coreauth.WithSkipPersist(context.Background()), auth); errRegister != nil {
			t.Fatalf("register: %v", errRegister)
		}
	}
	h := &Handler{authManager: manager, cfg: &config.Config{}}
	svc := quotapoll.New(quotapoll.Options{
		Fetcher:                &stubQuotaFetcher{},
		Auths:                  h.QuotaPollAuths,
		Now:                    func() time.Time { return now },
		ApplyPriorityOverrides: h.ApplyRoutingPriorityOverrides,
	})
	h.SetQuotaPoll(svc)
	return h
}

func TestQuotaBurstEndpoints(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	h := newQuotaBurstTestHandler(t, now)

	rec := serveQuota(t, h, http.MethodGet, "/v8/management/quota/burst", "", (*Handler).GetQuotaBursts)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"bursts":[]}` {
		t.Fatalf("empty list = %d %s", rec.Code, rec.Body.String())
	}

	for _, tc := range []struct {
		body   string
		status int
		err    string
	}{
		{`{`, http.StatusBadRequest, "invalid body"},
		{`{}`, http.StatusBadRequest, "auth_index is required"},
		{`{"auth_index":"nope"}`, http.StatusNotFound, "credential nope not found"},
		{`{"auth_index":"gemini-idx"}`, http.StatusBadRequest, "only Claude or Codex OAuth accounts can be prioritised"},
		{`{"auth_index":"idle-idx"}`, http.StatusConflict, "no running 5-hour window"},
		{`{"auth_index":"idle-idx","kind":"weekly"}`, http.StatusConflict, "no running weekly window"},
		{`{"auth_index":"running-idx","kind":"monthly"}`, http.StatusBadRequest, `kind must be "5h" or "weekly"`},
	} {
		rec := serveQuota(t, h, http.MethodPost, "/v8/management/quota/burst", tc.body, (*Handler).PrioritiseQuotaBurst)
		if rec.Code != tc.status {
			t.Fatalf("POST %s = %d %s, want %d", tc.body, rec.Code, rec.Body.String(), tc.status)
		}
		if got := decodeJSON(t, rec)["error"]; got != tc.err {
			t.Fatalf("POST %s error = %v, want %q", tc.body, got, tc.err)
		}
	}

	want := `{"bursts":[{"auth_index":"running-idx","provider":"claude","label":"running@example.com","started_at":"2026-10-28T12:00:00Z","ends_at":"2026-10-28T13:30:00Z","order":1,"kind":"5h"}]}`
	rec = serveQuota(t, h, http.MethodPost, "/v8/management/quota/burst", `{"auth_index":"running-idx"}`, (*Handler).PrioritiseQuotaBurst)
	if rec.Code != http.StatusOK || rec.Body.String() != want {
		t.Fatalf("POST running = %d %s", rec.Code, rec.Body.String())
	}
	if got := coreauth.PriorityOverrides()["burst-claude-running"]; got != quotapoll.BurstPriorityBase-1 {
		t.Fatalf("routing override = %d", got)
	}
	rec = serveQuota(t, h, http.MethodPost, "/v8/management/quota/burst", `{"auth_index":"running-idx"}`, (*Handler).PrioritiseQuotaBurst)
	if rec.Code != http.StatusOK || rec.Body.String() != want {
		t.Fatalf("POST again = %d %s", rec.Code, rec.Body.String())
	}
	rec = serveQuota(t, h, http.MethodGet, "/v8/management/quota/burst", "", (*Handler).GetQuotaBursts)
	if rec.Code != http.StatusOK || rec.Body.String() != want {
		t.Fatalf("GET = %d %s", rec.Code, rec.Body.String())
	}

	// The weekly kind replaces the 5-hour burst and lasts until the weekly reset.
	wantWeekly := `{"bursts":[{"auth_index":"running-idx","provider":"claude","label":"running@example.com","started_at":"2026-10-28T12:00:00Z","ends_at":"2026-10-31T12:00:00Z","order":1,"kind":"weekly"}]}`
	rec = serveQuota(t, h, http.MethodPost, "/v8/management/quota/burst", `{"auth_index":"running-idx","kind":"weekly"}`, (*Handler).PrioritiseQuotaBurst)
	if rec.Code != http.StatusOK || rec.Body.String() != wantWeekly {
		t.Fatalf("POST weekly = %d %s", rec.Code, rec.Body.String())
	}

	rec = serveQuota(t, h, http.MethodDelete, "/v8/management/quota/burst", "", (*Handler).CancelQuotaBurst)
	if rec.Code != http.StatusBadRequest || decodeJSON(t, rec)["error"] != "auth_index is required" {
		t.Fatalf("DELETE without index = %d %s", rec.Code, rec.Body.String())
	}
	rec = serveQuota(t, h, http.MethodDelete, "/v8/management/quota/burst?auth_index=running-idx", "", (*Handler).CancelQuotaBurst)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"bursts":[]}` {
		t.Fatalf("DELETE = %d %s", rec.Code, rec.Body.String())
	}
	if _, ok := coreauth.PriorityOverrides()["burst-claude-running"]; ok {
		t.Fatal("routing override survived cancel")
	}
	rec = serveQuota(t, h, http.MethodDelete, "/v8/management/quota/burst?auth_index=running-idx", "", (*Handler).CancelQuotaBurst)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"bursts":[]}` {
		t.Fatalf("DELETE absent = %d %s", rec.Code, rec.Body.String())
	}
}

func TestQuotaBurstEndpointsUnavailableWithoutService(t *testing.T) {
	h := &Handler{}
	if rec := serveQuota(t, h, http.MethodGet, "/v8/management/quota/burst", "", (*Handler).GetQuotaBursts); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET = %d", rec.Code)
	}
	if rec := serveQuota(t, h, http.MethodPost, "/v8/management/quota/burst", `{"auth_index":"x"}`, (*Handler).PrioritiseQuotaBurst); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("POST = %d", rec.Code)
	}
	if rec := serveQuota(t, h, http.MethodDelete, "/v8/management/quota/burst?auth_index=x", "", (*Handler).CancelQuotaBurst); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("DELETE = %d", rec.Code)
	}
}
