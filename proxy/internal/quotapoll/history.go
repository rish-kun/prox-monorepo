package quotapoll

import (
	"math"
	"sort"
	"sync"
	"time"
)

const (
	// Window5h and WindowWeekly are the recorded quota windows.
	Window5h     = "5h"
	WindowWeekly = "weekly"

	// SourcePoll and SourceHeaders tell where a sample came from.
	SourcePoll    = "poll"
	SourceHeaders = "headers"

	historyRetention = 90 * 24 * time.Hour
	// thinUsedDelta, thinMaxGap and thinResetTolerance control when a new
	// sample is stored instead of being folded into the previous one.
	thinUsedDelta      = 0.5
	thinMaxGap         = int64(60 * 60)
	thinResetTolerance = int64(120)
)

// Sample is one recorded quota reading of a credential window.
type Sample struct {
	T         int64   `json:"t"`
	AuthIndex string  `json:"auth_index"`
	Provider  string  `json:"provider"`
	Window    string  `json:"window"`
	Used      float64 `json:"used"`
	ResetsAt  int64   `json:"resets_at"`
	Src       string  `json:"src"`
}

// HistorySample is a sample as returned by the history endpoint.
type HistorySample struct {
	T         int64   `json:"t"`
	AuthIndex string  `json:"auth_index"`
	Used      float64 `json:"used"`
	ResetsAt  int64   `json:"resets_at"`
}

type seriesKey struct {
	authIndex string
	window    string
}

type history struct {
	mu              sync.Mutex
	series          map[seriesKey][]Sample
	firstRecordedAt int64
	dirty           bool
}

func newHistory() *history {
	return &history{series: make(map[seriesKey][]Sample)}
}

// markStarted records the moment recording started when nothing was recorded yet.
func (h *history) markStarted(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.firstRecordedAt == 0 {
		h.firstRecordedAt = now.Unix()
		h.dirty = true
	}
}

// add stores a sample unless it is thinned away. With requireNewer the sample
// is only used when it is strictly newer than the latest stored sample.
func (h *history) add(sample Sample, requireNewer bool) bool {
	if sample.AuthIndex == "" || (sample.Window != Window5h && sample.Window != WindowWeekly) {
		return false
	}
	if math.IsNaN(sample.Used) || math.IsInf(sample.Used, 0) {
		return false
	}
	sample.Used = clampPercent(sample.Used)
	key := seriesKey{authIndex: sample.AuthIndex, window: sample.Window}

	h.mu.Lock()
	defer h.mu.Unlock()
	list := h.series[key]
	if n := len(list); n > 0 {
		last := list[n-1]
		if sample.T < last.T || (requireNewer && sample.T <= last.T) {
			return false
		}
		if !keepSample(last, sample) {
			return false
		}
	}
	h.series[key] = append(list, sample)
	if h.firstRecordedAt == 0 {
		h.firstRecordedAt = sample.T
	}
	h.dirty = true
	return true
}

// keepSample implements thinning: keep on a used change of at least 0.5
// points, a changed reset time or an hour since the previous kept sample.
// Reset times within two minutes of each other count as unchanged because
// reset_after_seconds based values drift by a few seconds between readings.
func keepSample(last, next Sample) bool {
	if math.Abs(next.Used-last.Used) >= thinUsedDelta {
		return true
	}
	if absInt64(next.ResetsAt-last.ResetsAt) > thinResetTolerance {
		return true
	}
	if (next.ResetsAt == 0) != (last.ResetsAt == 0) {
		return true
	}
	return next.T-last.T >= thinMaxGap
}

func absInt64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func clampPercent(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// prune drops samples older than the retention period.
func (h *history) prune(now time.Time) {
	cutoff := now.Add(-historyRetention).Unix()
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, list := range h.series {
		idx := sort.Search(len(list), func(i int) bool { return list[i].T >= cutoff })
		if idx == 0 {
			continue
		}
		h.dirty = true
		if idx == len(list) {
			delete(h.series, key)
			continue
		}
		h.series[key] = append([]Sample(nil), list[idx:]...)
	}
}

// query returns the samples of provider/window in [from, to] sorted by time,
// preceded per account by the latest sample before from.
func (h *history) query(provider, window string, from, to int64) (int64, []HistorySample) {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]HistorySample, 0)
	for key, list := range h.series {
		if key.window != window || len(list) == 0 || list[0].Provider != provider {
			continue
		}
		start := sort.Search(len(list), func(i int) bool { return list[i].T >= from })
		if start > 0 {
			start--
		}
		for _, sample := range list[start:] {
			if sample.T > to {
				break
			}
			out = append(out, HistorySample{T: sample.T, AuthIndex: sample.AuthIndex, Used: sample.Used, ResetsAt: sample.ResetsAt})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].T != out[j].T {
			return out[i].T < out[j].T
		}
		return out[i].AuthIndex < out[j].AuthIndex
	})
	return h.firstRecordedAt, out
}

// allLocked returns every sample ordered by series and time (persistence).
func (h *history) allLocked() []Sample {
	keys := make([]seriesKey, 0, len(h.series))
	total := 0
	for key, list := range h.series {
		keys = append(keys, key)
		total += len(list)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].authIndex != keys[j].authIndex {
			return keys[i].authIndex < keys[j].authIndex
		}
		return keys[i].window < keys[j].window
	})
	out := make([]Sample, 0, total)
	for _, key := range keys {
		out = append(out, h.series[key]...)
	}
	return out
}

// loadSamples replaces the in-memory series with persisted samples.
func (h *history) loadSamples(firstRecordedAt int64, samples []Sample) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.firstRecordedAt = firstRecordedAt
	h.series = make(map[seriesKey][]Sample)
	for _, sample := range samples {
		if sample.AuthIndex == "" || (sample.Window != Window5h && sample.Window != WindowWeekly) {
			continue
		}
		key := seriesKey{authIndex: sample.AuthIndex, window: sample.Window}
		h.series[key] = append(h.series[key], sample)
	}
	for key, list := range h.series {
		sort.SliceStable(list, func(i, j int) bool { return list[i].T < list[j].T })
		h.series[key] = list
	}
}
