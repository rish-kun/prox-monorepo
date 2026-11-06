package quotapoll

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/codex"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const (
	fiveHourMaxWindow = 6 * time.Hour
	weeklyMinWindow   = 6 * 24 * time.Hour
)

// windowSample is one window reading extracted from a payload or headers.
type windowSample struct {
	window   string
	used     float64
	resetsAt int64
}

// classifyWindow maps a window length to a recorded window: up to 6 h is the
// 5-hour window, 6 days or more is weekly, anything else is ignored.
func classifyWindow(length time.Duration) string {
	switch {
	case length <= 0:
		return ""
	case length <= fiveHourMaxWindow:
		return Window5h
	case length >= weeklyMinWindow:
		return WindowWeekly
	default:
		return ""
	}
}

// extractPollSamples reads the 5-hour and weekly windows from a usage body.
func extractPollSamples(provider string, body []byte, at time.Time) []windowSample {
	var payload map[string]any
	if errUnmarshal := json.Unmarshal(body, &payload); errUnmarshal != nil || payload == nil {
		return nil
	}
	switch provider {
	case ProviderClaude:
		return extractClaudeUsage(payload)
	case ProviderCodex:
		return extractCodexUsage(payload, at)
	default:
		return nil
	}
}

func extractClaudeUsage(payload map[string]any) []windowSample {
	var out []windowSample
	for _, item := range []struct {
		keys   []string
		window string
	}{
		{keys: []string{"five_hour", "fiveHour"}, window: Window5h},
		{keys: []string{"seven_day", "sevenDay"}, window: WindowWeekly},
	} {
		obj := firstObject(payload, item.keys...)
		if obj == nil {
			continue
		}
		used, ok := toFloat(obj["utilization"])
		if !ok {
			continue
		}
		out = append(out, windowSample{window: item.window, used: used, resetsAt: toUnix(firstValue(obj, "resets_at", "resetsAt"))})
	}
	return out
}

func extractCodexUsage(payload map[string]any, at time.Time) []windowSample {
	rateLimit := firstObject(payload, "rate_limit", "rateLimit")
	if rateLimit == nil {
		return nil
	}
	var out []windowSample
	for _, keys := range [][]string{{"primary_window", "primaryWindow"}, {"secondary_window", "secondaryWindow"}} {
		obj := firstObject(rateLimit, keys...)
		if obj == nil {
			continue
		}
		used, okUsed := toFloat(firstValue(obj, "used_percent", "usedPercent"))
		windowSeconds, okWindow := toFloat(firstValue(obj, "limit_window_seconds", "limitWindowSeconds"))
		if !okUsed || !okWindow {
			continue
		}
		window := classifyWindow(time.Duration(windowSeconds * float64(time.Second)))
		if window == "" {
			continue
		}
		resetsAt := toUnix(firstValue(obj, "reset_at", "resetAt"))
		if resetsAt == 0 {
			if after, okAfter := toFloat(firstValue(obj, "reset_after_seconds", "resetAfterSeconds")); okAfter && after >= 0 {
				resetsAt = at.Unix() + int64(after)
			}
		}
		out = append(out, windowSample{window: window, used: used, resetsAt: resetsAt})
	}
	return out
}

// extractHeaderSamples reads the passive quota headers captured from proxied responses.
func extractHeaderSamples(provider string, signals map[string]string, observedAt time.Time) []windowSample {
	lower := make(map[string]string, len(signals))
	for key, value := range signals {
		lower[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
	}
	var out []windowSample
	switch provider {
	case ProviderClaude:
		for _, item := range []struct {
			prefix string
			window string
		}{
			{prefix: "anthropic-ratelimit-unified-5h-", window: Window5h},
			{prefix: "anthropic-ratelimit-unified-7d-", window: WindowWeekly},
		} {
			fraction, ok := toFloat(lower[item.prefix+"utilization"])
			if !ok {
				continue
			}
			out = append(out, windowSample{window: item.window, used: fraction * 100, resetsAt: toUnix(lower[item.prefix+"reset"])})
		}
	case ProviderCodex:
		for _, prefix := range []string{"x-codex-primary-", "x-codex-secondary-"} {
			used, okUsed := toFloat(lower[prefix+"used-percent"])
			minutes, okMinutes := toFloat(lower[prefix+"window-minutes"])
			if !okUsed || !okMinutes {
				continue
			}
			window := classifyWindow(time.Duration(minutes * float64(time.Minute)))
			if window == "" {
				continue
			}
			resetsAt := toUnix(lower[prefix+"reset-at"])
			if resetsAt == 0 {
				if after, okAfter := toFloat(lower[prefix+"reset-after-seconds"]); okAfter && after >= 0 {
					resetsAt = observedAt.Unix() + int64(after)
				}
			}
			out = append(out, windowSample{window: window, used: used, resetsAt: resetsAt})
		}
	}
	return out
}

func firstValue(obj map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := obj[key]; ok && value != nil {
			return value
		}
	}
	return nil
}

func firstObject(obj map[string]any, keys ...string) map[string]any {
	for _, key := range keys {
		if value, ok := obj[key].(map[string]any); ok {
			return value
		}
	}
	return nil
}

// toFloat accepts JSON numbers and numeric strings.
func toFloat(value any) (float64, bool) {
	var out float64
	switch v := value.(type) {
	case float64:
		out = v
	case json.Number:
		parsed, errParse := v.Float64()
		if errParse != nil {
			return 0, false
		}
		out = parsed
	case int:
		out = float64(v)
	case int64:
		out = float64(v)
	case string:
		parsed, errParse := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if errParse != nil {
			return 0, false
		}
		out = parsed
	default:
		return 0, false
	}
	if math.IsNaN(out) || math.IsInf(out, 0) {
		return 0, false
	}
	return out, true
}

// toUnix converts unix seconds (or milliseconds), numeric strings and RFC3339
// strings to unix seconds; 0 when unknown.
func toUnix(value any) int64 {
	if s, ok := value.(string); ok {
		s = strings.TrimSpace(s)
		if s == "" {
			return 0
		}
		if t, errParse := time.Parse(time.RFC3339Nano, s); errParse == nil {
			return t.Unix()
		}
	}
	f, ok := toFloat(value)
	if !ok || f <= 0 {
		return 0
	}
	if f > 1e12 {
		f /= 1000
	}
	return int64(f)
}

// codexAccountID resolves the ChatGPT account id of a Codex credential the same
// way the management panel does: explicit fields first, then the id_token
// claim, then the account_id stored by the Codex login flow.
func codexAccountID(auth *coreauth.Auth) string {
	if auth == nil || !strings.EqualFold(strings.TrimSpace(auth.Provider), ProviderCodex) {
		return ""
	}
	for _, key := range []string{"chatgpt_account_id", "chatgptAccountId"} {
		if v := metadataString(auth.Metadata, key); v != "" {
			return v
		}
		if auth.Attributes != nil {
			if v := strings.TrimSpace(auth.Attributes[key]); v != "" {
				return v
			}
		}
	}
	idTokens := []string{metadataString(auth.Metadata, "id_token")}
	if auth.Attributes != nil {
		idTokens = append(idTokens, strings.TrimSpace(auth.Attributes["id_token"]))
	}
	for _, idToken := range idTokens {
		if idToken == "" {
			continue
		}
		if claims, errParse := codex.ParseJWTToken(idToken); errParse == nil && claims != nil {
			if v := strings.TrimSpace(claims.CodexAuthInfo.ChatgptAccountID); v != "" {
				return v
			}
		}
	}
	return metadataString(auth.Metadata, "account_id")
}

func metadataString(metadata map[string]any, key string) string {
	if metadata == nil {
		return ""
	}
	if v, ok := metadata[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}
