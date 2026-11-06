package management

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

// ModelExecutor runs an internal model request through the normal auth-manager
// pipeline (translators, executors, cooldown and passive quota bookkeeping).
type ModelExecutor interface {
	ExecuteModel(context.Context, handlers.ModelExecutionRequest) (handlers.ModelExecutionResponse, *interfaces.ErrorMessage)
}

// SetModelExecutor wires the executor used by StartQuotaWindow.
func (h *Handler) SetModelExecutor(executor ModelExecutor) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.modelExecutor = executor
	h.mu.Unlock()
}

// windowStarter is the smallest request that opens a provider's rolling usage
// window: the cheapest model, lowest reasoning effort, a one-word prompt.
// models lists candidates cheapest first; the first one the credential is
// registered for is used, and its id is substituted for %s in body.
type windowStarter struct {
	protocol sdktranslator.Format
	models   []string
	body     string
}

var windowStarters = map[string]windowStarter{
	"claude": {
		protocol: sdktranslator.FormatClaude,
		models:   []string{"claude-haiku-5-5", "claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-3-5-haiku-20241022"},
		body:     `{"model":%q,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`,
	},
	"codex": {
		protocol: sdktranslator.FormatOpenAIResponse,
		models:   []string{"gpt-5.6-luna", "gpt-6-luna", "gpt-5-nano", "gpt-5-mini"},
		body:     `{"model":%q,"input":"hi","reasoning":{"effort":"low"},"stream":false}`,
	},
}

// credentialSupportsModel reports whether the model registry routes model to the
// credential. It is a variable so tests can stub the global registry.
var credentialSupportsModel = func(authID, model string) bool {
	return registry.GetGlobalRegistry().ClientSupportsModel(authID, model)
}

// modelFor picks the cheapest candidate the credential is registered for.
func (s windowStarter) modelFor(authID string) (string, bool) {
	for _, model := range s.models {
		if credentialSupportsModel(authID, model) {
			return model, true
		}
	}
	return "", false
}

func windowStarterFor(provider string) (windowStarter, bool) {
	starter, ok := windowStarters[strings.ToLower(strings.TrimSpace(provider))]
	return starter, ok
}

// StartQuotaWindow sends one tiny request through a specific credential so its
// rolling 5-hour window starts now. The request goes through the regular
// pipeline pinned to that credential, so the response's rate-limit headers
// refresh the credential's passive quota snapshot like any proxied request.
func (h *Handler) StartQuotaWindow(c *gin.Context) {
	var body credentialQuotaRequest
	if errBind := c.ShouldBindJSON(&body); errBind != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	authIndex := body.resolveAuthIndex()
	if authIndex == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "auth_index is required"})
		return
	}

	auth := h.authByIndex(authIndex)
	if auth == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "auth not found"})
		return
	}
	if auth.Disabled || auth.Status == coreauth.StatusDisabled {
		c.JSON(http.StatusConflict, gin.H{"error": "credential is disabled"})
		return
	}
	starter, ok := windowStarterFor(auth.Provider)
	if !ok {
		c.JSON(http.StatusNotImplemented, gin.H{"error": fmt.Sprintf("starting a usage window is not supported for provider %q", auth.Provider)})
		return
	}

	model, ok := starter.modelFor(auth.ID)
	if !ok {
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("no low-cost model is available for this credential (tried %s)", strings.Join(starter.models, ", "))})
		return
	}

	h.mu.Lock()
	executor := h.modelExecutor
	h.mu.Unlock()
	if executor == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "model executor unavailable"})
		return
	}

	_, errMsg := executor.ExecuteModel(c.Request.Context(), handlers.ModelExecutionRequest{
		EntryProtocol: string(starter.protocol),
		ExitProtocol:  string(starter.protocol),
		Model:         model,
		Body:          []byte(fmt.Sprintf(starter.body, model)),
		AuthID:        auth.ID,
	})
	if errMsg != nil {
		status := errMsg.StatusCode
		if status < http.StatusBadRequest {
			status = http.StatusBadGateway
		}
		message := http.StatusText(status)
		if errMsg.Error != nil {
			message = errMsg.Error.Error()
		}
		c.JSON(status, gin.H{"error": message})
		return
	}

	auth.EnsureIndex()
	c.JSON(http.StatusOK, gin.H{
		"status":     "ok",
		"auth_index": auth.Index,
		"model":      model,
	})
}
