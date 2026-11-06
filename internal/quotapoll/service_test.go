package quotapoll

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock(t time.Time) *fakeClock { return &fakeClock{t: t} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	c.t = t
	c.mu.Unlock()
}

func (c *fakeClock) Advance(d time.Duration) { c.Set(c.Now().Add(d)) }

type fakeCall struct {
	authIndex string
	url       string
	headers   map[string]string
}

type fakeFetcher struct {
	mu      sync.Mutex
	calls   []fakeCall
	respond func(authIndex, url string) (FetchResponse, error)
	// started receives one value per usage call; gate blocks usage calls until closed.
	started chan struct{}
	gate    chan struct{}
}

func (f *fakeFetcher) Do(ctx context.Context, authIndex, method, url string, headers map[string]string) (FetchResponse, error) {
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{authIndex: authIndex, url: url, headers: headers})
	f.mu.Unlock()
	if strings.Contains(url, "/usage") {
		if f.started != nil {
			f.started <- struct{}{}
		}
		if f.gate != nil {
			select {
			case <-f.gate:
			case <-ctx.Done():
				return FetchResponse{}, ctx.Err()
			}
		}
	}
	if f.respond != nil {
		return f.respond(authIndex, url)
	}
	return defaultResponse(url), nil
}

func defaultResponse(url string) FetchResponse {
	switch {
	case strings.Contains(url, "api/oauth/usage"):
		return FetchResponse{StatusCode: 200, Body: []byte(`{"five_hour":{"utilization":12.5,"resets_at":"2026-10-26T15:00:00Z"},"seven_day":{"utilization":40,"resets_at":"2026-10-30T00:00:00Z"}}`)}
	case strings.Contains(url, "wham/usage"):
		return FetchResponse{StatusCode: 200, Body: []byte(`{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_at":1793030400},"secondary_window":{"used_percent":"55.5","limit_window_seconds":604800,"reset_after_seconds":3600}}}`)}
	default:
		return FetchResponse{StatusCode: 200, Body: []byte(`{"ok":true}`)}
	}
}

func (f *fakeFetcher) usageCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, call := range f.calls {
		if strings.Contains(call.url, "/usage") {
			n++
		}
	}
	return n
}

func (f *fakeFetcher) callsSnapshot() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeCall(nil), f.calls...)
}

func oauthAuth(index, provider, email string) *coreauth.Auth {
	return &coreauth.Auth{
		ID:         index + "-id",
		Index:      index,
		Provider:   provider,
		Attributes: map[string]string{"auth_kind": "oauth"},
		Metadata:   map[string]any{"email": email, "access_token": "secret-token"},
	}
}

var testStart = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)

func newTestService(t *testing.T, fetcher Fetcher, auths []*coreauth.Auth, dir string, clock *fakeClock) *Service {
	t.Helper()
	return New(Options{
		Fetcher: fetcher,
		// Like the auth manager, return clones so callers never share auth values.
		Auths: func() []*coreauth.Auth {
			out := make([]*coreauth.Auth, 0, len(auths))
			for _, auth := range auths {
				out = append(out, auth.Clone())
			}
			return out
		},
		Dir: dir,
		Now: clock.Now,
	})
}

func TestRefreshSingleFlight(t *testing.T) {
	clock := newFakeClock(testStart)
	fetcher := &fakeFetcher{started: make(chan struct{}, 16), gate: make(chan struct{})}
	svc := newTestService(t, fetcher, []*coreauth.Auth{oauthAuth("c1", "claude", "a@example.com")}, "", clock)

	const callers = 8
	var wg sync.WaitGroup
	results := make([]map[string]Snapshot, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			snaps, errRefresh := svc.Refresh(context.Background(), []string{"c1"}, false)
			if errRefresh != nil {
				t.Errorf("refresh: %v", errRefresh)
				return
			}
			results[i] = snaps
		}(i)
	}
	<-fetcher.started
	close(fetcher.gate)
	wg.Wait()

	if got := fetcher.usageCalls(); got != 1 {
		t.Fatalf("usage calls = %d, want 1", got)
	}
	for i, snaps := range results {
		snap, ok := snaps["c1"]
		if !ok || snap.FetchedAt == nil {
			t.Fatalf("caller %d got no fetched snapshot: %+v", i, snaps)
		}
	}
}

func TestRefreshMinimumAgeAndForce(t *testing.T) {
	clock := newFakeClock(testStart)
	fetcher := &fakeFetcher{}
	svc := newTestService(t, fetcher, []*coreauth.Auth{oauthAuth("c1", "claude", "a@example.com")}, "", clock)
	ctx := context.Background()

	if _, errRefresh := svc.Refresh(ctx, []string{"c1"}, false); errRefresh != nil {
		t.Fatal(errRefresh)
	}
	clock.Advance(30 * time.Second)
	if _, errRefresh := svc.Refresh(ctx, []string{"c1"}, false); errRefresh != nil {
		t.Fatal(errRefresh)
	}
	if got := fetcher.usageCalls(); got != 1 {
		t.Fatalf("usage calls after fresh refresh = %d, want 1", got)
	}
	if _, errRefresh := svc.Refresh(ctx, []string{"c1"}, true); errRefresh != nil {
		t.Fatal(errRefresh)
	}
	if got := fetcher.usageCalls(); got != 2 {
		t.Fatalf("usage calls after force = %d, want 2", got)
	}
	clock.Advance(61 * time.Second)
	snaps, errRefresh := svc.Refresh(ctx, nil, false)
	if errRefresh != nil {
		t.Fatal(errRefresh)
	}
	if got := fetcher.usageCalls(); got != 3 {
		t.Fatalf("usage calls after 61s = %d, want 3", got)
	}
	snap := snaps["c1"]
	if want := clock.Now().Add(PollInterval); snap.NextPollAt == nil || !snap.NextPollAt.Equal(want) {
		t.Fatalf("next_poll_at = %v, want %v", snap.NextPollAt, want)
	}
	if snap.Responses["usage"].StatusCode != 200 || snap.Responses["profile"].StatusCode != 200 {
		t.Fatalf("responses = %+v", snap.Responses)
	}
}

func TestRefreshValidation(t *testing.T) {
	clock := newFakeClock(testStart)
	auths := []*coreauth.Auth{
		oauthAuth("c1", "claude", "a@example.com"),
		oauthAuth("g1", "gemini", "g@example.com"),
		{ID: "k", Index: "k1", Provider: "claude", Attributes: map[string]string{"api_key": "sk-test"}},
	}
	svc := newTestService(t, &fakeFetcher{}, auths, "", clock)
	cases := map[string]int{"missing": http.StatusNotFound, "g1": http.StatusBadRequest, "k1": http.StatusBadRequest}
	for index, status := range cases {
		_, errRefresh := svc.Refresh(context.Background(), []string{index}, false)
		var reqErr *RequestError
		if !errors.As(errRefresh, &reqErr) || reqErr.Status != status {
			t.Fatalf("%s: err = %v, want status %d", index, errRefresh, status)
		}
	}
}

func TestFailureBackoff(t *testing.T) {
	clock := newFakeClock(testStart)
	var status int
	var retryAfter string
	var netErr bool
	fetcher := &fakeFetcher{respond: func(_, url string) (FetchResponse, error) {
		if !strings.Contains(url, "/usage") {
			return defaultResponse(url), nil
		}
		if netErr {
			return FetchResponse{}, errors.New("request failed")
		}
		if status != 0 {
			header := http.Header{}
			if retryAfter != "" {
				header.Set("Retry-After", retryAfter)
			}
			return FetchResponse{StatusCode: status, Header: header, Body: []byte(`{"error":"x"}`)}, nil
		}
		return defaultResponse(url), nil
	}}
	svc := newTestService(t, fetcher, []*coreauth.Auth{oauthAuth("c1", "claude", "a@example.com")}, "", clock)

	step := func(wantDelay time.Duration, wantStatus int) Snapshot {
		t.Helper()
		snaps, errRefresh := svc.Refresh(context.Background(), []string{"c1"}, true)
		if errRefresh != nil {
			t.Fatal(errRefresh)
		}
		snap := snaps["c1"]
		if want := clock.Now().Add(wantDelay); snap.NextPollAt == nil || !snap.NextPollAt.Equal(want) {
			t.Fatalf("next_poll_at = %v, want %v (status %d)", snap.NextPollAt, want, wantStatus)
		}
		if snap.ErrorStatus != wantStatus {
			t.Fatalf("error_status = %d, want %d", snap.ErrorStatus, wantStatus)
		}
		return snap
	}

	ok := step(PollInterval, 0)
	if ok.FetchedAt == nil {
		t.Fatal("expected fetched_at after success")
	}
	status = 429
	failed := step(2*time.Hour, 429)
	if failed.FetchedAt == nil || !failed.FetchedAt.Equal(*ok.FetchedAt) || failed.Responses["usage"].StatusCode != 200 {
		t.Fatalf("failure must keep last successful responses: %+v", failed)
	}
	if failed.Error == "" {
		t.Fatal("expected error message")
	}
	step(4*time.Hour, 429)
	step(4*time.Hour, 429)

	status, netErr = 0, false
	step(PollInterval, 0)
	status = 503
	retryAfter = "10800"
	step(3*time.Hour, 503)
	retryAfter = "36000"
	step(4*time.Hour, 503)
	retryAfter = "60"
	status = 0
	step(PollInterval, 0)
	status = 502
	step(2*time.Hour, 502)

	status, retryAfter = 0, ""
	step(PollInterval, 0)
	status = 401
	step(4*time.Hour, 401)
	status = 403
	step(4*time.Hour, 403)

	status = 0
	step(PollInterval, 0)
	netErr = true
	step(2*time.Hour, 0)
}

func TestScheduleStaggerAndSkipWhenFresh(t *testing.T) {
	dir := t.TempDir()
	clock := newFakeClock(testStart)
	fetcher := &fakeFetcher{}
	auths := []*coreauth.Auth{oauthAuth("c1", "claude", "a@example.com")}
	svc := newTestService(t, fetcher, auths, dir, clock)
	ctx := context.Background()

	stagger := staggerOffset("c1")
	if stagger < 0 || stagger >= PollInterval {
		t.Fatalf("stagger out of range: %v", stagger)
	}
	if stagger > 0 {
		svc.tick(ctx)
		if got := fetcher.usageCalls(); got != 0 {
			t.Fatalf("polled before stagger: %d", got)
		}
	}
	clock.Set(testStart.Add(stagger))
	svc.tick(ctx)
	if got := fetcher.usageCalls(); got != 1 {
		t.Fatalf("usage calls at stagger = %d, want 1", got)
	}
	fetchedAt := clock.Now()
	clock.Advance(59 * time.Minute)
	svc.tick(ctx)
	if got := fetcher.usageCalls(); got != 1 {
		t.Fatalf("polled before interval: %d", got)
	}
	if errClose := svc.Close(); errClose != nil {
		t.Fatal(errClose)
	}

	// Restart five minutes after the fetch: the persisted snapshot is fresh, so
	// the first poll waits until it is one interval old.
	clock.Set(fetchedAt.Add(5 * time.Minute))
	fetcher2 := &fakeFetcher{}
	svc2 := newTestService(t, fetcher2, auths, dir, clock)
	svc2.tick(ctx)
	want := clock.Now().Add(staggerOffset("c1"))
	if fresh := fetchedAt.Add(PollInterval); fresh.After(want) {
		want = fresh
	}
	snap := svc2.Snapshots("")["c1"]
	if snap.NextPollAt == nil || !snap.NextPollAt.Equal(want.UTC().Truncate(time.Second)) {
		t.Fatalf("next_poll_at = %v, want %v", snap.NextPollAt, want)
	}
	clock.Set(want.Add(-time.Second))
	svc2.tick(ctx)
	if got := fetcher2.usageCalls(); got != 0 {
		t.Fatalf("polled while fresh: %d", got)
	}
	clock.Set(want)
	svc2.tick(ctx)
	if got := fetcher2.usageCalls(); got != 1 {
		t.Fatalf("usage calls after interval = %d, want 1", got)
	}
}

func TestScheduleSkipsDisabledAndAPIKeys(t *testing.T) {
	clock := newFakeClock(testStart)
	fetcher := &fakeFetcher{}
	disabled := oauthAuth("d1", "codex", "d@example.com")
	disabled.Disabled = true
	auths := []*coreauth.Auth{
		disabled,
		{ID: "k", Index: "k1", Provider: "claude", Attributes: map[string]string{"api_key": "sk-test"}},
		oauthAuth("g1", "gemini", "g@example.com"),
	}
	svc := newTestService(t, fetcher, auths, "", clock)
	clock.Advance(2 * PollInterval)
	svc.tick(context.Background())
	if got := len(fetcher.callsSnapshot()); got != 0 {
		t.Fatalf("calls = %d, want 0", got)
	}
}

func fakeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	raw, errMarshal := json.Marshal(claims)
	if errMarshal != nil {
		t.Fatal(errMarshal)
	}
	enc := base64.RawURLEncoding
	return enc.EncodeToString([]byte(`{"alg":"none"}`)) + "." + enc.EncodeToString(raw) + ".sig"
}

func TestCodexRequestBundle(t *testing.T) {
	clock := newFakeClock(testStart)
	fetcher := &fakeFetcher{}
	auth := oauthAuth("x1", "codex", "x@example.com")
	auth.Metadata["id_token"] = fakeJWT(t, map[string]any{"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acct-123"}})
	svc := newTestService(t, fetcher, []*coreauth.Auth{auth}, "", clock)
	snaps, errRefresh := svc.Refresh(context.Background(), []string{"x1"}, false)
	if errRefresh != nil {
		t.Fatal(errRefresh)
	}
	calls := fetcher.callsSnapshot()
	if len(calls) != 3 {
		t.Fatalf("calls = %d, want 3", len(calls))
	}
	if calls[0].url != codexUsageURL || calls[1].url != codexSubscriptionURL+"?account_id=acct-123" || calls[2].url != codexResetCreditsURL {
		t.Fatalf("unexpected urls: %+v", calls)
	}
	for _, call := range calls {
		if call.headers["Authorization"] != "Bearer $TOKEN$" || call.headers["Chatgpt-Account-Id"] != "acct-123" || call.headers["User-Agent"] != codexUserAgent {
			t.Fatalf("unexpected headers: %+v", call.headers)
		}
	}
	if calls[2].headers["OpenAI-Beta"] != "codex-1" || calls[2].headers["Originator"] != "Codex Desktop" || calls[2].headers["Accept"] != "application/json" {
		t.Fatalf("reset credit headers: %+v", calls[2].headers)
	}
	if _, ok := calls[0].headers["OpenAI-Beta"]; ok {
		t.Fatal("usage request must not carry reset-credit headers")
	}
	snap := snaps["x1"]
	if len(snap.Responses) != 3 {
		t.Fatalf("responses = %+v", snap.Responses)
	}

	// Without an account id there is no subscription call and no account header.
	fetcher2 := &fakeFetcher{}
	svc2 := newTestService(t, fetcher2, []*coreauth.Auth{oauthAuth("x2", "codex", "y@example.com")}, "", clock)
	if _, errRefresh2 := svc2.Refresh(context.Background(), []string{"x2"}, false); errRefresh2 != nil {
		t.Fatal(errRefresh2)
	}
	calls2 := fetcher2.callsSnapshot()
	if len(calls2) != 2 || calls2[1].url != codexResetCreditsURL {
		t.Fatalf("calls without account id: %+v", calls2)
	}
	if _, ok := calls2[0].headers["Chatgpt-Account-Id"]; ok {
		t.Fatal("unexpected Chatgpt-Account-Id header")
	}
}

func TestClaudeRequestBundleAndPollSamples(t *testing.T) {
	clock := newFakeClock(testStart)
	fetcher := &fakeFetcher{}
	svc := newTestService(t, fetcher, []*coreauth.Auth{oauthAuth("c1", "claude", "a@example.com")}, "", clock)
	if _, errRefresh := svc.Refresh(context.Background(), nil, false); errRefresh != nil {
		t.Fatal(errRefresh)
	}
	calls := fetcher.callsSnapshot()
	if len(calls) != 2 || calls[0].url != claudeUsageURL || calls[1].url != claudeProfileURL {
		t.Fatalf("calls: %+v", calls)
	}
	h := calls[0].headers
	if h["anthropic-beta"] != claudeBeta || h["User-Agent"] != claudeUserAgent || h["Content-Type"] != "application/json" {
		t.Fatalf("headers: %+v", h)
	}
	result := svc.History("claude", Window5h, testStart.Unix()-10, testStart.Unix()+10)
	if len(result.Samples) != 1 || result.Samples[0].Used != 12.5 || result.Samples[0].ResetsAt != time.Date(2026, 10, 26, 15, 0, 0, 0, time.UTC).Unix() {
		t.Fatalf("5h samples: %+v", result.Samples)
	}
	weekly := svc.History("claude", WindowWeekly, testStart.Unix()-10, testStart.Unix()+10)
	if len(weekly.Samples) != 1 || weekly.Samples[0].Used != 40 {
		t.Fatalf("weekly samples: %+v", weekly.Samples)
	}
	if acct := result.Accounts["c1"]; acct.Label != "a@example.com" {
		t.Fatalf("accounts: %+v", result.Accounts)
	}
}

func TestSecondaryFailureDoesNotFailSnapshot(t *testing.T) {
	clock := newFakeClock(testStart)
	fetcher := &fakeFetcher{respond: func(_, url string) (FetchResponse, error) {
		if strings.Contains(url, "profile") {
			return FetchResponse{StatusCode: 500, Body: []byte("oops")}, nil
		}
		return defaultResponse(url), nil
	}}
	svc := newTestService(t, fetcher, []*coreauth.Auth{oauthAuth("c1", "claude", "a@example.com")}, "", clock)
	snaps, errRefresh := svc.Refresh(context.Background(), nil, false)
	if errRefresh != nil {
		t.Fatal(errRefresh)
	}
	snap := snaps["c1"]
	if snap.Error != "" || snap.FetchedAt == nil {
		t.Fatalf("snapshot should succeed: %+v", snap)
	}
	if snap.Responses["profile"].StatusCode != 500 || string(snap.Responses["profile"].Body) != `"oops"` {
		t.Fatalf("profile response: %+v", snap.Responses["profile"])
	}
}

func TestHeaderSampling(t *testing.T) {
	clock := newFakeClock(testStart)
	claude := oauthAuth("c1", "claude", "a@example.com")
	claude.Quota.ObservedAt = testStart.Add(-time.Minute)
	claude.Quota.Signals = map[string]string{
		"Anthropic-Ratelimit-Unified-5h-Utilization": "0.25",
		"Anthropic-Ratelimit-Unified-5h-Reset":       "1793030400",
		"Anthropic-Ratelimit-Unified-7d-Utilization": "0.5",
		"Anthropic-Ratelimit-Unified-7d-Reset":       "1793500000",
	}
	codexAuth := oauthAuth("x1", "codex", "x@example.com")
	codexAuth.Quota.ObservedAt = testStart.Add(-2 * time.Minute)
	codexAuth.Quota.Signals = map[string]string{
		"X-Codex-Primary-Used-Percent":     "30",
		"X-Codex-Primary-Window-Minutes":   "300",
		"X-Codex-Primary-Reset-At":         "1793030400",
		"X-Codex-Secondary-Used-Percent":   "70",
		"X-Codex-Secondary-Window-Minutes": "10080",
		"X-Codex-Secondary-Reset-At":       "1793500000",
	}
	auths := []*coreauth.Auth{claude, codexAuth}
	svc := newTestService(t, &fakeFetcher{}, auths, "", clock)
	svc.sampleHeaders()
	svc.sampleHeaders() // same ObservedAt: no duplicate

	from, to := testStart.Unix()-3600, testStart.Unix()
	c5 := svc.History("claude", Window5h, from, to).Samples
	if len(c5) != 1 || c5[0].Used != 25 || c5[0].ResetsAt != 1793030400 || c5[0].T != claude.Quota.ObservedAt.Unix() {
		t.Fatalf("claude 5h: %+v", c5)
	}
	if cw := svc.History("claude", WindowWeekly, from, to).Samples; len(cw) != 1 || cw[0].Used != 50 {
		t.Fatalf("claude weekly: %+v", cw)
	}
	if x5 := svc.History("codex", Window5h, from, to).Samples; len(x5) != 1 || x5[0].Used != 30 {
		t.Fatalf("codex 5h: %+v", x5)
	}
	if xw := svc.History("codex", WindowWeekly, from, to).Samples; len(xw) != 1 || xw[0].Used != 70 {
		t.Fatalf("codex weekly: %+v", xw)
	}

	// An observation older than the latest sample is ignored.
	claude.Quota.ObservedAt = testStart.Add(-30 * time.Minute)
	claude.Quota.Signals["Anthropic-Ratelimit-Unified-5h-Utilization"] = "0.9"
	svc.sampleHeaders()
	if c5 := svc.History("claude", Window5h, from, to).Samples; len(c5) != 1 {
		t.Fatalf("older observation stored: %+v", c5)
	}
	// A newer observation with a meaningful change is stored.
	claude.Quota.ObservedAt = testStart
	svc.sampleHeaders()
	if c5 := svc.History("claude", Window5h, from, to).Samples; len(c5) != 2 || c5[1].Used != 90 {
		t.Fatalf("newer observation missing: %+v", c5)
	}
}

func TestHistoryAccountsAndSeedSample(t *testing.T) {
	clock := newFakeClock(testStart)
	disabled := oauthAuth("c2", "claude", "b@example.com")
	disabled.Disabled = true
	disabled.Attributes["priority"] = "5"
	auths := []*coreauth.Auth{
		oauthAuth("c1", "claude", "a@example.com"),
		disabled,
		{ID: "k", Index: "k1", Provider: "claude", Attributes: map[string]string{"api_key": "sk-test", "priority": "x"}},
		oauthAuth("x1", "codex", "x@example.com"),
	}
	svc := newTestService(t, &fakeFetcher{}, auths, "", clock)
	base := testStart.Unix()
	svc.history.add(Sample{T: base - 7200, AuthIndex: "c1", Provider: "claude", Window: Window5h, Used: 10, Src: SourcePoll}, false)
	svc.history.add(Sample{T: base - 600, AuthIndex: "c1", Provider: "claude", Window: Window5h, Used: 20, Src: SourcePoll}, false)
	svc.history.add(Sample{T: base - 300, AuthIndex: "x1", Provider: "codex", Window: Window5h, Used: 20, Src: SourcePoll}, false)

	result := svc.History("claude", Window5h, base-3600, base)
	if len(result.Samples) != 2 || result.Samples[0].T != base-7200 || result.Samples[1].T != base-600 {
		t.Fatalf("samples: %+v", result.Samples)
	}
	if len(result.Accounts) != 3 {
		t.Fatalf("accounts: %+v", result.Accounts)
	}
	if acct := result.Accounts["c2"]; !acct.Disabled || acct.Priority != 5 || acct.Label != "b@example.com" {
		t.Fatalf("c2: %+v", acct)
	}
	if acct := result.Accounts["k1"]; acct.Label != "" || acct.Priority != 0 {
		t.Fatalf("api key account must have no label: %+v", acct)
	}
	if result.FirstRecordedAt != base-7200 {
		t.Fatalf("first_recorded_at = %d", result.FirstRecordedAt)
	}
}

func TestPersistenceRoundTripAndCorruptRecovery(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "quota")
	clock := newFakeClock(testStart)
	auths := []*coreauth.Auth{oauthAuth("c1", "claude", "a@example.com")}
	svc := newTestService(t, &fakeFetcher{}, auths, dir, clock)
	svc.Start(context.Background())
	if _, errRefresh := svc.Refresh(context.Background(), nil, false); errRefresh != nil {
		t.Fatal(errRefresh)
	}
	if errClose := svc.Close(); errClose != nil {
		t.Fatal(errClose)
	}
	for _, name := range []string{snapshotFileName, historyFileName} {
		info, errStat := os.Stat(filepath.Join(dir, name))
		if errStat != nil {
			t.Fatal(errStat)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("%s perm = %o", name, perm)
		}
	}
	if info, errStat := os.Stat(dir); errStat != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("dir perm: %v %v", info, errStat)
	}

	reloaded := newTestService(t, &fakeFetcher{}, auths, dir, clock)
	snap := reloaded.Snapshots("claude")["c1"]
	if snap.FetchedAt == nil || !snap.FetchedAt.Equal(testStart) || snap.Responses["usage"].StatusCode != 200 {
		t.Fatalf("reloaded snapshot: %+v", snap)
	}
	var usage map[string]any
	if errUnmarshal := json.Unmarshal(snap.Responses["usage"].Body, &usage); errUnmarshal != nil || usage["five_hour"] == nil {
		t.Fatalf("usage body not preserved as JSON: %s", snap.Responses["usage"].Body)
	}
	if got := reloaded.History("claude", Window5h, 0, testStart.Unix()).Samples; len(got) != 1 {
		t.Fatalf("reloaded history: %+v", got)
	}

	if errWrite := os.WriteFile(filepath.Join(dir, historyFileName), []byte("{not json"), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	recovered := newTestService(t, &fakeFetcher{}, auths, dir, clock)
	if got := recovered.History("claude", Window5h, 0, testStart.Unix()).Samples; len(got) != 0 {
		t.Fatalf("corrupt history should start empty: %+v", got)
	}
	if _, errStat := os.Stat(filepath.Join(dir, historyFileName)); !os.IsNotExist(errStat) {
		t.Fatalf("corrupt file should be moved aside: %v", errStat)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, historyFileName+".corrupt-*"))
	if len(matches) != 1 {
		t.Fatalf("corrupt copies = %v", matches)
	}
	if snap := recovered.Snapshots("")["c1"]; snap.FetchedAt == nil {
		t.Fatal("snapshots must survive a corrupt history file")
	}
}

func TestPruneOnLoadAndDaily(t *testing.T) {
	dir := t.TempDir()
	clock := newFakeClock(testStart)
	svc := newTestService(t, &fakeFetcher{}, nil, dir, clock)
	old := testStart.Add(-91 * 24 * time.Hour).Unix()
	svc.history.add(Sample{T: old, AuthIndex: "c1", Provider: "claude", Window: Window5h, Used: 1}, false)
	svc.history.add(Sample{T: testStart.Unix(), AuthIndex: "c1", Provider: "claude", Window: Window5h, Used: 2}, false)
	if errFlush := svc.Flush(); errFlush != nil {
		t.Fatal(errFlush)
	}
	reloaded := newTestService(t, &fakeFetcher{}, nil, dir, clock)
	if got := reloaded.History("claude", Window5h, 0, testStart.Unix()).Samples; len(got) != 1 || got[0].Used != 2 {
		t.Fatalf("prune on load: %+v", got)
	}

	clock.Advance(89 * 24 * time.Hour)
	reloaded.tick(context.Background())
	if got := reloaded.History("claude", Window5h, 0, clock.Now().Unix()).Samples; len(got) != 1 {
		t.Fatalf("pruned too early: %+v", got)
	}
	clock.Advance(2 * 24 * time.Hour)
	reloaded.tick(context.Background())
	if got := reloaded.History("claude", Window5h, 0, clock.Now().Unix()).Samples; len(got) != 0 {
		t.Fatalf("daily prune: %+v", got)
	}
}

func TestDefaultClockUsesWallTime(t *testing.T) {
	svc := New(Options{})
	// A monotonic reading pauses during macOS sleep and would delay due polls.
	if got := svc.now().String(); strings.Contains(got, " m=") {
		t.Fatalf("now() carries a monotonic reading: %s", got)
	}
}
