// Package usagestore keeps a persistent hourly aggregate of token usage per
// provider, credential (auth index), model and prompt-size tier. It is a usage
// plugin independent of usage-statistics-enabled and of the redis usage queue.
package usagestore

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

const (
	// PluginName is the name used to register the store as a usage plugin.
	PluginName = "usagestore"

	// promptTier1Threshold and promptTier2Threshold are the prompt sizes (uncached
	// + cache read + cache write input tokens) above which a request moves to the
	// next prompt tier. Some models bill large prompts at higher per-token rates.
	promptTier1Threshold = 100_000
	promptTier2Threshold = 272_000

	unknownValue = "unknown"
)

// Counters are the per-key aggregate counters.
type Counters struct {
	Requests           int64 `json:"requests"`
	Failed             int64 `json:"failed"`
	InputTokens        int64 `json:"input_tokens"`
	CacheReadTokens    int64 `json:"cache_read_tokens"`
	CacheWriteTokens   int64 `json:"cache_write_tokens"`
	OutputTokens       int64 `json:"output_tokens"`
	ReasoningTokens    int64 `json:"reasoning_tokens"`
	UnclassifiedTokens int64 `json:"unclassified_tokens"`
}

func (c *Counters) add(other Counters) {
	c.Requests += other.Requests
	c.Failed += other.Failed
	c.InputTokens += other.InputTokens
	c.CacheReadTokens += other.CacheReadTokens
	c.CacheWriteTokens += other.CacheWriteTokens
	c.OutputTokens += other.OutputTokens
	c.ReasoningTokens += other.ReasoningTokens
	c.UnclassifiedTokens += other.UnclassifiedTokens
}

// Account describes a credential seen in usage records. Label is only set for
// OAuth credentials so that API keys are never persisted.
type Account struct {
	Provider string `json:"provider"`
	Label    string `json:"label,omitempty"`
	LastSeen int64  `json:"last_seen"`
}

type rowKey struct {
	hour       int64
	provider   string
	authIndex  string
	model      string
	promptTier int
}

// Store aggregates usage records into hourly rows and persists them to disk.
type Store struct {
	path string
	now  func() time.Time

	mu              sync.Mutex
	rows            map[rowKey]*Counters
	accounts        map[string]Account
	firstRecordedAt int64
	dirty           bool

	// writeMu serialises snapshot+write so an older snapshot never overwrites a newer one.
	writeMu sync.Mutex

	stopCh    chan struct{}
	doneCh    chan struct{}
	closeOnce sync.Once
	closeErr  error
}

var defaultStore atomic.Pointer[Store]

// Default returns the process-wide store, or nil when it has not been initialised.
func Default() *Store { return defaultStore.Load() }

// SetDefault installs the process-wide store (nil clears it).
func SetDefault(s *Store) { defaultStore.Store(s) }

// HandleUsage implements usage.Plugin. It only updates in-memory maps.
func (s *Store) HandleUsage(_ context.Context, record usage.Record) {
	if s == nil || !usage.GenerateEnabled(record.Generate) {
		return
	}
	breakdown := usage.EnsureTokenBreakdownForProvider(record.Detail, record.Provider, record.ExecutorType).TokenBreakdown
	delta := Counters{
		Requests:           1,
		InputTokens:        breakdown.Input.UncachedTokens,
		CacheReadTokens:    breakdown.Input.CacheReadTokens,
		CacheWriteTokens:   breakdown.Input.CacheWriteTokens,
		OutputTokens:       breakdown.Output.TotalTokens,
		ReasoningTokens:    breakdown.Output.ReasoningTokens,
		UnclassifiedTokens: breakdown.UnclassifiedTokens,
	}
	if record.Failed {
		delta.Failed = 1
	}

	timestamp := record.RequestedAt
	if timestamp.IsZero() {
		timestamp = s.now()
	}
	provider := strings.ToLower(strings.TrimSpace(record.Provider))
	if provider == "" {
		provider = unknownValue
	}
	authIndex := strings.TrimSpace(record.AuthIndex)
	key := rowKey{
		hour:       hourStart(timestamp.Unix()),
		provider:   provider,
		authIndex:  authIndex,
		model:      recordModel(record),
		promptTier: promptTier(delta.InputTokens + delta.CacheReadTokens + delta.CacheWriteTokens),
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	counters := s.rows[key]
	if counters == nil {
		counters = &Counters{}
		s.rows[key] = counters
	}
	counters.add(delta)
	if authIndex != "" {
		account := s.accounts[authIndex]
		account.Provider = provider
		if isOAuth(record.AuthType) {
			if label := strings.TrimSpace(record.Source); label != "" {
				account.Label = label
			}
		}
		if seen := timestamp.Unix(); seen > account.LastSeen {
			account.LastSeen = seen
		}
		s.accounts[authIndex] = account
	}
	s.dirty = true
}

// isOAuth reports whether a usage record's AuthType denotes an OAuth credential.
// AuthType comes from Auth.AuthKind(): "oauth", "apikey" or "".
func isOAuth(authType string) bool {
	return strings.EqualFold(strings.TrimSpace(authType), coreauth.AuthKindOAuth)
}

func recordModel(record usage.Record) string {
	for _, candidate := range []string{record.Model, record.ResponseModel, record.Alias} {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" {
			return trimmed
		}
	}
	return unknownValue
}

func promptTier(promptTokens int64) int {
	switch {
	case promptTokens > promptTier2Threshold:
		return 2
	case promptTokens > promptTier1Threshold:
		return 1
	default:
		return 0
	}
}

func hourStart(unix int64) int64 {
	return floorDiv(unix, 3600) * 3600
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}
