package claude

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/tidwall/gjson"
)

func writeClaudeCooldown(t *testing.T, resetIn time.Duration) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	handler := NewClaudeCodeAPIHandler(&handlers.BaseAPIHandler{})
	handler.WriteErrorResponse(c, &interfaces.ErrorMessage{
		StatusCode: http.StatusTooManyRequests,
		Error:      coreauth.NewModelCooldownError("claude-opus-5-5", "claude", resetIn),
	})
	return recorder
}

func TestClaudeUsageLimitLooksLikeAnthropicPlanLimit(t *testing.T) {
	before := time.Now()
	recorder := writeClaudeCooldown(t, 2*time.Hour)

	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", recorder.Code)
	}
	header := recorder.Header()
	if got := header.Get("anthropic-ratelimit-unified-status"); got != "rejected" {
		t.Fatalf("anthropic-ratelimit-unified-status = %q, want rejected", got)
	}
	reset, err := strconv.ParseInt(header.Get("anthropic-ratelimit-unified-reset"), 10, 64)
	if err != nil {
		t.Fatalf("anthropic-ratelimit-unified-reset is not unix seconds: %v", err)
	}
	if reset < before.Add(2*time.Hour).Unix() || reset > time.Now().Add(2*time.Hour).Unix() {
		t.Fatalf("reset = %d, want about now+2h", reset)
	}
	if got := header.Get("x-should-retry"); got != "false" {
		t.Fatalf("x-should-retry = %q, want false", got)
	}
	if header.Get("Retry-After") == "" {
		t.Fatal("Retry-After missing")
	}

	body := recorder.Body.String()
	if got := gjson.Get(body, "type").String(); got != "error" {
		t.Fatalf("type = %q, want error (body %s)", got, body)
	}
	if got := gjson.Get(body, "error.type").String(); got != "rate_limit_error" {
		t.Fatalf("error.type = %q, want rate_limit_error (body %s)", got, body)
	}
	if gjson.Get(body, "error.message").String() == "" {
		t.Fatalf("error.message empty: %s", body)
	}
}

func TestClaudeTransientCooldownHasNoPlanLimitHeaders(t *testing.T) {
	recorder := writeClaudeCooldown(t, 20*time.Second)
	header := recorder.Header()
	if header.Get("anthropic-ratelimit-unified-status") != "" || header.Get("x-should-retry") != "" {
		t.Fatalf("transient cooldown must stay retryable, got headers %v", header)
	}
	if got := gjson.Get(recorder.Body.String(), "error.type").String(); got != "rate_limit_error" {
		t.Fatalf("error.type = %q, want rate_limit_error", got)
	}
}
