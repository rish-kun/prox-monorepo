package auth

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// Priority overrides are process-wide, so these tests never run in parallel and
// always clear the registry when they finish.
func resetPriorityOverridesForTest(t *testing.T) {
	t.Helper()
	SetPriorityOverrides(nil)
	t.Cleanup(func() { SetPriorityOverrides(nil) })
}

const testBurstBase = 1 << 30

func TestAuthPriorityPrefersOverride(t *testing.T) {
	resetPriorityOverridesForTest(t)
	auth := &Auth{ID: "override-auth", Attributes: map[string]string{"priority": "5"}}
	bare := &Auth{ID: "override-bare"}
	if got := authPriority(auth); got != 5 {
		t.Fatalf("authPriority = %d, want 5", got)
	}

	changed := SetPriorityOverrides(map[string]int{"override-auth": testBurstBase - 1, "override-bare": testBurstBase - 2, " ": 9})
	if len(changed) != 2 {
		t.Fatalf("changed = %v, want both auths", changed)
	}
	if got := authPriority(auth); got != testBurstBase-1 {
		t.Fatalf("authPriority with override = %d", got)
	}
	if got := authPriority(bare); got != testBurstBase-2 {
		t.Fatalf("authPriority without attributes = %d", got)
	}
	if auth.Attributes["priority"] != "5" {
		t.Fatalf("override modified the auth attribute: %q", auth.Attributes["priority"])
	}
	if changed := SetPriorityOverrides(map[string]int{"override-auth": testBurstBase - 1, "override-bare": testBurstBase - 2}); len(changed) != 0 {
		t.Fatalf("unchanged overrides reported %v", changed)
	}

	high := &Auth{ID: "override-high", Attributes: map[string]string{"priority": "100"}}
	if got := highestPriorityAuths([]*Auth{high, auth, bare}); len(got) != 1 || got[0].ID != auth.ID {
		t.Fatalf("highestPriorityAuths = %v, want override auth only", got)
	}

	if changed := SetPriorityOverrides(nil); len(changed) != 2 {
		t.Fatalf("clearing changed = %v", changed)
	}
	if got := authPriority(auth); got != 5 {
		t.Fatalf("authPriority after clearing = %d, want 5", got)
	}
}

func TestSchedulerRefreshPrioritiesRebuildsBuckets(t *testing.T) {
	resetPriorityOverridesForTest(t)
	scheduler := newSchedulerForTest(
		&RoundRobinSelector{},
		&Auth{ID: "refresh-high", Provider: "gemini", Attributes: map[string]string{"priority": "10"}},
		&Auth{ID: "refresh-low", Provider: "gemini", Attributes: map[string]string{"priority": "0"}},
	)
	pick := func() string {
		t.Helper()
		got, errPick := scheduler.pickSingle(context.Background(), "gemini", "", cliproxyexecutor.Options{}, nil)
		if errPick != nil || got == nil {
			t.Fatalf("pickSingle = %v, %v", got, errPick)
		}
		return got.ID
	}
	if got := pick(); got != "refresh-high" {
		t.Fatalf("pick = %q, want refresh-high", got)
	}
	changed := SetPriorityOverrides(map[string]int{"refresh-low": testBurstBase - 1})
	if got := pick(); got != "refresh-high" {
		t.Fatalf("pick before refresh = %q; buckets are expected to be stale until refreshed", got)
	}
	scheduler.refreshPriorities(changed)
	if got := pick(); got != "refresh-low" {
		t.Fatalf("pick after refresh = %q, want refresh-low", got)
	}
	scheduler.refreshPriorities(SetPriorityOverrides(nil))
	if got := pick(); got != "refresh-high" {
		t.Fatalf("pick after clearing = %q, want refresh-high", got)
	}
}

func registerOverrideTestAuths(t *testing.T, manager *Manager, provider, model string, auths ...*Auth) {
	t.Helper()
	ctx := WithSkipPersist(context.Background())
	for _, auth := range auths {
		if _, errRegister := manager.Register(ctx, auth); errRegister != nil {
			t.Fatalf("Register(%s): %v", auth.ID, errRegister)
		}
		registry.GetGlobalRegistry().RegisterClient(auth.ID, provider, []*registry.ModelInfo{{ID: model}})
		authID := auth.ID
		t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(authID) })
		manager.RefreshSchedulerEntry(auth.ID)
	}
}

func markOverrideTestQuota(manager *Manager, provider, model, authID string) {
	manager.MarkResult(context.Background(), Result{
		AuthID:   authID,
		Provider: provider,
		Model:    model,
		Success:  false,
		Error:    &Error{HTTPStatus: http.StatusTooManyRequests, Message: "quota"},
	})
}

func TestManagerApplyPriorityOverridesSchedulerPicksBurstFirst(t *testing.T) {
	resetPriorityOverridesForTest(t)
	provider := "burst-scheduler"
	model := "burst-scheduler-model"
	normalID := provider + "-normal"
	burstAID := provider + "-burst-a"
	burstBID := provider + "-burst-b"

	manager := NewManager(nil, &RoundRobinSelector{}, nil)
	manager.RegisterExecutor(schedulerTestExecutor{provider: provider})
	registerOverrideTestAuths(t, manager, provider, model,
		&Auth{ID: normalID, Provider: provider, Status: StatusActive, Attributes: map[string]string{"priority": "50"}},
		&Auth{ID: burstAID, Provider: provider, Status: StatusActive, Attributes: map[string]string{"priority": "0"}},
		&Auth{ID: burstBID, Provider: provider, Status: StatusActive, Attributes: map[string]string{"priority": "0"}},
	)
	if !manager.useSchedulerFastPath() {
		t.Fatal("expected the built-in scheduler fast path")
	}
	pick := func() string {
		t.Helper()
		auth, _, errPick := manager.pickNext(context.Background(), provider, model, cliproxyexecutor.Options{}, nil)
		if errPick != nil || auth == nil {
			t.Fatalf("pickNext = %v, %v", auth, errPick)
		}
		return auth.ID
	}

	if got := pick(); got != normalID {
		t.Fatalf("pick without bursts = %q, want %q", got, normalID)
	}

	manager.ApplyPriorityOverrides(map[string]int{burstAID: testBurstBase - 1, burstBID: testBurstBase - 2})
	for i := 0; i < 3; i++ {
		if got := pick(); got != burstAID {
			t.Fatalf("pick #%d with bursts = %q, want first burst %q", i, got, burstAID)
		}
	}

	// A cooling burst account is skipped: traffic falls through to the next burst,
	// then to normal priorities.
	markOverrideTestQuota(manager, provider, model, burstAID)
	if got := pick(); got != burstBID {
		t.Fatalf("pick with first burst cooling = %q, want %q", got, burstBID)
	}
	markOverrideTestQuota(manager, provider, model, burstBID)
	if got := pick(); got != normalID {
		t.Fatalf("pick with every burst cooling = %q, want %q", got, normalID)
	}

	expireSessionAffinityPriorityModelCooldown(t, manager, burstAID, model)
	manager.RefreshSchedulerEntry(burstAID)
	if got := pick(); got != burstAID {
		t.Fatalf("pick after first burst recovered = %q, want %q", got, burstAID)
	}

	// Removing the bursts (cancel or expiry) restores normal priority order at once.
	manager.ApplyPriorityOverrides(nil)
	if got := pick(); got != normalID {
		t.Fatalf("pick after bursts ended = %q, want %q", got, normalID)
	}
}

func TestManagerApplyPriorityOverridesRepairsUnchangedOverrides(t *testing.T) {
	resetPriorityOverridesForTest(t)
	provider := "burst-repair"
	model := "burst-repair-model"
	normalID := provider + "-normal"
	burstID := provider + "-burst"

	manager := NewManager(nil, &RoundRobinSelector{}, nil)
	manager.RegisterExecutor(schedulerTestExecutor{provider: provider})
	registerOverrideTestAuths(t, manager, provider, model,
		&Auth{ID: normalID, Provider: provider, Status: StatusActive, Attributes: map[string]string{"priority": "50"}},
		&Auth{ID: burstID, Provider: provider, Status: StatusActive, Attributes: map[string]string{"priority": "0"}},
	)
	// The overrides were installed without this manager (e.g. before it existed),
	// so its scheduler still holds the base priorities.
	SetPriorityOverrides(map[string]int{burstID: testBurstBase - 1})
	manager.ApplyPriorityOverrides(map[string]int{burstID: testBurstBase - 1})
	auth, _, errPick := manager.pickNext(context.Background(), provider, model, cliproxyexecutor.Options{}, nil)
	if errPick != nil || auth == nil || auth.ID != burstID {
		t.Fatalf("pickNext = %v, %v; want %q", auth, errPick, burstID)
	}
}

func TestSessionAffinityYieldsToReadyBurst(t *testing.T) {
	resetPriorityOverridesForTest(t)
	for _, testCase := range []struct {
		name string
		pick func(*Manager, context.Context, string, string, cliproxyexecutor.Options) (*Auth, error)
	}{
		{
			name: "single",
			pick: func(manager *Manager, ctx context.Context, provider, model string, opts cliproxyexecutor.Options) (*Auth, error) {
				auth, _, errPick := manager.pickNext(ctx, provider, model, opts, nil)
				return auth, errPick
			},
		},
		{
			name: "mixed",
			pick: func(manager *Manager, ctx context.Context, provider, model string, opts cliproxyexecutor.Options) (*Auth, error) {
				auth, _, _, errPick := manager.pickNextMixed(ctx, []string{provider}, model, opts, nil)
				return auth, errPick
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			defer SetPriorityOverrides(nil)
			ctx := context.Background()
			provider := "burst-affinity-" + testCase.name
			model := "burst-affinity-model"
			boundID := provider + "-bound"
			burstID := provider + "-burst"

			manager := NewManager(nil, nil, nil)
			affinity := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{Fallback: &RoundRobinSelector{}, TTL: time.Hour})
			defer affinity.Stop()
			manager.SetSelector(affinity)
			manager.RegisterExecutor(schedulerTestExecutor{provider: provider})
			registerOverrideTestAuths(t, manager, provider, model,
				&Auth{ID: boundID, Provider: provider, Status: StatusActive, Attributes: map[string]string{"priority": "10"}},
				&Auth{ID: burstID, Provider: provider, Status: StatusActive, Attributes: map[string]string{"priority": "0"}},
			)
			opts := cliproxyexecutor.Options{Metadata: map[string]any{cliproxyexecutor.DerivedSessionIDMetadataKey: "open-chat"}}
			pick := func() string {
				t.Helper()
				auth, errPick := testCase.pick(manager, ctx, provider, model, opts)
				if errPick != nil || auth == nil {
					t.Fatalf("pick = %v, %v", auth, errPick)
				}
				return auth.ID
			}

			if got := pick(); got != boundID {
				t.Fatalf("cold binding = %q, want %q", got, boundID)
			}

			// A burst that is not ready leaves the binding alone.
			markOverrideTestQuota(manager, provider, model, burstID)
			manager.ApplyPriorityOverrides(map[string]int{burstID: testBurstBase - 1})
			if got := pick(); got != boundID {
				t.Fatalf("binding while burst is cooling = %q, want %q", got, boundID)
			}

			// Once the burst is ready the open chat moves to it.
			expireSessionAffinityPriorityModelCooldown(t, manager, burstID, model)
			if got := pick(); got != burstID {
				t.Fatalf("binding with ready burst = %q, want %q", got, burstID)
			}

			// After the burst ends the moved session stays on its new binding,
			// exactly like normal affinity.
			manager.ApplyPriorityOverrides(nil)
			if got := pick(); got != burstID {
				t.Fatalf("binding after burst ended = %q, want sticky %q", got, burstID)
			}
		})
	}
}
