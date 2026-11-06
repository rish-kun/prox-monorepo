package quotapoll

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

const (
	burstFileName = "burst.quota"

	// BurstPriorityBase lies above every normal routing priority. A prioritised
	// credential routes at BurstPriorityBase - order, so bursts keep their order
	// and all of them outrank normal priorities.
	BurstPriorityBase = 1 << 30

	burstSweepInterval = 30 * time.Second
	burstMinWait       = time.Second
	// burstSameWindowSlack tolerates drift between reset instants reported by
	// different sources for the same 5-hour window.
	burstSameWindowSlack = 2 * time.Minute

	claude5hStatusHeader = "anthropic-ratelimit-unified-5h-status"
	claude7dStatusHeader = "anthropic-ratelimit-unified-7d-status"
)

// Burst kinds: a 5-hour burst lasts until the account's current 5-hour window
// resets or is used up; a weekly burst lasts until its weekly window resets or
// is used up and survives the account's 5-hour windows running out (the account
// is skipped while it cools down and returns to the top when the window resets).
const (
	BurstKind5h     = "5h"
	BurstKindWeekly = "weekly"
)

// NormaliseBurstKind maps an API value to a burst kind; empty means 5h.
func NormaliseBurstKind(kind string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "", BurstKind5h:
		return BurstKind5h, true
	case BurstKindWeekly:
		return BurstKindWeekly, true
	default:
		return "", false
	}
}

func burstWindow(kind string) string {
	if kind == BurstKindWeekly {
		return WindowWeekly
	}
	return Window5h
}

func burstWindowName(kind string) string {
	if kind == BurstKindWeekly {
		return "weekly"
	}
	return "5-hour"
}

// Burst is one prioritised credential as returned by the management API.
type Burst struct {
	AuthIndex string    `json:"auth_index"`
	Provider  string    `json:"provider"`
	Label     string    `json:"label"`
	StartedAt time.Time `json:"started_at"`
	EndsAt    time.Time `json:"ends_at"`
	Order     int       `json:"order"`
	Kind      string    `json:"kind"`
}

// burstRecord is the persisted state of one burst. AuthID lets the routing
// override be installed before the credential list is available.
type burstRecord struct {
	AuthIndex string    `json:"auth_index"`
	AuthID    string    `json:"auth_id"`
	Provider  string    `json:"provider"`
	StartedAt time.Time `json:"started_at"`
	EndsAt    time.Time `json:"ends_at"`
	// Kind is BurstKind5h or BurstKindWeekly; files written before weekly
	// bursts existed have no kind and are 5-hour bursts.
	Kind string `json:"kind,omitempty"`
}

// kind returns the burst kind, treating a missing kind as 5h.
func (r *burstRecord) kind() string {
	if r.Kind == BurstKindWeekly {
		return BurstKindWeekly
	}
	return BurstKind5h
}

type burstFile struct {
	Version int           `json:"version"`
	Bursts  []burstRecord `json:"bursts"`
}

// windowReading is the latest known state of one quota window of a credential.
type windowReading struct {
	at       time.Time
	used     float64
	resetsAt int64
	rejected bool
}

func (s *Service) burstPath() string { return filepath.Join(s.dir, burstFileName) }

// loadBursts reads burst.quota. A corrupt file is moved aside and the service
// starts without bursts.
func (s *Service) loadBursts() {
	if s.dir == "" {
		return
	}
	var file burstFile
	ok, errRead := s.readFile(s.burstPath(), &file, func() bool { return file.Version == fileVersion })
	if errRead != nil {
		log.WithError(errRead).Error("quotapoll: cannot read burst file; starting without prioritised accounts")
		return
	}
	if !ok {
		return
	}
	for _, rec := range file.Bursts {
		index := strings.TrimSpace(rec.AuthIndex)
		if index == "" || rec.EndsAt.IsZero() {
			continue
		}
		r := rec
		r.AuthIndex = index
		s.bursts[index] = &r
	}
}

// persistBurstsLocked writes the current bursts. Failures are logged and the
// in-memory state stays authoritative.
func (s *Service) persistBurstsLocked() {
	if s.dir == "" {
		return
	}
	file := burstFile{Version: fileVersion, Bursts: make([]burstRecord, 0, len(s.bursts))}
	for _, rec := range s.bursts {
		file.Bursts = append(file.Bursts, *rec)
	}
	sort.Slice(file.Bursts, func(i, j int) bool { return file.Bursts[i].AuthIndex < file.Bursts[j].AuthIndex })
	if errWrite := writeAtomic(s.burstPath(), file); errWrite != nil {
		log.WithError(errWrite).Warn("quotapoll: failed to persist prioritised accounts")
	}
}

func authsByIndex(auths []*coreauth.Auth) map[string]*coreauth.Auth {
	out := make(map[string]*coreauth.Auth, len(auths))
	for _, auth := range auths {
		if auth == nil {
			continue
		}
		if index := strings.TrimSpace(auth.EnsureIndex()); index != "" {
			out[index] = auth
		}
	}
	return out
}

func authDisabled(auth *coreauth.Auth) bool {
	return auth.Disabled || auth.Status == coreauth.StatusDisabled
}

// sweepBurstsLocked drops bursts whose window has reset or whose credential was
// removed or disabled. Removal is only inferred from a non-empty credential
// list so a transiently empty list cannot wipe every burst.
func (s *Service) sweepBurstsLocked(now time.Time, auths map[string]*coreauth.Auth) bool {
	changed := false
	for index, rec := range s.bursts {
		auth, known := auths[index]
		switch {
		case !now.Before(rec.EndsAt):
			log.WithFields(log.Fields{"auth_index": index, "provider": rec.Provider}).Infof("quotapoll: prioritised %s window ended", burstWindowName(rec.kind()))
		case known && authDisabled(auth):
			log.WithFields(log.Fields{"auth_index": index, "provider": rec.Provider}).Info("quotapoll: prioritised credential disabled; burst cancelled")
		case known && s.burstExhausted(rec, auth):
			log.WithFields(log.Fields{"auth_index": index, "provider": rec.Provider}).Infof("quotapoll: prioritised %s limit used up; burst ended", burstWindowName(rec.kind()))
		case !known && len(auths) > 0:
			log.WithFields(log.Fields{"auth_index": index, "provider": rec.Provider}).Info("quotapoll: prioritised credential removed; burst cancelled")
		default:
			if known && auth.ID != "" && auth.ID != rec.AuthID {
				rec.AuthID = auth.ID
				changed = true
			}
			continue
		}
		delete(s.bursts, index)
		changed = true
	}
	return changed
}

// orderedBurstsLocked returns the bursts in routing order: soonest reset first,
// then higher normal priority, then auth index.
func (s *Service) orderedBurstsLocked(auths map[string]*coreauth.Auth) []*burstRecord {
	out := make([]*burstRecord, 0, len(s.bursts))
	priorities := make(map[string]int, len(s.bursts))
	for index, rec := range s.bursts {
		out = append(out, rec)
		priorities[index] = routingPriority(auths[index])
	}
	sort.Slice(out, func(i, j int) bool {
		left, right := out[i], out[j]
		if !left.EndsAt.Equal(right.EndsAt) {
			return left.EndsAt.Before(right.EndsAt)
		}
		if pl, pr := priorities[left.AuthIndex], priorities[right.AuthIndex]; pl != pr {
			return pl > pr
		}
		return left.AuthIndex < right.AuthIndex
	})
	return out
}

// applyBurstsLocked publishes the routing overrides for the current bursts and
// returns them in API form.
func (s *Service) applyBurstsLocked(auths map[string]*coreauth.Auth) []Burst {
	ordered := s.orderedBurstsLocked(auths)
	overrides := make(map[string]int, len(ordered))
	out := make([]Burst, 0, len(ordered))
	for i, rec := range ordered {
		order := i + 1
		if rec.AuthID != "" {
			overrides[rec.AuthID] = BurstPriorityBase - order
		}
		label := ""
		if auth := auths[rec.AuthIndex]; auth != nil {
			label = accountLabel(auth)
		}
		out = append(out, Burst{
			AuthIndex: rec.AuthIndex,
			Provider:  rec.Provider,
			Label:     label,
			StartedAt: rec.StartedAt.UTC(),
			EndsAt:    rec.EndsAt.UTC(),
			Order:     order,
			Kind:      rec.kind(),
		})
	}
	if s.applyOverrides != nil {
		s.applyOverrides(overrides)
	}
	return out
}

// reconcileBurstsLocked expires bursts, persists any change and republishes the
// routing overrides.
func (s *Service) reconcileBurstsLocked(auths map[string]*coreauth.Auth) []Burst {
	if s.sweepBurstsLocked(s.now(), auths) {
		s.persistBurstsLocked()
	}
	return s.applyBurstsLocked(auths)
}

// Bursts returns the prioritised credentials in routing order. Expired bursts
// are removed first.
func (s *Service) Bursts() []Burst {
	if s == nil {
		return []Burst{}
	}
	auths := authsByIndex(s.auths())
	s.burstMu.Lock()
	defer s.burstMu.Unlock()
	return s.reconcileBurstsLocked(auths)
}

// SweepBursts expires bursts and republishes the routing overrides.
func (s *Service) SweepBursts() {
	_ = s.Bursts()
}

// Prioritise starts a 5-hour burst; see PrioritiseKind.
func (s *Service) Prioritise(authIndex string) ([]Burst, error) {
	return s.PrioritiseKind(authIndex, BurstKind5h)
}

// PrioritiseKind starts a burst for a Claude/Codex OAuth credential that ends
// when its current 5-hour (kind 5h) or weekly (kind weekly) window resets or is
// used up. Prioritising with the kind already running is a no-op; the other
// kind replaces the running burst.
func (s *Service) PrioritiseKind(authIndex, kind string) ([]Burst, error) {
	index := strings.TrimSpace(authIndex)
	if index == "" {
		return nil, &RequestError{Status: http.StatusBadRequest, Message: "auth_index is required"}
	}
	kind, okKind := NormaliseBurstKind(kind)
	if !okKind {
		return nil, &RequestError{Status: http.StatusBadRequest, Message: `kind must be "5h" or "weekly"`}
	}
	window := burstWindow(kind)
	name := burstWindowName(kind)
	auths := authsByIndex(s.auths())
	auth := auths[index]
	if auth == nil {
		return nil, &RequestError{Status: http.StatusNotFound, Message: fmt.Sprintf("credential %s not found", index)}
	}
	provider := strings.ToLower(strings.TrimSpace(auth.Provider))
	if !isPollable(provider, auth) {
		return nil, &RequestError{Status: http.StatusBadRequest, Message: "only Claude or Codex OAuth accounts can be prioritised"}
	}

	// The saved reading may predate the running window (its reset already
	// passed). Refresh it once through the shared poller before deciding; the
	// one-minute attempt guard keeps repeated clicks from reaching upstream.
	if reading, ok := s.windowReading(index, provider, auth, window); !authDisabled(auth) && (!ok || reading.resetsAt <= s.now().Unix()) {
		if _, errRefresh := s.Refresh(s.baseContext(), []string{index}, false); errRefresh != nil {
			log.WithError(errRefresh).WithField("auth_index", index).Debug("quotapoll: refresh before prioritise failed")
		}
	}

	s.burstMu.Lock()
	defer s.burstMu.Unlock()
	now := s.now()
	if s.sweepBurstsLocked(now, auths) {
		s.persistBurstsLocked()
	}
	if rec, active := s.bursts[index]; active && rec.kind() == kind {
		return s.applyBurstsLocked(auths), nil
	}
	if authDisabled(auth) {
		return nil, &RequestError{Status: http.StatusConflict, Message: "account is disabled"}
	}
	reading, ok := s.windowReading(index, provider, auth, window)
	if !ok || reading.resetsAt <= now.Unix() {
		return nil, &RequestError{Status: http.StatusConflict, Message: fmt.Sprintf("no running %s window", name)}
	}
	if reading.rejected || reading.used >= 100 {
		return nil, &RequestError{Status: http.StatusConflict, Message: fmt.Sprintf("%s window already used up", name)}
	}
	s.bursts[index] = &burstRecord{
		AuthIndex: index,
		AuthID:    auth.ID,
		Provider:  provider,
		StartedAt: now.UTC().Truncate(time.Second),
		EndsAt:    time.Unix(reading.resetsAt, 0).UTC(),
		Kind:      kind,
	}
	s.persistBurstsLocked()
	log.WithFields(log.Fields{"auth_index": index, "provider": provider}).Infof("quotapoll: account prioritised until its %s reset", name)
	return s.applyBurstsLocked(auths), nil
}

// CancelBurst stops the burst of a credential; unknown indexes are a no-op.
func (s *Service) CancelBurst(authIndex string) ([]Burst, error) {
	index := strings.TrimSpace(authIndex)
	if index == "" {
		return nil, &RequestError{Status: http.StatusBadRequest, Message: "auth_index is required"}
	}
	auths := authsByIndex(s.auths())
	s.burstMu.Lock()
	defer s.burstMu.Unlock()
	changed := s.sweepBurstsLocked(s.now(), auths)
	if _, active := s.bursts[index]; active {
		delete(s.bursts, index)
		changed = true
		log.WithField("auth_index", index).Info("quotapoll: account prioritisation cancelled")
	}
	if changed {
		s.persistBurstsLocked()
	}
	return s.applyBurstsLocked(auths), nil
}

// burstExhausted reports whether the burst's window has been used up: either a
// reading taken after the burst started shows that window rejected or at 100 %,
// or the proxy holds a quota cooldown lasting until the window resets. Readings
// from before the burst never count, so stale data cannot end it. A weekly
// burst is not ended by a 5-hour cooldown, which recovers well before its end.
func (s *Service) burstExhausted(rec *burstRecord, auth *coreauth.Auth) bool {
	if auth.Quota.Exceeded && auth.Quota.Reason == "credential_quota" &&
		!auth.Quota.NextRecoverAt.Before(rec.EndsAt.Add(-burstSameWindowSlack)) {
		return true
	}
	reading, ok := s.windowReading(rec.AuthIndex, rec.Provider, auth, burstWindow(rec.kind()))
	if !ok || reading.at.Before(rec.StartedAt) {
		return false
	}
	if delta := reading.resetsAt - rec.EndsAt.Unix(); delta > int64(burstSameWindowSlack/time.Second) || -delta > int64(burstSameWindowSlack/time.Second) {
		return false
	}
	return reading.rejected || reading.used >= 100
}

// windowReading returns the freshest known reading of one window (Window5h or
// WindowWeekly) with a known reset: the passive response headers or the polled
// usage body.
func (s *Service) windowReading(index, provider string, auth *coreauth.Auth, window string) (windowReading, bool) {
	var best windowReading
	found := false
	consider := func(candidate windowReading) {
		if candidate.resetsAt <= 0 {
			return
		}
		if !found || candidate.at.After(best.at) {
			best = candidate
			found = true
		}
	}

	statusHeader := claude5hStatusHeader
	if window == WindowWeekly {
		statusHeader = claude7dStatusHeader
	}
	if observedAt := auth.Quota.ObservedAt; !observedAt.IsZero() && len(auth.Quota.Signals) > 0 {
		rejected := false
		if provider == ProviderClaude {
			for key, value := range auth.Quota.Signals {
				if strings.EqualFold(strings.TrimSpace(key), statusHeader) {
					rejected = strings.EqualFold(strings.TrimSpace(value), "rejected")
				}
			}
		}
		for _, sample := range extractHeaderSamples(provider, auth.Quota.Signals, observedAt) {
			if sample.window == window {
				consider(windowReading{at: observedAt, used: sample.used, resetsAt: sample.resetsAt, rejected: rejected})
			}
		}
	}

	s.mu.Lock()
	var fetchedAt time.Time
	var usage Response
	hasUsage := false
	if e := s.entries[index]; e != nil && e.snap.FetchedAt != nil {
		fetchedAt = *e.snap.FetchedAt
		usage, hasUsage = e.snap.Responses[responseUsage]
	}
	s.mu.Unlock()
	if hasUsage && usage.StatusCode >= 200 && usage.StatusCode <= 299 {
		for _, sample := range extractPollSamples(provider, usage.Body, fetchedAt) {
			if sample.window == window {
				consider(windowReading{at: fetchedAt, used: sample.used, resetsAt: sample.resetsAt})
			}
		}
	}
	return best, found
}

// burstLoop expires bursts at their reset instant, checking at least every 30 s.
func (s *Service) burstLoop(ctx context.Context) {
	defer s.wg.Done()
	timer := time.NewTimer(s.nextBurstWait())
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.SweepBursts()
			timer.Reset(s.nextBurstWait())
		}
	}
}

// nextBurstWait is the delay until the next sweep: the earliest burst end,
// bounded to [1 s, 30 s].
func (s *Service) nextBurstWait() time.Duration {
	wait := burstSweepInterval
	now := s.now()
	s.burstMu.Lock()
	for _, rec := range s.bursts {
		if until := rec.EndsAt.Sub(now); until < wait {
			wait = until
		}
	}
	s.burstMu.Unlock()
	if wait < burstMinWait {
		wait = burstMinWait
	}
	return wait
}
