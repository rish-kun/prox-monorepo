package management

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quotapoll"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

const defaultQuotaHistoryWindow = 14 * 24 * time.Hour

// quotaHistoryNow is the clock used for default history bounds; tests override it.
var quotaHistoryNow = time.Now

// SetQuotaPoll installs the shared quota polling service (nil clears it).
func (h *Handler) SetQuotaPoll(svc *quotapoll.Service) {
	if h == nil {
		return
	}
	h.quotaPoll.Store(svc)
}

func (h *Handler) quotaPollService() *quotapoll.Service {
	if h == nil {
		return nil
	}
	return h.quotaPoll.Load()
}

// QuotaPollFetcher returns the upstream fetcher used by the quota poller. It
// resolves credentials, tokens and transports exactly like APICall.
func (h *Handler) QuotaPollFetcher() quotapoll.Fetcher {
	return quotaPollFetcher{h: h}
}

// QuotaPollAuths lists the credentials of the current auth manager.
func (h *Handler) QuotaPollAuths() []*coreauth.Auth {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	manager := h.authManager
	h.mu.Unlock()
	if manager == nil {
		return nil
	}
	return manager.List()
}

type quotaPollFetcher struct {
	h *Handler
}

// Do performs one upstream GET for the credential, replacing "$TOKEN$" in
// header values. Errors are generic so no token or URL detail leaks.
func (f quotaPollFetcher) Do(ctx context.Context, authIndex, method, rawURL string, headers map[string]string) (quotapoll.FetchResponse, error) {
	h := f.h
	auth := h.authByIndex(authIndex)
	if auth == nil {
		return quotapoll.FetchResponse{}, errors.New("auth credential not found")
	}

	var token string
	var tokenErr error
	tokenResolved := false
	reqHeaders := make(map[string]string, len(headers))
	for key, value := range headers {
		if strings.Contains(value, "$TOKEN$") {
			if !tokenResolved {
				token, tokenErr = h.resolveTokenForAuth(ctx, auth, "")
				tokenResolved = true
			}
			if token == "" {
				if tokenErr != nil {
					return quotapoll.FetchResponse{}, errors.New("auth token refresh failed")
				}
				return quotapoll.FetchResponse{}, errors.New("auth token not found")
			}
			value = strings.ReplaceAll(value, "$TOKEN$", token)
		}
		reqHeaders[key] = value
	}

	req, errNewRequest := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if errNewRequest != nil {
		return quotapoll.FetchResponse{}, errors.New("failed to build request")
	}
	for key, value := range reqHeaders {
		req.Header.Set(key, value)
	}

	resp, errDo := h.apiCallHTTPClient(auth, "").Do(req)
	if errDo != nil {
		log.WithError(errDo).Debug("quota poll request failed")
		return quotapoll.FetchResponse{}, errors.New("request failed")
	}
	defer func() {
		if errClose := resp.Body.Close(); errClose != nil {
			log.Errorf("response body close error: %v", errClose)
		}
	}()
	body, errRead := io.ReadAll(io.LimitReader(resp.Body, quotapoll.MaxBodyBytes+1))
	if errRead != nil {
		return quotapoll.FetchResponse{}, errors.New("failed to read response")
	}
	return quotapoll.FetchResponse{StatusCode: resp.StatusCode, Header: resp.Header, Body: body}, nil
}

func parseQuotaProvider(raw string, required bool) (string, bool) {
	provider := strings.ToLower(strings.TrimSpace(raw))
	switch provider {
	case quotapoll.ProviderClaude, quotapoll.ProviderCodex:
		return provider, true
	case "":
		return "", !required
	default:
		return "", false
	}
}

// GetQuotaSnapshots returns the stored upstream quota snapshots without calling upstream.
func (h *Handler) GetQuotaSnapshots(c *gin.Context) {
	provider, ok := parseQuotaProvider(c.Query("provider"), false)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider must be claude or codex"})
		return
	}
	svc := h.quotaPollService()
	if svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota service not initialised"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"poll_interval_seconds": svc.PollIntervalSeconds(),
		"snapshots":             svc.Snapshots(provider),
	})
}

type quotaRefreshRequest struct {
	AuthIndexes []string `json:"auth_indexes"`
	Force       bool     `json:"force"`
}

// RefreshQuota fetches the requested credentials (default: all eligible) through
// the shared poller and returns their snapshots.
func (h *Handler) RefreshQuota(c *gin.Context) {
	var body quotaRefreshRequest
	if c.Request.Body != nil && c.Request.ContentLength != 0 {
		if errBind := c.ShouldBindJSON(&body); errBind != nil && !errors.Is(errBind, io.EOF) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
			return
		}
	}
	svc := h.quotaPollService()
	if svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota service not initialised"})
		return
	}
	snapshots, errRefresh := svc.Refresh(c.Request.Context(), body.AuthIndexes, body.Force)
	if errRefresh != nil {
		var reqErr *quotapoll.RequestError
		if errors.As(errRefresh, &reqErr) {
			c.JSON(reqErr.Status, gin.H{"error": reqErr.Message})
			return
		}
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota refresh cancelled"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"snapshots": snapshots})
}

// GetQuotaHistory returns recorded quota samples of one provider and window.
func (h *Handler) GetQuotaHistory(c *gin.Context) {
	provider, ok := parseQuotaProvider(c.Query("provider"), true)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider must be claude or codex"})
		return
	}
	window := strings.ToLower(strings.TrimSpace(c.Query("window")))
	if window != quotapoll.Window5h && window != quotapoll.WindowWeekly {
		c.JSON(http.StatusBadRequest, gin.H{"error": "window must be 5h or weekly"})
		return
	}
	to, errTo := parseOptionalInt64(c.Query("to"), quotaHistoryNow().Unix())
	if errTo != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "to must be unix seconds"})
		return
	}
	from, errFrom := parseOptionalInt64(c.Query("from"), to-int64(defaultQuotaHistoryWindow/time.Second))
	if errFrom != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "from must be unix seconds"})
		return
	}
	if from > to {
		c.JSON(http.StatusBadRequest, gin.H{"error": "from must not be after to"})
		return
	}
	svc := h.quotaPollService()
	if svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "quota service not initialised"})
		return
	}
	c.JSON(http.StatusOK, svc.History(provider, window, from, to))
}
