package usagestore

import (
	"cmp"
	"slices"
)

const (
	// BucketHour groups rows by UTC hour.
	BucketHour = "hour"
	// BucketDay groups rows by local day using the query's timezone offset.
	BucketDay = "day"
)

// Query selects rows with From <= hour < To and buckets them.
type Query struct {
	From            int64
	To              int64
	Bucket          string
	TZOffsetMinutes int
}

// SummaryRow is one merged bucket row in a summary response.
type SummaryRow struct {
	Start      int64  `json:"start"`
	Provider   string `json:"provider"`
	AuthIndex  string `json:"auth_index"`
	Model      string `json:"model"`
	PromptTier int    `json:"prompt_tier"`
	Counters
}

// SummaryAccount is the public account info returned with a summary.
type SummaryAccount struct {
	Provider string `json:"provider"`
	Label    string `json:"label"`
}

// Summary is the response body of the usage summary endpoint.
type Summary struct {
	From            int64                     `json:"from"`
	To              int64                     `json:"to"`
	Bucket          string                    `json:"bucket"`
	TZOffsetMinutes int                       `json:"tz_offset_minutes"`
	FirstRecordedAt int64                     `json:"first_recorded_at"`
	Rows            []SummaryRow              `json:"rows"`
	Accounts        map[string]SummaryAccount `json:"accounts"`
}

// Summary returns rows in [q.From, q.To) merged into hour or day buckets,
// plus the accounts referenced by those rows.
func (s *Store) Summary(q Query) Summary {
	bucket := q.Bucket
	if bucket != BucketDay {
		bucket = BucketHour
	}
	out := Summary{
		From:            q.From,
		To:              q.To,
		Bucket:          bucket,
		TZOffsetMinutes: q.TZOffsetMinutes,
		Rows:            []SummaryRow{},
		Accounts:        map[string]SummaryAccount{},
	}
	if s == nil {
		return out
	}
	offset := int64(q.TZOffsetMinutes) * 60

	merged := make(map[rowKey]*Counters)
	s.mu.Lock()
	out.FirstRecordedAt = s.firstRecordedAt
	for key, counters := range s.rows {
		if key.hour < q.From || key.hour >= q.To {
			continue
		}
		start := key.hour
		if bucket == BucketDay {
			start = floorDiv(key.hour+offset, 86400)*86400 - offset
		}
		mergedKey := key
		mergedKey.hour = start
		target := merged[mergedKey]
		if target == nil {
			target = &Counters{}
			merged[mergedKey] = target
		}
		target.add(*counters)
		if key.authIndex != "" {
			if account, ok := s.accounts[key.authIndex]; ok {
				out.Accounts[key.authIndex] = SummaryAccount{Provider: account.Provider, Label: account.Label}
			}
		}
	}
	s.mu.Unlock()

	for key, counters := range merged {
		out.Rows = append(out.Rows, SummaryRow{
			Start:      key.hour,
			Provider:   key.provider,
			AuthIndex:  key.authIndex,
			Model:      key.model,
			PromptTier: key.promptTier,
			Counters:   *counters,
		})
	}
	slices.SortFunc(out.Rows, func(a, b SummaryRow) int {
		return compareKeys(
			rowKey{a.Start, a.Provider, a.AuthIndex, a.Model, a.PromptTier},
			rowKey{b.Start, b.Provider, b.AuthIndex, b.Model, b.PromptTier},
		)
	})
	return out
}

func sortFileRows(rows []fileRow) {
	slices.SortFunc(rows, func(a, b fileRow) int {
		return compareKeys(
			rowKey{a.Hour, a.Provider, a.AuthIndex, a.Model, a.PromptTier},
			rowKey{b.Hour, b.Provider, b.AuthIndex, b.Model, b.PromptTier},
		)
	})
}

func compareKeys(a, b rowKey) int {
	return cmp.Or(
		cmp.Compare(a.hour, b.hour),
		cmp.Compare(a.provider, b.provider),
		cmp.Compare(a.authIndex, b.authIndex),
		cmp.Compare(a.model, b.model),
		cmp.Compare(a.promptTier, b.promptTier),
	)
}
