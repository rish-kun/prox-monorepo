package registry

import "testing"

func TestGetClaudeModelsIncludesSupplementalHaiku55(t *testing.T) {
	var found *ModelInfo
	for _, model := range GetClaudeModels() {
		if model.ID == "claude-haiku-5-5" {
			if found != nil {
				t.Fatal("claude-haiku-5-5 listed twice")
			}
			found = model
		}
	}
	if found == nil {
		t.Fatal("claude-haiku-5-5 missing from Claude models")
	}
	if found.Thinking == nil || len(found.Thinking.Levels) == 0 {
		t.Fatalf("claude-haiku-5-5 should use level-based thinking, got %+v", found.Thinking)
	}
}

func TestAppendMissingModelsKeepsCatalogEntry(t *testing.T) {
	catalog := []*ModelInfo{{ID: "Claude-Haiku-5-5", DisplayName: "from catalog"}}
	got := appendMissingModels(catalog, supplementalClaudeModels)
	if len(got) != 1 || got[0].DisplayName != "from catalog" {
		t.Fatalf("catalog entry must win, got %d models (%q)", len(got), got[0].DisplayName)
	}
	got[0].DisplayName = "mutated"
	if supplementalClaudeModels[0].DisplayName == "mutated" {
		t.Fatal("supplemental definitions must not be shared")
	}
}
