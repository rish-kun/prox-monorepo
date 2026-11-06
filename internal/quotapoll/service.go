// Package quotapoll is the single owner of the Claude and Codex usage endpoint
// calls. It keeps the latest upstream snapshot per credential, polls every
// eligible credential about once an hour and records the 5-hour and weekly
// quota windows as history samples.
package quotapoll

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
	"golang.org/x/sync/singleflight"
)

const (
	// ProviderClaude and ProviderCodex are the only providers polled by the service.
	ProviderClaude = "claude"
	ProviderCodex  = "codex"

	// PollInterval is the scheduled interval between two polls of one credential.
	PollInterval = 60 * time.Minute
	// MaxBodyBytes bounds the stored size of one upstream response body.
	MaxBodyBytes = 256 << 10

	minRefreshAge        = 60 * time.Second
	maxConcurrentFetches = 3
	backoffFirst         = 2 * time.Hour
	backoffMax           = 4 * time.Hour
	authFailureDelay     = 4 * time.Hour

	schedulerTick        = time.Minute
	headerSampleInterval = 5 * time.Minute
	flushInterval        = 30 * time.Second
	pruneInterval        = 24 * time.Hour

	responseUsage        = "usage"
	responseProfile      = "profile"
	responseSubscription = "subscription"
	responseResetCredits = "reset_credits"
)

// Upstream endpoints and client identities. They match the requests the
// management panel used to send through the api-call endpoint.
const (
	claudeUsageURL         = "https://api.anthropic.com/api/oauth/usage"
	claudeProfileURL       = "https://api.anthropic.com/api/oauth/profile"
	claudeUserAgent        = "claude-cli/2.1.280 (external, cli)"
	claudeBeta             = "oauth-2025-04-20"
	codexUsageURL          = "https://chatgpt.com/backend-api/wham/usage"
	codexSubscriptionURL   = "https://chatgpt.com/backend-api/subscriptions"
	codexResetCreditsURL   = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
	codexUserAgent         = "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)"
	tokenPlaceholderHeader = "Bearer $TOKEN$"
)

// FetchResponse is the raw upstream response of one request.
type FetchResponse struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// Fetcher performs one upstream request on behalf of a credential. The
// "$TOKEN$" placeholder in header values is replaced with the credential's
// token by the implementation. Errors must not contain secrets.
type Fetcher interface {
	Do(ctx context.Context, authIndex, method, url string, headers map[string]string) (FetchResponse, error)
}

// Response is one stored upstream response. Body is the upstream JSON value
// when the body parses as JSON, otherwise a JSON string.
type Response struct {
	StatusCode int             `json:"status_code"`
	Body       json.RawMessage `json:"body"`
}

// Snapshot is the latest upstream state of one credential.
type Snapshot struct {
	AuthIndex   string              `json:"auth_index"`
	Provider    string              `json:"provider"`
	FetchedAt   *time.Time          `json:"fetched_at"`
	AttemptedAt *time.Time          `json:"attempted_at"`
	Responses   map[string]Response `json:"responses"`
	Error       string              `json:"error"`
	ErrorStatus int                 `json:"error_status"`
	NextPollAt  *time.Time          `json:"next_poll_at"`
}

func (s Snapshot) clone() Snapshot {
	out := s
	out.Responses = make(map[string]Response, len(s.Responses))
	for name, resp := range s.Responses {
		out.Responses[name] = resp
	}
	return out
}

// RequestError reports an invalid refresh request; Status is the HTTP status to return.
type RequestError struct {
	Status  int
	Message string
}

func (e *RequestError) Error() string { return e.Message }

// Options configure a Service.
type Options struct {
	// Fetcher performs upstream requests. Required.
	Fetcher Fetcher
	// Auths lists the current credentials. Required.
	Auths func() []*coreauth.Auth
	// Dir is the directory holding latest.quota and history.quota; empty keeps
	// everything in memory.
	Dir string
	// Now overrides the clock (tests).
	Now func() time.Time
	// ApplyPriorityOverrides publishes the routing priority overrides of the
	// prioritised (burst) credentials, keyed by auth ID. Optional.
	ApplyPriorityOverrides func(overrides map[string]int)
}

type entry struct {
	snap      Snapshot
	failures  int
	scheduled bool
	nextPoll  time.Time
}

// Service owns snapshots, the poll schedule and the history store.
type Service struct {
	fetcher Fetcher
	auths   func() []*coreauth.Auth
	now     func() time.Time
	dir     string

	mu        sync.Mutex
	entries   map[string]*entry
	snapDirty bool
	startedAt time.Time
	lastPrune time.Time

	history *history

	// burstMu guards bursts; it may be held while taking mu, never the reverse.
	burstMu        sync.Mutex
	bursts         map[string]*burstRecord
	applyOverrides func(map[string]int)

	group singleflight.Group
	sem   chan struct{}

	writeMu sync.Mutex

	ctxMu     sync.Mutex
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	startOnce sync.Once
	closeOnce sync.Once
	closeErr  error
}

// New creates a service and loads persisted state from opts.Dir. It performs
// no upstream calls and starts no goroutines; call Start for that.
func New(opts Options) *Service {
	clock := opts.Now
	if clock == nil {
		clock = time.Now
	}
	// Drop the monotonic reading so every comparison uses wall time. On macOS
	// the monotonic clock stops while the machine sleeps, so a poll scheduled
	// an hour ahead would otherwise wait for an hour of awake time.
	now := func() time.Time { return clock().Round(0) }
	auths := opts.Auths
	if auths == nil {
		auths = func() []*coreauth.Auth { return nil }
	}
	s := &Service{
		fetcher: opts.Fetcher,
		auths:   auths,
		now:     now,
		dir:     strings.TrimSpace(opts.Dir),
		entries: make(map[string]*entry),
		history: newHistory(),
		sem:     make(chan struct{}, maxConcurrentFetches),
		ctx:     context.Background(),

		bursts:         make(map[string]*burstRecord),
		applyOverrides: opts.ApplyPriorityOverrides,
	}
	s.startedAt = now()
	s.load()
	s.history.prune(s.startedAt)
	s.lastPrune = s.startedAt
	s.loadBursts()
	if len(s.bursts) > 0 {
		s.SweepBursts()
	}
	return s
}

// Start launches the scheduler and the flusher. They stop on Close or when ctx ends.
func (s *Service) Start(ctx context.Context) {
	if s == nil {
		return
	}
	s.startOnce.Do(func() {
		if ctx == nil {
			ctx = context.Background()
		}
		runCtx, cancel := context.WithCancel(ctx)
		s.ctxMu.Lock()
		s.ctx = runCtx
		s.cancel = cancel
		s.ctxMu.Unlock()
		s.history.markStarted(s.now())

		s.wg.Add(3)
		go s.schedulerLoop(runCtx)
		go s.flushLoop(runCtx)
		go s.burstLoop(runCtx)
	})
}

// Close stops the background loops and flushes pending state to disk.
func (s *Service) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		s.ctxMu.Lock()
		cancel := s.cancel
		s.ctxMu.Unlock()
		if cancel != nil {
			cancel()
		}
		s.wg.Wait()
		s.closeErr = s.Flush()
	})
	return s.closeErr
}

func (s *Service) baseContext() context.Context {
	s.ctxMu.Lock()
	defer s.ctxMu.Unlock()
	return s.ctx
}

func (s *Service) schedulerLoop(ctx context.Context) {
	defer s.wg.Done()
	scheduleTicker := time.NewTicker(schedulerTick)
	defer scheduleTicker.Stop()
	headerTicker := time.NewTicker(headerSampleInterval)
	defer headerTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-scheduleTicker.C:
			s.tick(ctx)
		case <-headerTicker.C:
			s.sampleHeaders()
		}
	}
}

func (s *Service) flushLoop(ctx context.Context) {
	defer s.wg.Done()
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if errFlush := s.Flush(); errFlush != nil {
				log.WithError(errFlush).Warn("quotapoll: periodic flush failed")
			}
		}
	}
}

// credential is the subset of an auth the service needs.
type credential struct {
	index     string
	provider  string
	accountID string
	pollable  bool
	disabled  bool
	label     string
	priority  int
}

func (s *Service) credentials() map[string]credential {
	out := make(map[string]credential)
	for _, auth := range s.auths() {
		if auth == nil {
			continue
		}
		index := strings.TrimSpace(auth.EnsureIndex())
		if index == "" {
			continue
		}
		provider := strings.ToLower(strings.TrimSpace(auth.Provider))
		out[index] = credential{
			index:     index,
			provider:  provider,
			accountID: codexAccountID(auth),
			pollable:  isPollable(provider, auth),
			disabled:  auth.Disabled || auth.Status == coreauth.StatusDisabled,
			label:     accountLabel(auth),
			priority:  routingPriority(auth),
		}
	}
	return out
}

// isPollable reports whether the usage endpoints can be called for a credential:
// Claude/Codex OAuth credentials (API keys cannot read the subscription usage).
func isPollable(provider string, auth *coreauth.Auth) bool {
	if provider != ProviderClaude && provider != ProviderCodex {
		return false
	}
	return auth.AuthKind() != coreauth.AuthKindAPIKey
}

func eligible(c credential) bool { return c.pollable && !c.disabled }

// accountLabel returns the email of an OAuth credential; other credentials get
// no label so API keys are never exposed.
func accountLabel(auth *coreauth.Auth) string {
	kind, account := auth.AccountInfo()
	if kind != "oauth" {
		return ""
	}
	return strings.TrimSpace(account)
}

// routingPriority mirrors the scheduler's base priority source (Attributes["priority"]).
// It deliberately ignores burst routing overrides: history and burst ordering
// report the normal priority configured for the credential.
func routingPriority(auth *coreauth.Auth) int {
	if auth == nil || auth.Attributes == nil {
		return 0
	}
	raw := strings.TrimSpace(auth.Attributes["priority"])
	if raw == "" {
		return 0
	}
	parsed, errParse := strconv.Atoi(raw)
	if errParse != nil {
		return 0
	}
	return parsed
}

// PollIntervalSeconds is the scheduled poll interval in seconds.
func (s *Service) PollIntervalSeconds() int64 { return int64(PollInterval / time.Second) }

// Snapshots returns the stored snapshots of current Claude/Codex credentials,
// optionally filtered by provider. It never calls upstream.
func (s *Service) Snapshots(provider string) map[string]Snapshot {
	provider = strings.ToLower(strings.TrimSpace(provider))
	creds := s.credentials()
	out := make(map[string]Snapshot)
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, e := range s.entries {
		c, ok := creds[index]
		if !ok || !c.pollable {
			continue
		}
		if provider != "" && c.provider != provider {
			continue
		}
		out[index] = e.snap.clone()
	}
	return out
}

// Refresh fetches the given credentials (all eligible ones when indexes is
// empty) and returns their snapshots. Without force a credential attempted less
// than a minute ago (successfully or not) is served from memory. Per-credential failures are
// reported inside the snapshot.
func (s *Service) Refresh(ctx context.Context, indexes []string, force bool) (map[string]Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	creds := s.credentials()
	var targets []credential
	if len(indexes) == 0 {
		for _, c := range creds {
			if eligible(c) {
				targets = append(targets, c)
			}
		}
	} else {
		seen := make(map[string]struct{}, len(indexes))
		for _, raw := range indexes {
			index := strings.TrimSpace(raw)
			if index == "" {
				return nil, &RequestError{Status: http.StatusBadRequest, Message: "auth_indexes must not contain empty values"}
			}
			if _, dup := seen[index]; dup {
				continue
			}
			seen[index] = struct{}{}
			c, ok := creds[index]
			if !ok {
				return nil, &RequestError{Status: http.StatusNotFound, Message: fmt.Sprintf("credential %s not found", index)}
			}
			if !c.pollable {
				return nil, &RequestError{Status: http.StatusBadRequest, Message: fmt.Sprintf("credential %s does not support quota polling", index)}
			}
			targets = append(targets, c)
		}
	}

	out := make(map[string]Snapshot, len(targets))
	var outMu sync.Mutex
	var wg sync.WaitGroup
	for _, c := range targets {
		wg.Add(1)
		go func(c credential) {
			defer wg.Done()
			snap, ok := s.refreshOne(ctx, c, force)
			if !ok {
				return
			}
			outMu.Lock()
			out[c.index] = snap
			outMu.Unlock()
		}(c)
	}
	wg.Wait()
	if errCtx := ctx.Err(); errCtx != nil {
		return nil, errCtx
	}
	return out, nil
}

func (s *Service) refreshOne(ctx context.Context, c credential, force bool) (Snapshot, bool) {
	if !force {
		s.mu.Lock()
		// Any recent attempt counts, failed ones included, so repeated clicks
		// during a 429 backoff do not hammer upstream.
		if e := s.entries[c.index]; e != nil && e.snap.AttemptedAt != nil && s.now().Sub(*e.snap.AttemptedAt) < minRefreshAge {
			snap := e.snap.clone()
			s.mu.Unlock()
			return snap, true
		}
		s.mu.Unlock()
	}
	return s.fetchShared(ctx, c)
}

// fetchShared joins or starts the single in-flight fetch of a credential. The
// fetch itself runs on the service context so one caller giving up does not
// cancel it for the others.
func (s *Service) fetchShared(ctx context.Context, c credential) (Snapshot, bool) {
	ch := s.group.DoChan(c.index, func() (any, error) {
		return s.fetch(s.baseContext(), c), nil
	})
	select {
	case <-ctx.Done():
		return Snapshot{}, false
	case res := <-ch:
		snap, ok := res.Val.(Snapshot)
		return snap, ok
	}
}

type upstreamRequest struct {
	name    string
	url     string
	headers map[string]string
}

func buildRequests(c credential) []upstreamRequest {
	switch c.provider {
	case ProviderClaude:
		headers := map[string]string{
			"Authorization":  tokenPlaceholderHeader,
			"Content-Type":   "application/json",
			"User-Agent":     claudeUserAgent,
			"anthropic-beta": claudeBeta,
		}
		return []upstreamRequest{
			{name: responseUsage, url: claudeUsageURL, headers: headers},
			{name: responseProfile, url: claudeProfileURL, headers: headers},
		}
	case ProviderCodex:
		headers := map[string]string{
			"Authorization": tokenPlaceholderHeader,
			"Content-Type":  "application/json",
			"User-Agent":    codexUserAgent,
		}
		if c.accountID != "" {
			headers["Chatgpt-Account-Id"] = c.accountID
		}
		reqs := []upstreamRequest{{name: responseUsage, url: codexUsageURL, headers: headers}}
		if c.accountID != "" {
			reqs = append(reqs, upstreamRequest{
				name:    responseSubscription,
				url:     codexSubscriptionURL + "?account_id=" + url.QueryEscape(c.accountID),
				headers: headers,
			})
		}
		resetHeaders := make(map[string]string, len(headers)+3)
		for k, v := range headers {
			resetHeaders[k] = v
		}
		resetHeaders["Accept"] = "application/json"
		resetHeaders["OpenAI-Beta"] = "codex-1"
		resetHeaders["Originator"] = "Codex Desktop"
		reqs = append(reqs, upstreamRequest{name: responseResetCredits, url: codexResetCreditsURL, headers: resetHeaders})
		return reqs
	default:
		return nil
	}
}

func copyHeaders(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// fetch performs one upstream round for a credential and updates its entry.
func (s *Service) fetch(ctx context.Context, c credential) Snapshot {
	select {
	case s.sem <- struct{}{}:
	case <-ctx.Done():
		return s.currentSnapshot(c)
	}
	defer func() { <-s.sem }()

	reqs := buildRequests(c)
	attemptedAt := s.now()
	if s.fetcher == nil || len(reqs) == 0 {
		return s.recordFailure(c, attemptedAt, "quota fetcher not configured", 0, 0)
	}

	usageReq := reqs[0]
	usageResp, errUsage := s.fetcher.Do(ctx, c.index, http.MethodGet, usageReq.url, copyHeaders(usageReq.headers))
	if errUsage != nil {
		if ctx.Err() != nil {
			// Shutdown cancelled the fetch: keep the state so no backoff is recorded.
			return s.currentSnapshot(c)
		}
		return s.recordFailure(c, attemptedAt, "usage request failed: "+errUsage.Error(), 0, 0)
	}
	if usageResp.StatusCode < 200 || usageResp.StatusCode > 299 {
		retryAfter := parseRetryAfter(usageResp.Header.Get("Retry-After"), s.now())
		return s.recordFailure(c, attemptedAt, fmt.Sprintf("usage returned HTTP %d", usageResp.StatusCode), usageResp.StatusCode, retryAfter)
	}

	responses := map[string]Response{responseUsage: toResponse(usageResp)}
	for _, req := range reqs[1:] {
		resp, errDo := s.fetcher.Do(ctx, c.index, http.MethodGet, req.url, copyHeaders(req.headers))
		if errDo != nil {
			responses[req.name] = Response{StatusCode: 0, Body: encodeBody([]byte(errDo.Error()))}
			continue
		}
		responses[req.name] = toResponse(resp)
	}
	return s.recordSuccess(c, attemptedAt, responses, usageResp.Body)
}

func toResponse(resp FetchResponse) Response {
	return Response{StatusCode: resp.StatusCode, Body: encodeBody(resp.Body)}
}

// encodeBody returns the body as a JSON value when it parses, else as a JSON string.
func encodeBody(body []byte) json.RawMessage {
	if len(body) > MaxBodyBytes {
		body = body[:MaxBodyBytes]
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed != "" && json.Valid([]byte(trimmed)) {
		return json.RawMessage(trimmed)
	}
	raw, errMarshal := json.Marshal(string(body))
	if errMarshal != nil {
		return json.RawMessage(`""`)
	}
	return raw
}

func timePtr(t time.Time) *time.Time {
	v := t.UTC().Truncate(time.Second)
	return &v
}

func (s *Service) entryLocked(c credential) *entry {
	e := s.entries[c.index]
	if e == nil {
		e = &entry{snap: Snapshot{AuthIndex: c.index, Provider: c.provider, Responses: map[string]Response{}}}
		s.entries[c.index] = e
	}
	e.snap.Provider = c.provider
	return e
}

func (s *Service) currentSnapshot(c credential) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.entryLocked(c).snap.clone()
}

func (s *Service) recordSuccess(c credential, attemptedAt time.Time, responses map[string]Response, usageBody []byte) Snapshot {
	fetchedAt := s.now()
	samples := extractPollSamples(c.provider, usageBody, fetchedAt)

	s.mu.Lock()
	e := s.entryLocked(c)
	e.snap.FetchedAt = timePtr(fetchedAt)
	e.snap.AttemptedAt = timePtr(attemptedAt)
	e.snap.Responses = responses
	e.snap.Error = ""
	e.snap.ErrorStatus = 0
	e.failures = 0
	e.scheduled = true
	e.nextPoll = fetchedAt.Add(PollInterval)
	e.snap.NextPollAt = timePtr(e.nextPoll)
	s.snapDirty = true
	snap := e.snap.clone()
	s.mu.Unlock()

	for _, sample := range samples {
		s.history.add(Sample{
			T:         fetchedAt.Unix(),
			AuthIndex: c.index,
			Provider:  c.provider,
			Window:    sample.window,
			Used:      sample.used,
			ResetsAt:  sample.resetsAt,
			Src:       SourcePoll,
		}, false)
	}
	return snap
}

func (s *Service) recordFailure(c credential, attemptedAt time.Time, message string, status int, retryAfter time.Duration) Snapshot {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entryLocked(c)
	e.snap.AttemptedAt = timePtr(attemptedAt)
	e.snap.Error = message
	e.snap.ErrorStatus = status
	e.failures++
	e.scheduled = true
	e.nextPoll = now.Add(failureDelay(status, e.failures, retryAfter))
	e.snap.NextPollAt = timePtr(e.nextPoll)
	s.snapDirty = true
	log.WithFields(log.Fields{"auth_index": c.index, "provider": c.provider, "status": status}).Debug("quotapoll: usage fetch failed")
	return e.snap.clone()
}

// failureDelay returns how long to wait after a failed usage fetch.
// 401/403 wait 4 h; everything else (429, 5xx, network, other) backs off 2 h
// then 4 h. A Retry-After header (capped at 4 h) can lengthen the delay.
func failureDelay(status, failures int, retryAfter time.Duration) time.Duration {
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return authFailureDelay
	}
	delay := backoffFirst
	if failures > 1 {
		delay = backoffMax
	}
	if retryAfter > backoffMax {
		retryAfter = backoffMax
	}
	if retryAfter > delay {
		delay = retryAfter
	}
	return delay
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, errAtoi := strconv.Atoi(value); errAtoi == nil {
		if seconds < 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}
	if at, errParse := http.ParseTime(value); errParse == nil {
		if d := at.Sub(now); d > 0 {
			return d
		}
	}
	return 0
}

// staggerOffset spreads first polls after startup over one interval.
func staggerOffset(index string) time.Duration {
	h := fnv.New32a()
	_, _ = h.Write([]byte(index))
	return time.Duration(h.Sum32()%uint32(PollInterval/time.Second)) * time.Second
}

// initialPollLocked computes the first poll time of a credential in this
// process: the staggered slot, but never before the persisted snapshot is one
// interval old, and never before a persisted backoff ends.
func (s *Service) initialPollLocked(e *entry, index string) time.Time {
	next := s.startedAt.Add(staggerOffset(index))
	if e.snap.FetchedAt != nil {
		if fresh := e.snap.FetchedAt.Add(PollInterval); fresh.After(next) {
			next = fresh
		}
	}
	if e.failures > 0 && e.snap.NextPollAt != nil && e.snap.NextPollAt.After(next) {
		next = *e.snap.NextPollAt
	}
	return next
}

// tick runs one scheduler step: it fetches every eligible credential whose
// next poll time has passed and prunes history once a day.
func (s *Service) tick(ctx context.Context) {
	now := s.now()
	creds := s.credentials()
	var due []credential
	s.mu.Lock()
	for _, c := range creds {
		if !eligible(c) {
			continue
		}
		e := s.entryLocked(c)
		if !e.scheduled {
			e.nextPoll = s.initialPollLocked(e, c.index)
			e.scheduled = true
			e.snap.NextPollAt = timePtr(e.nextPoll)
			s.snapDirty = true
		}
		if !now.Before(e.nextPoll) {
			due = append(due, c)
		}
	}
	prune := now.Sub(s.lastPrune) >= pruneInterval
	if prune {
		s.lastPrune = now
	}
	s.mu.Unlock()

	if prune {
		s.history.prune(now)
	}

	var wg sync.WaitGroup
	for _, c := range due {
		wg.Add(1)
		go func(c credential) {
			defer wg.Done()
			s.fetchShared(ctx, c)
		}(c)
	}
	wg.Wait()
}

// sampleHeaders records the passive quota headers the auth manager observed
// on proxied requests.
func (s *Service) sampleHeaders() {
	for _, auth := range s.auths() {
		if auth == nil {
			continue
		}
		provider := strings.ToLower(strings.TrimSpace(auth.Provider))
		if !isPollable(provider, auth) || auth.Disabled || auth.Status == coreauth.StatusDisabled {
			continue
		}
		observedAt := auth.Quota.ObservedAt
		if observedAt.IsZero() || len(auth.Quota.Signals) == 0 {
			continue
		}
		index := strings.TrimSpace(auth.EnsureIndex())
		if index == "" {
			continue
		}
		for _, sample := range extractHeaderSamples(provider, auth.Quota.Signals, observedAt) {
			s.history.add(Sample{
				T:         observedAt.Unix(),
				AuthIndex: index,
				Provider:  provider,
				Window:    sample.window,
				Used:      sample.used,
				ResetsAt:  sample.resetsAt,
				Src:       SourceHeaders,
			}, true)
		}
	}
}

// Account describes a credential in a history response.
type Account struct {
	Label    string `json:"label"`
	Priority int    `json:"priority"`
	Disabled bool   `json:"disabled"`
}

// HistoryResult is the response of a history query.
type HistoryResult struct {
	Provider        string             `json:"provider"`
	Window          string             `json:"window"`
	From            int64              `json:"from"`
	To              int64              `json:"to"`
	FirstRecordedAt int64              `json:"first_recorded_at"`
	Samples         []HistorySample    `json:"samples"`
	Accounts        map[string]Account `json:"accounts"`
}

// History returns samples of one provider and window in [from, to] plus, per
// account, the latest sample before from so the state at from is known.
func (s *Service) History(provider, window string, from, to int64) HistoryResult {
	provider = strings.ToLower(strings.TrimSpace(provider))
	result := HistoryResult{
		Provider: provider,
		Window:   window,
		From:     from,
		To:       to,
		Accounts: make(map[string]Account),
	}
	result.FirstRecordedAt, result.Samples = s.history.query(provider, window, from, to)
	for index, c := range s.credentials() {
		if c.provider != provider {
			continue
		}
		result.Accounts[index] = Account{Label: c.label, Priority: c.priority, Disabled: c.disabled}
	}
	return result
}
