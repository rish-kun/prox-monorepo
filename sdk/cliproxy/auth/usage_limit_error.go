package auth

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/tidwall/gjson"
)

// usageLimitMinReset is the shortest pool-wide cooldown reported as a usage limit when the
// upstream cause does not say so explicitly. Shorter cooldowns come from transient failures
// (throttling, 5xx), which clients should keep retrying.
const usageLimitMinReset = 10 * time.Minute

// usageLimitCauseMarkers identify upstream errors that mean a subscription quota window is
// spent (Codex "usage_limit_reached", OpenAI "insufficient_quota", and similar).
var usageLimitCauseMarkers = [...]string{
	"usage_limit_reached",
	"usage limit",
	"insufficient_quota",
	"quota_exceeded",
	"quota exceeded",
}

// UsageLimitReset reports whether every credential for the model is exhausted by a
// subscription usage window rather than a transient failure, and when the first one resets.
//
// Handlers use it to answer in the shape each client recognises as "out of quota":
// Codex looks for error.type "usage_limit_reached", Claude Code for the unified
// rate-limit headers. A generic 429 makes both retry into a window that is hours away.
func (e *modelCooldownError) UsageLimitReset() (time.Time, bool) {
	if e == nil || !e.isUsageLimit() {
		return time.Time{}, false
	}
	return e.resetAt, true
}

func (e *modelCooldownError) isUsageLimit() bool {
	cause := strings.ToLower(e.causeText())
	for _, marker := range usageLimitCauseMarkers {
		if strings.Contains(cause, marker) {
			return true
		}
	}
	// A credential parked for hours because it cannot serve the model is not out of quota.
	if isModelSupportErrorMessage(cause) {
		return false
	}
	return e.resetIn >= usageLimitMinReset
}

func (e *modelCooldownError) causeText() string {
	if e == nil || e.cause == nil {
		return ""
	}
	return e.cause.Error()
}

// planType extracts the upstream plan (e.g. "plus") from the cause body when present.
func (e *modelCooldownError) planType() string {
	text := e.causeText()
	start := strings.Index(text, "{")
	if start < 0 {
		return ""
	}
	body := text[start:]
	if !gjson.Valid(body) {
		return ""
	}
	for _, path := range []string{"error.plan_type", "plan_type"} {
		if value := strings.TrimSpace(gjson.Get(body, path).String()); value != "" {
			return value
		}
	}
	return ""
}

// usageLimitBody renders the pool-wide exhaustion in the OpenAI/Codex usage-limit shape:
// {"error":{"type":"usage_limit_reached","resets_at":<unix>,"resets_in_seconds":<n>,...}}.
func (e *modelCooldownError) usageLimitBody() string {
	resetSeconds := int(math.Ceil(e.resetIn.Seconds()))
	if resetSeconds < 0 {
		resetSeconds = 0
	}
	modelName := e.model
	if modelName == "" {
		modelName = "the requested model"
	}
	scope := "credentials"
	if e.provider != "" {
		scope = e.provider + " credentials"
	}
	message := fmt.Sprintf(
		"The usage limit has been reached. All %s for %s are out of quota; the next one resets in %s.",
		scope, modelName, e.resetIn.Round(time.Second),
	)
	errorBody := map[string]any{
		"type":              "usage_limit_reached",
		"code":              "usage_limit_reached",
		"message":           message,
		"resets_at":         e.resetAt.Unix(),
		"resets_in_seconds": resetSeconds,
		"model":             e.model,
	}
	if e.provider != "" {
		errorBody["provider"] = e.provider
	}
	if plan := e.planType(); plan != "" {
		errorBody["plan_type"] = plan
	}
	data, err := json.Marshal(map[string]any{"error": errorBody})
	if err != nil {
		return fmt.Sprintf(`{"error":{"type":"usage_limit_reached","code":"usage_limit_reached","message":%q}}`, message)
	}
	return string(data)
}
