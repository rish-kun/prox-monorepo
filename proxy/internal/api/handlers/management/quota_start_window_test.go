package management

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/tidwall/gjson"
)

type recordingModelExecutor struct {
	requests []handlers.ModelExecutionRequest
	err      *interfaces.ErrorMessage
}

func (e *recordingModelExecutor) ExecuteModel(_ context.Context, req handlers.ModelExecutionRequest) (handlers.ModelExecutionResponse, *interfaces.ErrorMessage) {
	e.requests = append(e.requests, req)
	if e.err != nil {
		return handlers.ModelExecutionResponse{}, e.err
	}
	return handlers.ModelExecutionResponse{StatusCode: http.StatusOK}, nil
}

// stubSupportedModels makes the registry report exactly these models for every credential.
func stubSupportedModels(t *testing.T, models ...string) {
	t.Helper()
	previous := credentialSupportsModel
	credentialSupportsModel = func(_, model string) bool {
		for _, supported := range models {
			if supported == model {
				return true
			}
		}
		return false
	}
	t.Cleanup(func() { credentialSupportsModel = previous })
}

func startWindowHandler(t *testing.T, auths ...*coreauth.Auth) (*Handler, *recordingModelExecutor) {
	t.Helper()
	stubSupportedModels(t, "claude-haiku-5-5", "gpt-5.6-luna")
	manager := coreauth.NewManager(nil, nil, nil)
	for _, auth := range auths {
		auth.EnsureIndex()
		if _, errRegister := manager.Register(context.Background(), auth); errRegister != nil {
			t.Fatalf("register auth: %v", errRegister)
		}
	}
	executor := &recordingModelExecutor{}
	h := NewHandlerWithoutConfigFilePath(&config.Config{AuthDir: t.TempDir()}, manager)
	h.SetModelExecutor(executor)
	return h, executor
}

func postStartWindow(h *Handler, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(rec)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v8/management/quota/start-window", strings.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	h.StartQuotaWindow(ctx)
	return rec
}

func TestStartQuotaWindow_PinsCheapestRequestToCredential(t *testing.T) {
	gin.SetMode(gin.TestMode)
	claude := &coreauth.Auth{ID: "claude-a.json", Provider: "claude"}
	codex := &coreauth.Auth{ID: "codex-a.json", Provider: "codex"}
	h, executor := startWindowHandler(t, claude, codex)

	for _, tc := range []struct {
		auth     *coreauth.Auth
		protocol string
		model    string
		check    func(t *testing.T, body []byte)
	}{
		{claude, "claude", "claude-haiku-5-5", func(t *testing.T, body []byte) {
			if got := gjson.GetBytes(body, "max_tokens").Int(); got <= 0 || got > 32 {
				t.Errorf("max_tokens = %d, want a tiny cap", got)
			}
		}},
		{codex, "openai-response", "gpt-5.6-luna", func(t *testing.T, body []byte) {
			if got := gjson.GetBytes(body, "reasoning.effort").String(); got != "low" {
				t.Errorf("reasoning.effort = %q, want low", got)
			}
		}},
	} {
		rec := postStartWindow(h, `{"auth_index":"`+tc.auth.Index+`"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d body=%s", tc.auth.Provider, rec.Code, rec.Body.String())
		}
		req := executor.requests[len(executor.requests)-1]
		if req.AuthID != tc.auth.ID {
			t.Errorf("%s: pinned auth = %q, want %q", tc.auth.Provider, req.AuthID, tc.auth.ID)
		}
		if req.EntryProtocol != tc.protocol || req.ExitProtocol != tc.protocol {
			t.Errorf("%s: protocol = %s/%s, want %s", tc.auth.Provider, req.EntryProtocol, req.ExitProtocol, tc.protocol)
		}
		if req.Model != tc.model || gjson.GetBytes(req.Body, "model").String() != tc.model {
			t.Errorf("%s: model = %q, want %q", tc.auth.Provider, req.Model, tc.model)
		}
		if req.Stream {
			t.Errorf("%s: want a non-streaming request", tc.auth.Provider)
		}
		tc.check(t, req.Body)
	}
}

func TestStartQuotaWindow_Rejections(t *testing.T) {
	gin.SetMode(gin.TestMode)
	disabled := &coreauth.Auth{ID: "claude-off.json", Provider: "claude", Disabled: true}
	gemini := &coreauth.Auth{ID: "gemini.json", Provider: "gemini"}
	h, executor := startWindowHandler(t, disabled, gemini)

	for _, tc := range []struct {
		name string
		body string
		want int
	}{
		{"missing index", `{}`, http.StatusBadRequest},
		{"unknown index", `{"auth_index":"nope"}`, http.StatusNotFound},
		{"disabled credential", `{"auth_index":"` + disabled.Index + `"}`, http.StatusConflict},
		{"unsupported provider", `{"auth_index":"` + gemini.Index + `"}`, http.StatusNotImplemented},
	} {
		if rec := postStartWindow(h, tc.body); rec.Code != tc.want {
			t.Errorf("%s: status = %d, want %d", tc.name, rec.Code, tc.want)
		}
	}
	if len(executor.requests) != 0 {
		t.Fatalf("rejected requests must not reach upstream, got %d", len(executor.requests))
	}
}

func TestStartQuotaWindow_FallsBackToCheapestRegisteredModel(t *testing.T) {
	gin.SetMode(gin.TestMode)
	claude := &coreauth.Auth{ID: "claude-c.json", Provider: "claude"}
	h, executor := startWindowHandler(t, claude)
	stubSupportedModels(t, "claude-opus-5-5", "claude-haiku-4-5-20251001")

	rec := postStartWindow(h, `{"auth_index":"`+claude.Index+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	req := executor.requests[0]
	if req.Model != "claude-haiku-4-5-20251001" || gjson.GetBytes(req.Body, "model").String() != req.Model {
		t.Fatalf("model = %q body=%s, want haiku 4.5 fallback", req.Model, req.Body)
	}
	if got := gjson.Get(rec.Body.String(), "model").String(); got != req.Model {
		t.Fatalf("response model = %q", got)
	}

	stubSupportedModels(t, "claude-opus-5-5")
	if rec := postStartWindow(h, `{"auth_index":"`+claude.Index+`"}`); rec.Code != http.StatusConflict {
		t.Fatalf("no cheap model: status = %d, want 409", rec.Code)
	}
	if len(executor.requests) != 1 {
		t.Fatalf("unsupported model must not reach upstream, got %d requests", len(executor.requests))
	}
}

func TestStartQuotaWindow_SurfacesUpstreamError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	codex := &coreauth.Auth{ID: "codex-b.json", Provider: "codex"}
	h, executor := startWindowHandler(t, codex)
	executor.err = &interfaces.ErrorMessage{StatusCode: http.StatusTooManyRequests, Error: errors.New("usage limit reached")}

	rec := postStartWindow(h, `{"auth_index":"`+codex.Index+`"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if got := gjson.Get(rec.Body.String(), "error").String(); got != "usage limit reached" {
		t.Fatalf("error = %q", got)
	}
}
