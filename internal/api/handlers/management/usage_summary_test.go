package management

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/usagestore"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func serveUsageSummary(t *testing.T, rawQuery string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/v8/management/usage/summary?"+rawQuery, nil)
	(&Handler{}).GetUsageSummary(c)
	return recorder
}

func installUsageStore(t *testing.T) *usagestore.Store {
	t.Helper()
	store, errOpen := usagestore.Open(filepath.Join(t.TempDir(), "usage", "hourly.json"))
	if errOpen != nil {
		t.Fatal(errOpen)
	}
	prev := usagestore.Default()
	usagestore.SetDefault(store)
	t.Cleanup(func() {
		usagestore.SetDefault(prev)
		if errClose := store.Close(); errClose != nil {
			t.Errorf("close: %v", errClose)
		}
	})
	return store
}

func fixUsageSummaryNow(t *testing.T, now time.Time) {
	t.Helper()
	prev := usageSummaryNow
	usageSummaryNow = func() time.Time { return now }
	t.Cleanup(func() { usageSummaryNow = prev })
}

func TestGetUsageSummaryParamValidation(t *testing.T) {
	installUsageStore(t)
	for _, rawQuery := range []string{
		"from=abc",
		"to=1.5",
		"from=10&to=5",
		"bucket=week",
		"tz_offset_minutes=x",
		"tz_offset_minutes=1441",
		"tz_offset_minutes=-1441",
	} {
		if recorder := serveUsageSummary(t, rawQuery); recorder.Code != http.StatusBadRequest {
			t.Errorf("%s: status=%d body=%s", rawQuery, recorder.Code, recorder.Body.String())
		}
	}
}

func TestGetUsageSummaryUnavailable(t *testing.T) {
	prev := usagestore.Default()
	usagestore.SetDefault(nil)
	t.Cleanup(func() { usagestore.SetDefault(prev) })
	if recorder := serveUsageSummary(t, ""); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestGetUsageSummaryDefaultsAndRows(t *testing.T) {
	now := time.Unix(1_760_086_800, 0) // on an hour boundary
	fixUsageSummaryNow(t, now)
	store := installUsageStore(t)
	store.HandleUsage(context.Background(), usage.Record{
		Provider: "claude", AuthIndex: "a1b2", AuthType: "oauth", Source: "user@example.com",
		Model: "claude-opus-5-5", RequestedAt: now.Add(-time.Hour),
		Detail: usage.Detail{InputTokens: 10, OutputTokens: 5},
	})
	store.HandleUsage(context.Background(), usage.Record{
		Provider: "claude", AuthIndex: "a1b2", Model: "claude-opus-5-5", RequestedAt: now.Add(-25 * time.Hour),
	})

	recorder := serveUsageSummary(t, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var body usagestore.Summary
	if errUnmarshal := json.Unmarshal(recorder.Body.Bytes(), &body); errUnmarshal != nil {
		t.Fatal(errUnmarshal)
	}
	if body.To != now.Unix() || body.From != now.Unix()-86400 || body.Bucket != "hour" || body.TZOffsetMinutes != 0 {
		t.Fatalf("defaults=%+v", body)
	}
	if len(body.Rows) != 1 || body.Rows[0].Start != now.Unix()-3600 || body.Rows[0].Requests != 1 || body.Rows[0].Model != "claude-opus-5-5" {
		t.Fatalf("rows=%+v", body.Rows)
	}
	if body.Accounts["a1b2"].Label != "user@example.com" || body.Accounts["a1b2"].Provider != "claude" {
		t.Fatalf("accounts=%+v", body.Accounts)
	}

	recorder = serveUsageSummary(t, "from=0&to=1760086800&bucket=DAY&tz_offset_minutes=330")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	body = usagestore.Summary{}
	if errUnmarshal := json.Unmarshal(recorder.Body.Bytes(), &body); errUnmarshal != nil {
		t.Fatal(errUnmarshal)
	}
	if body.Bucket != "day" || body.TZOffsetMinutes != 330 || body.From != 0 || len(body.Rows) != 2 {
		t.Fatalf("day summary=%+v", body)
	}
	for _, row := range body.Rows {
		if (row.Start+330*60)%86400 != 0 {
			t.Errorf("row start %d is not an IST midnight", row.Start)
		}
	}
}
