package auth

import (
	"errors"
	"testing"
	"time"

	"github.com/tidwall/gjson"
)

func TestModelCooldownUsageLimitFromCodexCause(t *testing.T) {
	cause := errors.New(`429: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1,"resets_in_seconds":1}}`)
	before := time.Now()
	err := newModelCooldownErrorWithCause("gpt-6.1-sol", "codex", 7*time.Minute, cause)

	resetAt, ok := err.UsageLimitReset()
	if !ok {
		t.Fatal("UsageLimitReset() = false, want true for a usage_limit_reached cause")
	}
	if resetAt.Before(before.Add(7*time.Minute)) || resetAt.After(time.Now().Add(7*time.Minute)) {
		t.Fatalf("resetAt = %v, want about now+7m", resetAt)
	}

	body := err.Error()
	if !gjson.Valid(body) {
		t.Fatalf("body is not JSON: %s", body)
	}
	for path, want := range map[string]string{
		"error.type":      "usage_limit_reached",
		"error.code":      "usage_limit_reached",
		"error.plan_type": "plus",
		"error.model":     "gpt-6.1-sol",
		"error.provider":  "codex",
	} {
		if got := gjson.Get(body, path).String(); got != want {
			t.Errorf("%s = %q, want %q (body %s)", path, got, want, body)
		}
	}
	if got := gjson.Get(body, "error.resets_in_seconds").Int(); got != 420 {
		t.Errorf("resets_in_seconds = %d, want 420", got)
	}
	if got := gjson.Get(body, "error.resets_at").Int(); got != resetAt.Unix() {
		t.Errorf("resets_at = %d, want %d", got, resetAt.Unix())
	}
	if msg := gjson.Get(body, "error.message").String(); msg == "" {
		t.Error("message is empty")
	}
	if got := err.StatusCode(); got != 429 {
		t.Errorf("StatusCode() = %d, want 429", got)
	}
}

func TestModelCooldownLongResetWithoutCauseIsUsageLimit(t *testing.T) {
	err := newModelCooldownError("claude-opus-5-5", "claude", 3*time.Hour)
	if _, ok := err.UsageLimitReset(); !ok {
		t.Fatal("a pool-wide cooldown of hours should be reported as a usage limit")
	}
	if got := gjson.Get(err.Error(), "error.type").String(); got != "usage_limit_reached" {
		t.Fatalf("error.type = %q, want usage_limit_reached", got)
	}
}

func TestModelCooldownShortTransientStaysGeneric(t *testing.T) {
	err := newModelCooldownErrorWithCause("gpt-6.1-sol", "codex", 30*time.Second, errors.New("502: bad gateway"))
	if _, ok := err.UsageLimitReset(); ok {
		t.Fatal("a short transient cooldown must not be reported as a usage limit")
	}
	body := err.Error()
	if got := gjson.Get(body, "error.code").String(); got != "model_cooldown" {
		t.Fatalf("error.code = %q, want model_cooldown (body %s)", got, body)
	}
	if gjson.Get(body, "error.type").Exists() {
		t.Fatalf("generic cooldown must not carry a usage-limit type: %s", body)
	}
}

func TestModelCooldownUnsupportedModelIsNotUsageLimit(t *testing.T) {
	cause := errors.New(`400: {"detail":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}`)
	err := newModelCooldownErrorWithCause("gpt-6.1-sol", "codex", 12*time.Hour, cause)
	if _, ok := err.UsageLimitReset(); ok {
		t.Fatal("a credential parked because it cannot serve the model is not out of quota")
	}
	if got := gjson.Get(err.Error(), "error.code").String(); got != "model_cooldown" {
		t.Fatalf("error.code = %q, want model_cooldown", got)
	}
}
