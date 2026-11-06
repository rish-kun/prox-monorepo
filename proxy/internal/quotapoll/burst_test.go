package quotapoll

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type burstFixture struct {
	mu        sync.Mutex
	auths     []*coreauth.Auth
	overrides map[string]int
	applies   int
}

func (f *burstFixture) list() []*coreauth.Auth {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*coreauth.Auth, 0, len(f.auths))
	for _, auth := range f.auths {
		out = append(out, auth.Clone())
	}
	return out
}

func (f *burstFixture) apply(overrides map[string]int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.overrides = make(map[string]int, len(overrides))
	for id, priority := range overrides {
		f.overrides[id] = priority
	}
	f.applies++
}

func (f *burstFixture) current() map[string]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]int, len(f.overrides))
	for id, priority := range f.overrides {
		out[id] = priority
	}
	return out
}

func (f *burstFixture) mutate(fn func(auths []*coreauth.Auth) []*coreauth.Auth) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.auths = fn(f.auths)
}

func claudeBurstAuth(id, priority string, now time.Time, used float64, resetIn time.Duration) *coreauth.Auth {
	auth := &coreauth.Auth{
		ID:         id,
		Index:      id + "-idx",
		Provider:   "claude",
		Attributes: map[string]string{"auth_kind": "oauth", "priority": priority},
		Metadata:   map[string]any{"email": id + "@example.com"},
	}
	if resetIn != 0 {
		auth.Quota.ObservedAt = now
		auth.Quota.Signals = map[string]string{
			"Anthropic-Ratelimit-Unified-5h-Utilization": strconv.FormatFloat(used/100, 'f', -1, 64),
			"Anthropic-Ratelimit-Unified-5h-Reset":       strconv.FormatInt(now.Add(resetIn).Unix(), 10),
		}
	}
	return auth
}

func codexBurstAuth(id string, now time.Time, used float64, resetIn time.Duration) *coreauth.Auth {
	return &coreauth.Auth{
		ID:         id,
		Index:      id + "-idx",
		Provider:   "codex",
		Attributes: map[string]string{"auth_kind": "oauth"},
		Metadata:   map[string]any{"email": id + "@example.com"},
		Quota: coreauth.QuotaState{
			ObservedAt: now,
			Signals: map[string]string{
				"X-Codex-Primary-Used-Percent":     strconv.FormatFloat(used, 'f', -1, 64),
				"X-Codex-Primary-Window-Minutes":   "300",
				"X-Codex-Primary-Reset-At":         strconv.FormatInt(now.Add(resetIn).Unix(), 10),
				"X-Codex-Secondary-Used-Percent":   "10",
				"X-Codex-Secondary-Window-Minutes": "10080",
				"X-Codex-Secondary-Reset-At":       strconv.FormatInt(now.Add(72*time.Hour).Unix(), 10),
			},
		},
	}
}

func newBurstService(t *testing.T, dir string, clock *fakeClock, fixture *burstFixture) *Service {
	t.Helper()
	return New(Options{Fetcher: &fakeFetcher{}, Auths: fixture.list, Dir: dir, Now: clock.Now, ApplyPriorityOverrides: fixture.apply})
}

func requestStatus(t *testing.T, err error) int {
	t.Helper()
	var reqErr *RequestError
	if !errors.As(err, &reqErr) {
		t.Fatalf("error %v is not a RequestError", err)
	}
	return reqErr.Status
}

func TestBurstOrderAndOverrides(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	fixture := &burstFixture{auths: []*coreauth.Auth{
		claudeBurstAuth("late", "0", now, 10, 4*time.Hour),
		claudeBurstAuth("tie-low", "1", now, 10, 2*time.Hour),
		claudeBurstAuth("tie-high", "5", now, 10, 2*time.Hour),
		codexBurstAuth("soon", now, 50, time.Hour),
	}}
	svc := newBurstService(t, "", clock, fixture)

	var bursts []Burst
	for _, id := range []string{"late", "tie-low", "tie-high", "soon"} {
		var errPrioritise error
		bursts, errPrioritise = svc.Prioritise(id + "-idx")
		if errPrioritise != nil {
			t.Fatalf("Prioritise(%s): %v", id, errPrioritise)
		}
	}
	wantOrder := []string{"soon-idx", "tie-high-idx", "tie-low-idx", "late-idx"}
	if len(bursts) != len(wantOrder) {
		t.Fatalf("bursts = %+v", bursts)
	}
	for i, want := range wantOrder {
		if bursts[i].AuthIndex != want || bursts[i].Order != i+1 {
			t.Fatalf("burst %d = %+v, want %s order %d", i, bursts[i], want, i+1)
		}
	}
	if bursts[0].Provider != ProviderCodex || bursts[0].Label != "soon@example.com" {
		t.Fatalf("burst label/provider = %+v", bursts[0])
	}
	if !bursts[0].EndsAt.Equal(now.Add(time.Hour)) || !bursts[0].StartedAt.Equal(now) || bursts[0].EndsAt.Location() != time.UTC {
		t.Fatalf("burst times = %+v", bursts[0])
	}
	overrides := fixture.current()
	for i, id := range []string{"soon", "tie-high", "tie-low", "late"} {
		if got, want := overrides[id], BurstPriorityBase-(i+1); got != want {
			t.Fatalf("override[%s] = %d, want %d", id, got, want)
		}
	}

	// Prioritising a bursting account is a no-op.
	again, errAgain := svc.Prioritise("late-idx")
	if errAgain != nil || len(again) != 4 || again[3].AuthIndex != "late-idx" || !again[3].StartedAt.Equal(now) {
		t.Fatalf("re-prioritise = %+v, %v", again, errAgain)
	}

	cancelled, errCancel := svc.CancelBurst("soon-idx")
	if errCancel != nil || len(cancelled) != 3 || cancelled[0].AuthIndex != "tie-high-idx" || cancelled[0].Order != 1 {
		t.Fatalf("cancel = %+v, %v", cancelled, errCancel)
	}
	if _, ok := fixture.current()["soon"]; ok {
		t.Fatal("cancelled burst still overridden")
	}
	if fixture.current()["tie-high"] != BurstPriorityBase-1 {
		t.Fatalf("overrides after cancel = %v", fixture.current())
	}
	if unchanged, errNoop := svc.CancelBurst("soon-idx"); errNoop != nil || len(unchanged) != 3 {
		t.Fatalf("cancel absent = %+v, %v", unchanged, errNoop)
	}
	if _, errEmpty := svc.CancelBurst(" "); errEmpty == nil || requestStatus(t, errEmpty) != http.StatusBadRequest {
		t.Fatalf("cancel without index = %v", errEmpty)
	}
}

func TestBurstExpiresAtWindowReset(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	fixture := &burstFixture{auths: []*coreauth.Auth{
		claudeBurstAuth("a", "0", now, 10, time.Hour),
		claudeBurstAuth("b", "0", now, 10, 3*time.Hour),
	}}
	svc := newBurstService(t, "", clock, fixture)
	for _, index := range []string{"a-idx", "b-idx"} {
		if _, errPrioritise := svc.Prioritise(index); errPrioritise != nil {
			t.Fatalf("Prioritise(%s): %v", index, errPrioritise)
		}
	}
	if wait := svc.nextBurstWait(); wait != burstSweepInterval {
		t.Fatalf("next wait = %s, want %s", wait, burstSweepInterval)
	}

	clock.Set(now.Add(time.Hour - 10*time.Second))
	if wait := svc.nextBurstWait(); wait != 10*time.Second {
		t.Fatalf("next wait before reset = %s, want 10s", wait)
	}
	if got := svc.Bursts(); len(got) != 2 {
		t.Fatalf("bursts before reset = %+v", got)
	}

	clock.Set(now.Add(time.Hour))
	svc.SweepBursts()
	got := svc.Bursts()
	if len(got) != 1 || got[0].AuthIndex != "b-idx" || got[0].Order != 1 {
		t.Fatalf("bursts after reset = %+v", got)
	}
	overrides := fixture.current()
	if _, ok := overrides["a"]; ok || overrides["b"] != BurstPriorityBase-1 {
		t.Fatalf("overrides after reset = %v", overrides)
	}

	clock.Set(now.Add(3 * time.Hour))
	if got := svc.Bursts(); len(got) != 0 {
		t.Fatalf("bursts after second reset = %+v", got)
	}
	if overrides := fixture.current(); len(overrides) != 0 {
		t.Fatalf("overrides after all resets = %v", overrides)
	}
}

func TestBurstEndsWhenCredentialRemovedOrDisabled(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	fixture := &burstFixture{auths: []*coreauth.Auth{
		claudeBurstAuth("keep", "0", now, 10, 2*time.Hour),
		claudeBurstAuth("gone", "0", now, 10, 2*time.Hour),
		claudeBurstAuth("off", "0", now, 10, 2*time.Hour),
	}}
	svc := newBurstService(t, "", clock, fixture)
	for _, index := range []string{"keep-idx", "gone-idx", "off-idx"} {
		if _, errPrioritise := svc.Prioritise(index); errPrioritise != nil {
			t.Fatalf("Prioritise(%s): %v", index, errPrioritise)
		}
	}
	fixture.mutate(func(auths []*coreauth.Auth) []*coreauth.Auth {
		var out []*coreauth.Auth
		for _, auth := range auths {
			switch auth.ID {
			case "gone":
				continue
			case "off":
				auth.Disabled = true
			}
			out = append(out, auth)
		}
		return out
	})
	got := svc.Bursts()
	if len(got) != 1 || got[0].AuthIndex != "keep-idx" {
		t.Fatalf("bursts = %+v", got)
	}

	// An empty credential list is treated as transient and keeps the burst.
	fixture.mutate(func([]*coreauth.Auth) []*coreauth.Auth { return nil })
	if got := svc.Bursts(); len(got) != 1 {
		t.Fatalf("bursts with empty credential list = %+v", got)
	}
}

func TestBurstEligibility(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	rejected := claudeBurstAuth("rejected", "0", now, 40, time.Hour)
	rejected.Quota.Signals["Anthropic-Ratelimit-Unified-5h-Status"] = "rejected"
	disabled := claudeBurstAuth("disabled", "0", now, 10, time.Hour)
	disabled.Disabled = true
	fixture := &burstFixture{auths: []*coreauth.Auth{
		claudeBurstAuth("no-window", "0", now, 0, 0),
		claudeBurstAuth("past", "0", now, 10, -time.Minute),
		claudeBurstAuth("full", "0", now, 100, time.Hour),
		codexBurstAuth("codex-full", now, 100, time.Hour),
		rejected,
		disabled,
		{ID: "claude-key", Index: "claude-key-idx", Provider: "claude", Attributes: map[string]string{"api_key": "k"}},
		{ID: "gemini", Index: "gemini-idx", Provider: "gemini", Attributes: map[string]string{"auth_kind": "oauth"}},
	}}
	svc := newBurstService(t, "", clock, fixture)
	for _, tc := range []struct {
		index   string
		status  int
		message string
	}{
		{"", http.StatusBadRequest, "auth_index is required"},
		{"missing-idx", http.StatusNotFound, "not found"},
		{"claude-key-idx", http.StatusBadRequest, "OAuth"},
		{"gemini-idx", http.StatusBadRequest, "OAuth"},
		{"disabled-idx", http.StatusConflict, "disabled"},
		{"no-window-idx", http.StatusConflict, "no running 5-hour window"},
		{"past-idx", http.StatusConflict, "no running 5-hour window"},
		{"full-idx", http.StatusConflict, "used up"},
		{"codex-full-idx", http.StatusConflict, "used up"},
		{"rejected-idx", http.StatusConflict, "used up"},
	} {
		_, errPrioritise := svc.Prioritise(tc.index)
		if errPrioritise == nil {
			t.Fatalf("Prioritise(%q) succeeded", tc.index)
		}
		if status := requestStatus(t, errPrioritise); status != tc.status || !strings.Contains(errPrioritise.Error(), tc.message) {
			t.Fatalf("Prioritise(%q) = %d %q, want %d containing %q", tc.index, status, errPrioritise.Error(), tc.status, tc.message)
		}
	}
	if got := svc.Bursts(); len(got) != 0 {
		t.Fatalf("bursts = %+v", got)
	}
}

func TestBurstUsesFreshestFiveHourReading(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	// The usage body (fake fetcher) reports a reset at 15:00 UTC; stale headers
	// observed an hour earlier report a different, used-up window.
	auth := claudeBurstAuth("claude", "0", now.Add(-time.Hour), 100, time.Hour)
	fixture := &burstFixture{auths: []*coreauth.Auth{auth}}
	svc := newBurstService(t, "", clock, fixture)
	if _, errRefresh := svc.Refresh(context.Background(), []string{"claude-idx"}, true); errRefresh != nil {
		t.Fatalf("Refresh: %v", errRefresh)
	}
	bursts, errPrioritise := svc.Prioritise("claude-idx")
	if errPrioritise != nil {
		t.Fatalf("Prioritise: %v", errPrioritise)
	}
	if want := time.Date(2026, 10, 26, 15, 0, 0, 0, time.UTC); len(bursts) != 1 || !bursts[0].EndsAt.Equal(want) {
		t.Fatalf("bursts = %+v, want ends_at %s", bursts, want)
	}

	// Newer headers win over the snapshot.
	clock.Set(now.Add(time.Minute))
	fixture.mutate(func(auths []*coreauth.Auth) []*coreauth.Auth {
		return []*coreauth.Auth{claudeBurstAuth("claude", "0", now.Add(time.Minute), 100, 30*time.Minute)}
	})
	if _, errCancel := svc.CancelBurst("claude-idx"); errCancel != nil {
		t.Fatalf("CancelBurst: %v", errCancel)
	}
	if _, errPrioritise := svc.Prioritise("claude-idx"); errPrioritise == nil || requestStatus(t, errPrioritise) != http.StatusConflict {
		t.Fatalf("Prioritise with newer used-up headers = %v", errPrioritise)
	}
}

func TestBurstPersistenceRoundTripAndCorruptRecovery(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	fixture := &burstFixture{auths: []*coreauth.Auth{claudeBurstAuth("a", "0", now, 10, 2*time.Hour)}}
	svc := newBurstService(t, dir, clock, fixture)
	if _, errPrioritise := svc.Prioritise("a-idx"); errPrioritise != nil {
		t.Fatalf("Prioritise: %v", errPrioritise)
	}
	path := filepath.Join(dir, burstFileName)
	info, errStat := os.Stat(path)
	if errStat != nil {
		t.Fatalf("stat burst file: %v", errStat)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("burst file mode = %o, want 600", perm)
	}

	// A new service restores the burst and publishes its override on start.
	restoredFixture := &burstFixture{auths: fixture.list()}
	restored := newBurstService(t, dir, clock, restoredFixture)
	if got := restoredFixture.current(); got["a"] != BurstPriorityBase-1 {
		t.Fatalf("restored overrides = %v", got)
	}
	got := restored.Bursts()
	if len(got) != 1 || got[0].AuthIndex != "a-idx" || !got[0].EndsAt.Equal(now.Add(2*time.Hour)) || !got[0].StartedAt.Equal(now) {
		t.Fatalf("restored bursts = %+v", got)
	}

	// A burst that ended while the service was down is dropped on load.
	clock.Set(now.Add(3 * time.Hour))
	expiredFixture := &burstFixture{auths: fixture.list()}
	expired := newBurstService(t, dir, clock, expiredFixture)
	if got := expired.Bursts(); len(got) != 0 {
		t.Fatalf("bursts after downtime reset = %+v", got)
	}

	if errWrite := os.WriteFile(path, []byte("{not json"), 0o600); errWrite != nil {
		t.Fatalf("write corrupt file: %v", errWrite)
	}
	corruptFixture := &burstFixture{auths: fixture.list()}
	recovered := newBurstService(t, dir, clock, corruptFixture)
	if got := recovered.Bursts(); len(got) != 0 {
		t.Fatalf("bursts after corrupt file = %+v", got)
	}
	corruptPath := path + ".corrupt-" + strconv.FormatInt(clock.Now().Unix(), 10)
	if _, errStatCorrupt := os.Stat(corruptPath); errStatCorrupt != nil {
		t.Fatalf("corrupt file not moved aside: %v", errStatCorrupt)
	}
	if _, errStatPath := os.Stat(path); !os.IsNotExist(errStatPath) {
		t.Fatalf("corrupt file still in place: %v", errStatPath)
	}
	entries, errRead := os.ReadDir(dir)
	if errRead != nil {
		t.Fatal(errRead)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			t.Fatalf("unexpected .json file %s", entry.Name())
		}
	}
}

func TestHistoryReportsBasePriorityWhileBursting(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	fixture := &burstFixture{auths: []*coreauth.Auth{claudeBurstAuth("history-burst-base", "7", now, 10, 2*time.Hour)}}
	// Publish through the real SDK registry so the check covers the routing override itself.
	svc := New(Options{Fetcher: &fakeFetcher{}, Auths: fixture.list, Now: clock.Now, ApplyPriorityOverrides: func(overrides map[string]int) {
		coreauth.SetPriorityOverrides(overrides)
	}})
	t.Cleanup(func() { coreauth.SetPriorityOverrides(nil) })
	if _, errPrioritise := svc.Prioritise("history-burst-base-idx"); errPrioritise != nil {
		t.Fatalf("Prioritise: %v", errPrioritise)
	}
	if got := coreauth.PriorityOverrides()["history-burst-base"]; got != BurstPriorityBase-1 {
		t.Fatalf("routing override = %d, want %d", got, BurstPriorityBase-1)
	}
	result := svc.History(ProviderClaude, Window5h, now.Add(-time.Hour).Unix(), now.Unix())
	if got := result.Accounts["history-burst-base-idx"].Priority; got != 7 {
		t.Fatalf("history priority = %d, want base priority 7", got)
	}
}

func TestBurstEndsWhenFiveHourLimitUsedUp(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	reset := now.Add(2 * time.Hour)

	cases := []struct {
		name   string
		update func(auth *coreauth.Auth, at time.Time)
	}{
		{"utilization reaches 100%", func(auth *coreauth.Auth, at time.Time) {
			auth.Quota.ObservedAt = at
			auth.Quota.Signals = map[string]string{
				"Anthropic-Ratelimit-Unified-5h-Utilization": "1.0",
				"Anthropic-Ratelimit-Unified-5h-Reset":       strconv.FormatInt(reset.Unix(), 10),
			}
		}},
		{"5-hour status rejected", func(auth *coreauth.Auth, at time.Time) {
			auth.Quota.ObservedAt = at
			auth.Quota.Signals = map[string]string{
				"Anthropic-Ratelimit-Unified-5h-Utilization": "0.97",
				"Anthropic-Ratelimit-Unified-5h-Reset":       strconv.FormatInt(reset.Unix(), 10),
				"Anthropic-Ratelimit-Unified-5h-Status":      "rejected",
			}
		}},
		{"quota cooldown until the reset", func(auth *coreauth.Auth, _ time.Time) {
			auth.Quota.Exceeded = true
			auth.Quota.Reason = "credential_quota"
			auth.Quota.NextRecoverAt = reset
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clock := newFakeClock(now)
			fixture := &burstFixture{auths: []*coreauth.Auth{
				claudeBurstAuth("a", "0", now, 40, 2*time.Hour),
				claudeBurstAuth("b", "0", now, 40, 3*time.Hour),
			}}
			svc := newBurstService(t, "", clock, fixture)
			for _, index := range []string{"a-idx", "b-idx"} {
				if _, errPrioritise := svc.Prioritise(index); errPrioritise != nil {
					t.Fatalf("Prioritise(%s): %v", index, errPrioritise)
				}
			}

			later := now.Add(20 * time.Minute)
			clock.Set(later)
			fixture.mutate(func(auths []*coreauth.Auth) []*coreauth.Auth {
				tc.update(auths[0], later)
				return auths
			})
			svc.SweepBursts()
			got := svc.Bursts()
			if len(got) != 1 || got[0].AuthIndex != "b-idx" || got[0].Order != 1 {
				t.Fatalf("bursts after limit used up = %+v", got)
			}
			if overrides := fixture.current(); overrides["b"] != BurstPriorityBase-1 || len(overrides) != 1 {
				t.Fatalf("overrides after limit used up = %v", overrides)
			}
		})
	}
}

func TestBurstIgnoresExhaustedReadingFromBeforeItStarted(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	auth := claudeBurstAuth("a", "0", now, 40, 2*time.Hour)
	fixture := &burstFixture{auths: []*coreauth.Auth{auth}}
	svc := newBurstService(t, "", clock, fixture)
	if _, errPrioritise := svc.Prioritise("a-idx"); errPrioritise != nil {
		t.Fatalf("Prioritise: %v", errPrioritise)
	}

	// A reading older than the burst (e.g. replayed from a slow response) says 100 %.
	clock.Set(now.Add(10 * time.Minute))
	fixture.mutate(func(auths []*coreauth.Auth) []*coreauth.Auth {
		auths[0].Quota.ObservedAt = now.Add(-time.Minute)
		auths[0].Quota.Signals["Anthropic-Ratelimit-Unified-5h-Utilization"] = "1.0"
		return auths
	})
	if got := svc.Bursts(); len(got) != 1 {
		t.Fatalf("burst ended on a stale reading: %+v", got)
	}

	// A short cooldown (not until the reset) does not end it either.
	fixture.mutate(func(auths []*coreauth.Auth) []*coreauth.Auth {
		auths[0].Quota.Exceeded = true
		auths[0].Quota.Reason = "credential_quota"
		auths[0].Quota.NextRecoverAt = now.Add(15 * time.Minute)
		return auths
	})
	if got := svc.Bursts(); len(got) != 1 {
		t.Fatalf("burst ended on a short cooldown: %+v", got)
	}
}

func TestPrioritiseRefreshesStaleWindowFirst(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	// The only reading is from the previous window: its reset passed a minute ago.
	fixture := &burstFixture{auths: []*coreauth.Auth{claudeBurstAuth("claude", "0", now.Add(-5*time.Hour), 10, 5*time.Hour-time.Minute)}}
	fetcher := &fakeFetcher{}
	svc := New(Options{Fetcher: fetcher, Auths: fixture.list, Now: clock.Now, ApplyPriorityOverrides: fixture.apply})

	bursts, errPrioritise := svc.Prioritise("claude-idx")
	if errPrioritise != nil {
		t.Fatalf("Prioritise: %v", errPrioritise)
	}
	if want := time.Date(2026, 10, 26, 15, 0, 0, 0, time.UTC); len(bursts) != 1 || !bursts[0].EndsAt.Equal(want) {
		t.Fatalf("bursts = %+v, want ends_at %s from the refreshed usage", bursts, want)
	}
	if calls := fetcher.usageCalls(); calls != 1 {
		t.Fatalf("usage calls = %d, want 1", calls)
	}
}

func TestPrioritiseRefreshIsRateLimited(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	fixture := &burstFixture{auths: []*coreauth.Auth{claudeBurstAuth("claude", "0", now, 0, 0)}}
	fetcher := &fakeFetcher{} // its usage reports a reset on 2026-10-26: still no window
	svc := New(Options{Fetcher: fetcher, Auths: fixture.list, Now: clock.Now, ApplyPriorityOverrides: fixture.apply})

	for i := 0; i < 3; i++ {
		if _, errPrioritise := svc.Prioritise("claude-idx"); errPrioritise == nil || !strings.Contains(errPrioritise.Error(), "no running 5-hour window") {
			t.Fatalf("Prioritise #%d = %v", i, errPrioritise)
		}
		clock.Advance(10 * time.Second)
	}
	if calls := fetcher.usageCalls(); calls != 1 {
		t.Fatalf("usage calls = %d, want 1 within a minute", calls)
	}
}

// withWeekly adds a weekly (7-day) window to a Claude test credential.
func withWeekly(auth *coreauth.Auth, used float64, resetAt time.Time) *coreauth.Auth {
	auth.Quota.Signals["Anthropic-Ratelimit-Unified-7d-Utilization"] = strconv.FormatFloat(used/100, 'f', -1, 64)
	auth.Quota.Signals["Anthropic-Ratelimit-Unified-7d-Reset"] = strconv.FormatInt(resetAt.Unix(), 10)
	return auth
}

func TestWeeklyBurstEligibility(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	weeklyReset := now.Add(72 * time.Hour)
	// 5-hour limit used up but weekly quota left: weekly prioritise is allowed.
	fiveHourOut := withWeekly(claudeBurstAuth("five-out", "0", now, 100, time.Hour), 40, weeklyReset)
	fiveHourOut.Quota.Signals["Anthropic-Ratelimit-Unified-5h-Status"] = "rejected"
	weeklyFull := withWeekly(claudeBurstAuth("weekly-full", "0", now, 10, time.Hour), 100, weeklyReset)
	weeklyRejected := withWeekly(claudeBurstAuth("weekly-rejected", "0", now, 10, time.Hour), 60, weeklyReset)
	weeklyRejected.Quota.Signals["Anthropic-Ratelimit-Unified-7d-Status"] = "rejected"
	fixture := &burstFixture{auths: []*coreauth.Auth{
		fiveHourOut,
		weeklyFull,
		weeklyRejected,
		claudeBurstAuth("no-weekly", "0", now, 10, time.Hour),
		codexBurstAuth("codex", now, 30, time.Hour),
	}}
	// Polled usage has no weekly window, so the refresh before prioritising
	// cannot supply one for "no-weekly".
	fetcher := &fakeFetcher{respond: func(_, url string) (FetchResponse, error) {
		if strings.Contains(url, "api/oauth/usage") {
			return FetchResponse{StatusCode: 200, Body: []byte(`{"five_hour":{"utilization":10,"resets_at":"2026-10-28T13:00:00Z"}}`)}, nil
		}
		return defaultResponse(url), nil
	}}
	svc := New(Options{Fetcher: fetcher, Auths: fixture.list, Now: clock.Now, ApplyPriorityOverrides: fixture.apply})

	for _, tc := range []struct {
		index   string
		status  int
		message string
	}{
		{"weekly-full-idx", http.StatusConflict, "weekly window already used up"},
		{"weekly-rejected-idx", http.StatusConflict, "weekly window already used up"},
		{"no-weekly-idx", http.StatusConflict, "no running weekly window"},
		{"five-out-idx", 0, ""},
		{"codex-idx", 0, ""},
	} {
		_, errPrioritise := svc.PrioritiseKind(tc.index, BurstKindWeekly)
		if tc.status == 0 {
			if errPrioritise != nil {
				t.Fatalf("PrioritiseKind(%s, weekly): %v", tc.index, errPrioritise)
			}
			continue
		}
		if errPrioritise == nil || requestStatus(t, errPrioritise) != tc.status || !strings.Contains(errPrioritise.Error(), tc.message) {
			t.Fatalf("PrioritiseKind(%s, weekly) = %v, want %d %q", tc.index, errPrioritise, tc.status, tc.message)
		}
	}
	if _, errKind := svc.PrioritiseKind("five-out-idx", "monthly"); errKind == nil || requestStatus(t, errKind) != http.StatusBadRequest {
		t.Fatalf("unknown kind = %v", errKind)
	}

	got := svc.Bursts()
	if len(got) != 2 {
		t.Fatalf("bursts = %+v", got)
	}
	byIndex := map[string]Burst{}
	for _, b := range got {
		byIndex[b.AuthIndex] = b
	}
	if b := byIndex["five-out-idx"]; b.Kind != BurstKindWeekly || !b.EndsAt.Equal(weeklyReset) {
		t.Fatalf("claude weekly burst = %+v", b)
	}
	if b := byIndex["codex-idx"]; b.Kind != BurstKindWeekly || !b.EndsAt.Equal(now.Add(72*time.Hour)) {
		t.Fatalf("codex weekly burst = %+v", b)
	}
}

func TestWeeklyBurstSurvivesFiveHourExhaustion(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	weeklyReset := now.Add(72 * time.Hour)
	fixture := &burstFixture{auths: []*coreauth.Auth{withWeekly(claudeBurstAuth("a", "0", now, 40, 2*time.Hour), 30, weeklyReset)}}
	svc := newBurstService(t, "", clock, fixture)
	if _, errPrioritise := svc.PrioritiseKind("a-idx", BurstKindWeekly); errPrioritise != nil {
		t.Fatalf("PrioritiseKind: %v", errPrioritise)
	}

	// The 5-hour window runs out and the proxy cools the account down until it resets.
	later := now.Add(30 * time.Minute)
	clock.Set(later)
	fixture.mutate(func(auths []*coreauth.Auth) []*coreauth.Auth {
		auth := auths[0]
		auth.Quota.ObservedAt = later
		auth.Quota.Signals["Anthropic-Ratelimit-Unified-5h-Utilization"] = "1.0"
		auth.Quota.Signals["Anthropic-Ratelimit-Unified-5h-Status"] = "rejected"
		auth.Quota.Exceeded = true
		auth.Quota.Reason = "credential_quota"
		auth.Quota.NextRecoverAt = now.Add(2 * time.Hour)
		return auths
	})
	svc.SweepBursts()
	if got := svc.Bursts(); len(got) != 1 || got[0].Kind != BurstKindWeekly {
		t.Fatalf("weekly burst ended by a 5-hour cooldown: %+v", got)
	}
	if overrides := fixture.current(); overrides["a"] != BurstPriorityBase-1 {
		t.Fatalf("overrides = %v", overrides)
	}
	// It stays prioritised past the 5-hour reset.
	clock.Set(now.Add(3 * time.Hour))
	if got := svc.Bursts(); len(got) != 1 {
		t.Fatalf("weekly burst ended at the 5-hour reset: %+v", got)
	}
	// It ends at the weekly reset.
	clock.Set(weeklyReset)
	if got := svc.Bursts(); len(got) != 0 {
		t.Fatalf("weekly burst outlived its reset: %+v", got)
	}
}

func TestWeeklyBurstEndsWhenWeeklyLimitUsedUp(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	weeklyReset := now.Add(72 * time.Hour)
	cases := []struct {
		name   string
		update func(auth *coreauth.Auth, at time.Time)
	}{
		{"weekly utilization reaches 100%", func(auth *coreauth.Auth, at time.Time) {
			auth.Quota.ObservedAt = at
			auth.Quota.Signals["Anthropic-Ratelimit-Unified-7d-Utilization"] = "1.0"
		}},
		{"weekly status rejected", func(auth *coreauth.Auth, at time.Time) {
			auth.Quota.ObservedAt = at
			auth.Quota.Signals["Anthropic-Ratelimit-Unified-7d-Status"] = "rejected"
		}},
		{"quota cooldown until the weekly reset", func(auth *coreauth.Auth, _ time.Time) {
			auth.Quota.Exceeded = true
			auth.Quota.Reason = "credential_quota"
			auth.Quota.NextRecoverAt = weeklyReset
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clock := newFakeClock(now)
			fixture := &burstFixture{auths: []*coreauth.Auth{withWeekly(claudeBurstAuth("a", "0", now, 40, 2*time.Hour), 30, weeklyReset)}}
			svc := newBurstService(t, "", clock, fixture)
			if _, errPrioritise := svc.PrioritiseKind("a-idx", BurstKindWeekly); errPrioritise != nil {
				t.Fatalf("PrioritiseKind: %v", errPrioritise)
			}
			later := now.Add(time.Hour)
			clock.Set(later)
			fixture.mutate(func(auths []*coreauth.Auth) []*coreauth.Auth {
				tc.update(auths[0], later)
				return auths
			})
			if got := svc.Bursts(); len(got) != 0 {
				t.Fatalf("bursts after weekly limit used up = %+v", got)
			}
			if overrides := fixture.current(); len(overrides) != 0 {
				t.Fatalf("overrides = %v", overrides)
			}
		})
	}
}

func TestBurstKindSwitchAndOrder(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	fixture := &burstFixture{auths: []*coreauth.Auth{
		withWeekly(claudeBurstAuth("a", "0", now, 40, 2*time.Hour), 30, now.Add(48*time.Hour)),
		withWeekly(claudeBurstAuth("b", "0", now, 40, 3*time.Hour), 30, now.Add(96*time.Hour)),
	}}
	svc := newBurstService(t, "", clock, fixture)
	if _, errPrioritise := svc.PrioritiseKind("a-idx", BurstKindWeekly); errPrioritise != nil {
		t.Fatalf("a weekly: %v", errPrioritise)
	}
	got, errPrioritise := svc.Prioritise("b-idx")
	if errPrioritise != nil {
		t.Fatalf("b 5h: %v", errPrioritise)
	}
	// The 5-hour burst resets sooner, so it routes first.
	if len(got) != 2 || got[0].AuthIndex != "b-idx" || got[0].Kind != BurstKind5h || got[1].AuthIndex != "a-idx" || got[1].Kind != BurstKindWeekly {
		t.Fatalf("order = %+v", got)
	}
	// Same kind again is a no-op; the other kind replaces the burst.
	again, _ := svc.PrioritiseKind("a-idx", BurstKindWeekly)
	if len(again) != 2 {
		t.Fatalf("repeat = %+v", again)
	}
	switched, errSwitch := svc.PrioritiseKind("b-idx", BurstKindWeekly)
	if errSwitch != nil {
		t.Fatalf("switch: %v", errSwitch)
	}
	if len(switched) != 2 || switched[1].AuthIndex != "b-idx" || switched[1].Kind != BurstKindWeekly || !switched[1].EndsAt.Equal(now.Add(96*time.Hour)) {
		t.Fatalf("after switch = %+v", switched)
	}
}

func TestBurstKindPersistsAndLegacyRecordsAreFiveHour(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(now)
	fixture := &burstFixture{auths: []*coreauth.Auth{
		withWeekly(claudeBurstAuth("a", "0", now, 10, 2*time.Hour), 20, now.Add(72*time.Hour)),
		claudeBurstAuth("b", "0", now, 10, 3*time.Hour),
	}}
	// A file written before weekly bursts existed has no kind field.
	legacy := `{"version":` + strconv.Itoa(fileVersion) + `,"bursts":[{"auth_index":"b-idx","auth_id":"b","provider":"claude","started_at":"2026-10-28T11:00:00Z","ends_at":"2026-10-28T15:00:00Z"}]}`
	if errWrite := os.WriteFile(filepath.Join(dir, burstFileName), []byte(legacy), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	svc := newBurstService(t, dir, clock, fixture)
	if _, errPrioritise := svc.PrioritiseKind("a-idx", BurstKindWeekly); errPrioritise != nil {
		t.Fatalf("PrioritiseKind: %v", errPrioritise)
	}
	restored := newBurstService(t, dir, clock, &burstFixture{auths: fixture.list()})
	kinds := map[string]string{}
	for _, b := range restored.Bursts() {
		kinds[b.AuthIndex] = b.Kind
	}
	if kinds["a-idx"] != BurstKindWeekly || kinds["b-idx"] != BurstKind5h {
		t.Fatalf("restored kinds = %v", kinds)
	}
}
