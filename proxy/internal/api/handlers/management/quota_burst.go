package management

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quotapoll"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// ApplyRoutingPriorityOverrides installs the routing priority overrides of the
// prioritised credentials and re-evaluates the current auth manager's scheduler.
func (h *Handler) ApplyRoutingPriorityOverrides(overrides map[string]int) {
	var manager *coreauth.Manager
	if h != nil {
		h.mu.Lock()
		manager = h.authManager
		h.mu.Unlock()
	}
	if manager == nil {
		coreauth.SetPriorityOverrides(overrides)
		return
	}
	manager.ApplyPriorityOverrides(overrides)
}

type quotaBurstRequest struct {
	AuthIndex string `json:"auth_index"`
	// Kind is "5h" (default) or "weekly".
	Kind string `json:"kind"`
}

func writeQuotaBursts(c *gin.Context, bursts []quotapoll.Burst) {
	if bursts == nil {
		bursts = []quotapoll.Burst{}
	}
	c.JSON(http.StatusOK, gin.H{"bursts": bursts})
}

func writeQuotaBurstError(c *gin.Context, err error) {
	var reqErr *quotapoll.RequestError
	if errors.As(err, &reqErr) {
		c.JSON(reqErr.Status, gin.H{"error": reqErr.Message})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": "prioritisation failed"})
}

// GetQuotaBursts lists the prioritised credentials in routing order.
func (h *Handler) GetQuotaBursts(c *gin.Context) {
	svc := h.quotaPollService()
	if svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota service not initialised"})
		return
	}
	writeQuotaBursts(c, svc.Bursts())
}

// PrioritiseQuotaBurst prioritises one Claude/Codex OAuth credential until its
// current 5-hour (kind "5h", default) or weekly (kind "weekly") window resets
// or is used up.
func (h *Handler) PrioritiseQuotaBurst(c *gin.Context) {
	var body quotaBurstRequest
	if errBind := c.ShouldBindJSON(&body); errBind != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	svc := h.quotaPollService()
	if svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota service not initialised"})
		return
	}
	bursts, errPrioritise := svc.PrioritiseKind(body.AuthIndex, body.Kind)
	if errPrioritise != nil {
		writeQuotaBurstError(c, errPrioritise)
		return
	}
	writeQuotaBursts(c, bursts)
}

// CancelQuotaBurst stops prioritising one credential.
func (h *Handler) CancelQuotaBurst(c *gin.Context) {
	svc := h.quotaPollService()
	if svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota service not initialised"})
		return
	}
	bursts, errCancel := svc.CancelBurst(c.Query("auth_index"))
	if errCancel != nil {
		writeQuotaBurstError(c, errCancel)
		return
	}
	writeQuotaBursts(c, bursts)
}
