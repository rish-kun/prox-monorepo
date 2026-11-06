package auth

import (
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// AttributeFilePriority marks priority values inherited from a physical auth file.
const AttributeFilePriority = "file_priority"

// ApplyAuthPriorityMetadata copies a valid file priority into an auth's metadata and routing attributes.
func ApplyAuthPriorityMetadata(auth *Auth, metadata map[string]any) {
	if auth == nil {
		return
	}
	delete(auth.Attributes, AttributeFilePriority)
	rawPriority, ok := metadata["priority"]
	if !ok {
		return
	}
	priority := ""
	switch value := rawPriority.(type) {
	case float64:
		priority = strconv.Itoa(int(value))
	case string:
		priority = strings.TrimSpace(value)
		if _, errAtoi := strconv.Atoi(priority); errAtoi != nil {
			return
		}
	default:
		return
	}
	if auth.Metadata == nil {
		auth.Metadata = make(map[string]any)
	}
	auth.Metadata["priority"] = rawPriority
	if auth.Attributes == nil {
		auth.Attributes = make(map[string]string)
	}
	auth.Attributes["priority"] = priority
	auth.Attributes[AttributeFilePriority] = "true"
}

// priorityOverrides holds process-wide routing priority overrides keyed by auth ID.
// The map behind the pointer is immutable once stored, so readers on the request hot
// path only pay for one atomic load and one map lookup.
var (
	priorityOverrides   atomic.Pointer[map[string]int]
	priorityOverridesMu sync.Mutex
)

// priorityOverride returns the routing priority override registered for an auth ID.
func priorityOverride(authID string) (int, bool) {
	current := priorityOverrides.Load()
	if current == nil || len(*current) == 0 || authID == "" {
		return 0, false
	}
	priority, ok := (*current)[authID]
	return priority, ok
}

// PriorityOverrides returns a copy of the current routing priority overrides keyed by auth ID.
func PriorityOverrides() map[string]int {
	current := priorityOverrides.Load()
	if current == nil {
		return map[string]int{}
	}
	out := make(map[string]int, len(*current))
	for id, priority := range *current {
		out[id] = priority
	}
	return out
}

// SetPriorityOverrides replaces the process-wide routing priority overrides keyed by auth ID.
// An override takes precedence over the auth's "priority" attribute in every selection path
// without modifying the auth itself. It returns the IDs whose effective priority changed.
// Callers that own a Manager should prefer Manager.ApplyPriorityOverrides, which also
// re-evaluates the scheduler entries of the changed auths.
func SetPriorityOverrides(overrides map[string]int) []string {
	next := make(map[string]int, len(overrides))
	for id, priority := range overrides {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		next[id] = priority
	}

	priorityOverridesMu.Lock()
	defer priorityOverridesMu.Unlock()
	previous := map[string]int{}
	if current := priorityOverrides.Load(); current != nil {
		previous = *current
	}
	var changed []string
	for id, priority := range next {
		if old, ok := previous[id]; !ok || old != priority {
			changed = append(changed, id)
		}
	}
	for id := range previous {
		if _, ok := next[id]; !ok {
			changed = append(changed, id)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	sort.Strings(changed)
	priorityOverrides.Store(&next)
	return changed
}

// ApplyPriorityOverrides replaces the routing priority overrides (see SetPriorityOverrides)
// and immediately rebuilds the scheduler priority buckets of every auth whose effective
// priority changed, so the next pick already honours the new order. Overridden auths are
// re-checked even when the override itself did not change, which lets a periodic caller
// repair a scheduler that was built before the overrides were installed.
func (m *Manager) ApplyPriorityOverrides(overrides map[string]int) {
	changed := SetPriorityOverrides(overrides)
	if m == nil || m.scheduler == nil {
		return
	}
	ids := changed
	for id := range PriorityOverrides() {
		ids = append(ids, id)
	}
	m.scheduler.refreshPriorities(ids)
}
