package management

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quotapoll"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type stubQuotaFetcher struct {
	mu    sync.Mutex
	calls []string
}

func (f *stubQuotaFetcher) Do(_ context.Context, authIndex, _ string, url string, _ map[string]string) (quotapoll.FetchResponse, error) {
	f.mu.Lock()
	f.calls = append(f.calls, authIndex+" "+url)
	f.mu.Unlock()
	if strings.Contains(url, "api/oauth/usage") {
		return quotapoll.FetchResponse{StatusCode: http.StatusOK, Body: []byte(`{"five_hour":{"utilization":10,"resets_at":"2026-10-26T15:00:00Z"}}`)}, nil
	}
	return quotapoll.FetchResponse{StatusCode: http.StatusOK, Body: []byte(`plain text`)}, nil
}

func newQuotaTestHandler(t *testing.T) (*Handler, *stubQuotaFetcher) {
	t.Helper()
	manager := coreauth.NewManager(nil, nil, nil)
	for _, auth := range []*coreauth.Auth{
		{ID: "claude-a", Index: "claude-a-idx", Provider: "claude", Attributes: map[string]string{"auth_kind": "oauth", "priority": "3"}, Metadata: map[string]any{"email": "a@example.com", "access_token": "tok-a"}},
		{ID: "codex-b", Index: "codex-b-idx", Provider: "codex", Attributes: map[string]string{"auth_kind": "oauth"}, Metadata: map[string]any{"email": "b@example.com", "access_token": "tok-b"}},
		{ID: "gemini-c", Index: "gemini-c-idx", Provider: "gemini", Attributes: map[string]string{"api_key": "k"}},
	} {
		if _, errRegister := manager.Register(coreauth.WithSkipPersist(context.Background()), auth); errRegister != nil {
			t.Fatalf("register: %v", errRegister)
		}
	}
	h := &Handler{authManager: manager, cfg: &config.Config{}}
	fetcher := &stubQuotaFetcher{}
	svc := quotapoll.New(quotapoll.Options{Fetcher: fetcher, Auths: h.QuotaPollAuths})
	h.SetQuotaPoll(svc)
	return h, fetcher
}

func serveQuota(t *testing.T, h *Handler, method, target string, body string, handler func(*Handler, *gin.Context)) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	var reader *bytes.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
		c.Request = httptest.NewRequest(method, target, reader)
		c.Request.Header.Set("Content-Type", "application/json")
	} else {
		c.Request = httptest.NewRequest(method, target, nil)
	}
	handler(h, c)
	return recorder
}

func decodeJSON(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if errUnmarshal := json.Unmarshal(recorder.Body.Bytes(), &out); errUnmarshal != nil {
		t.Fatalf("decode %s: %v", recorder.Body.String(), errUnmarshal)
	}
	return out
}

func TestQuotaEndpointsUnavailableWithoutService(t *testing.T) {
	h := &Handler{}
	for name, tc := range map[string]struct {
		method, target, body string
		fn                   func(*Handler, *gin.Context)
	}{
		"snapshots": {http.MethodGet, "/v8/management/quota/snapshots", "", (*Handler).GetQuotaSnapshots},
		"refresh":   {http.MethodPost, "/v8/management/quota/refresh", "{}", (*Handler).RefreshQuota},
		"history":   {http.MethodGet, "/v8/management/quota/history?provider=claude&window=5h", "", (*Handler).GetQuotaHistory},
	} {
		if rec := serveQuota(t, h, tc.method, tc.target, tc.body, tc.fn); rec.Code != http.StatusServiceUnavailable {
			t.Errorf("%s: status = %d, want 503", name, rec.Code)
		}
	}
}

func TestQuotaRefreshAndSnapshots(t *testing.T) {
	h, fetcher := newQuotaTestHandler(t)

	for target, want := range map[string]int{
		`{"auth_indexes":["missing"]}`:      http.StatusNotFound,
		`{"auth_indexes":["gemini-c-idx"]}`: http.StatusBadRequest,
		`{"auth_indexes":"x"}`:              http.StatusBadRequest,
	} {
		if rec := serveQuota(t, h, http.MethodPost, "/v8/management/quota/refresh", target, (*Handler).RefreshQuota); rec.Code != want {
			t.Fatalf("%s: status = %d, want %d (%s)", target, rec.Code, want, rec.Body.String())
		}
	}
	if len(fetcher.calls) != 0 {
		t.Fatalf("invalid requests must not call upstream: %v", fetcher.calls)
	}

	rec := serveQuota(t, h, http.MethodPost, "/v8/management/quota/refresh", `{"auth_indexes":["claude-a-idx"],"force":true}`, (*Handler).RefreshQuota)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh status = %d: %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON(t, rec)
	snaps := out["snapshots"].(map[string]any)
	snap := snaps["claude-a-idx"].(map[string]any)
	if snap["auth_index"] != "claude-a-idx" || snap["provider"] != "claude" || snap["fetched_at"] == nil || snap["next_poll_at"] == nil || snap["attempted_at"] == nil {
		t.Fatalf("snapshot = %v", snap)
	}
	responses := snap["responses"].(map[string]any)
	usage := responses["usage"].(map[string]any)
	if usage["status_code"].(float64) != 200 {
		t.Fatalf("usage = %v", usage)
	}
	if _, ok := usage["body"].(map[string]any)["five_hour"]; !ok {
		t.Fatalf("usage body must be a JSON value: %v", usage["body"])
	}
	if profile := responses["profile"].(map[string]any); profile["body"] != "plain text" {
		t.Fatalf("non-JSON body must be a string: %v", profile)
	}

	// Empty body refreshes every eligible credential.
	rec = serveQuota(t, h, http.MethodPost, "/v8/management/quota/refresh", "", (*Handler).RefreshQuota)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh all status = %d", rec.Code)
	}
	if snaps := decodeJSON(t, rec)["snapshots"].(map[string]any); len(snaps) != 2 {
		t.Fatalf("refresh all snapshots = %v", snaps)
	}

	rec = serveQuota(t, h, http.MethodGet, "/v8/management/quota/snapshots?provider=claude", "", (*Handler).GetQuotaSnapshots)
	out = decodeJSON(t, rec)
	if out["poll_interval_seconds"].(float64) != 3600 {
		t.Fatalf("poll_interval_seconds = %v", out["poll_interval_seconds"])
	}
	if snaps := out["snapshots"].(map[string]any); len(snaps) != 1 || snaps["claude-a-idx"] == nil {
		t.Fatalf("filtered snapshots = %v", snaps)
	}
	if rec := serveQuota(t, h, http.MethodGet, "/v8/management/quota/snapshots?provider=gemini", "", (*Handler).GetQuotaSnapshots); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad provider status = %d", rec.Code)
	}
}

func TestQuotaHistoryEndpoint(t *testing.T) {
	h, _ := newQuotaTestHandler(t)
	now := time.Now()
	prev := quotaHistoryNow
	quotaHistoryNow = func() time.Time { return now }
	t.Cleanup(func() { quotaHistoryNow = prev })

	for _, rawQuery := range []string{"window=5h", "provider=claude", "provider=x&window=5h", "provider=claude&window=1d", "provider=claude&window=5h&from=a", "provider=claude&window=5h&to=1.5", "provider=claude&window=5h&from=10&to=5"} {
		if rec := serveQuota(t, h, http.MethodGet, "/v8/management/quota/history?"+rawQuery, "", (*Handler).GetQuotaHistory); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", rawQuery, rec.Code)
		}
	}

	if rec := serveQuota(t, h, http.MethodPost, "/v8/management/quota/refresh", `{"auth_indexes":["claude-a-idx"]}`, (*Handler).RefreshQuota); rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d", rec.Code)
	}
	rec := serveQuota(t, h, http.MethodGet, "/v8/management/quota/history?provider=claude&window=5h", "", (*Handler).GetQuotaHistory)
	if rec.Code != http.StatusOK {
		t.Fatalf("history status = %d", rec.Code)
	}
	out := decodeJSON(t, rec)
	if out["provider"] != "claude" || out["window"] != "5h" || int64(out["to"].(float64)) != now.Unix() || int64(out["from"].(float64)) != now.Unix()-14*24*3600 {
		t.Fatalf("history header = %v", out)
	}
	if _, ok := out["first_recorded_at"].(float64); !ok {
		t.Fatalf("first_recorded_at = %v", out["first_recorded_at"])
	}
	samples := out["samples"].([]any)
	if len(samples) != 1 {
		t.Fatalf("samples = %v", samples)
	}
	sample := samples[0].(map[string]any)
	for _, key := range []string{"t", "auth_index", "used", "resets_at"} {
		if _, ok := sample[key]; !ok {
			t.Fatalf("sample missing %s: %v", key, sample)
		}
	}
	accounts := out["accounts"].(map[string]any)
	acct := accounts["claude-a-idx"].(map[string]any)
	if len(accounts) != 1 || acct["label"] != "a@example.com" || acct["priority"].(float64) != 3 || acct["disabled"] != false {
		t.Fatalf("accounts = %v", accounts)
	}
}

func TestQuotaPollFetcherResolvesToken(t *testing.T) {
	var gotAuth, gotBeta string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotBeta = r.Header.Get("anthropic-beta")
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate"}`))
	}))
	defer upstream.Close()

	h, _ := newQuotaTestHandler(t)
	fetcher := h.QuotaPollFetcher()
	resp, errDo := fetcher.Do(context.Background(), "claude-a-idx", http.MethodGet, upstream.URL+"/api/oauth/usage", map[string]string{"Authorization": "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20"})
	if errDo != nil {
		t.Fatal(errDo)
	}
	if gotAuth != "Bearer tok-a" || gotBeta != "oauth-2025-04-20" {
		t.Fatalf("headers = %q %q", gotAuth, gotBeta)
	}
	if resp.StatusCode != http.StatusTooManyRequests || resp.Header.Get("Retry-After") != "5" || string(resp.Body) != `{"error":"rate"}` {
		t.Fatalf("resp = %+v", resp)
	}
	if _, errDo := fetcher.Do(context.Background(), "missing", http.MethodGet, upstream.URL, nil); errDo == nil {
		t.Fatal("expected error for unknown credential")
	}
}
