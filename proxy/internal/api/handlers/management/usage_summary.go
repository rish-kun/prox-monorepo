package management

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/usagestore"
)

const (
	defaultUsageSummaryWindow = 24 * time.Hour
	// maxUsageTZOffsetMinutes bounds tz_offset_minutes to a full day either way.
	maxUsageTZOffsetMinutes = 24 * 60
)

// usageSummaryNow is the clock used for default query bounds; tests override it.
var usageSummaryNow = time.Now

// GetUsageSummary returns persisted hourly token usage merged into hour or day buckets.
func (h *Handler) GetUsageSummary(c *gin.Context) {
	query, errQuery := parseUsageSummaryQuery(c, usageSummaryNow())
	if errQuery != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": errQuery.Error()})
		return
	}
	store := usagestore.Default()
	if store == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "usage store not initialised"})
		return
	}
	c.JSON(http.StatusOK, store.Summary(query))
}

func parseUsageSummaryQuery(c *gin.Context, now time.Time) (usagestore.Query, error) {
	query := usagestore.Query{Bucket: usagestore.BucketHour}

	to, errTo := parseOptionalInt64(c.Query("to"), now.Unix())
	if errTo != nil {
		return query, errors.New("to must be unix seconds")
	}
	from, errFrom := parseOptionalInt64(c.Query("from"), to-int64(defaultUsageSummaryWindow/time.Second))
	if errFrom != nil {
		return query, errors.New("from must be unix seconds")
	}
	if from > to {
		return query, errors.New("from must not be after to")
	}

	switch bucket := strings.ToLower(strings.TrimSpace(c.Query("bucket"))); bucket {
	case "", usagestore.BucketHour:
	case usagestore.BucketDay:
		query.Bucket = usagestore.BucketDay
	default:
		return query, errors.New("bucket must be hour or day")
	}

	offset, errOffset := parseOptionalInt64(c.Query("tz_offset_minutes"), 0)
	if errOffset != nil || offset < -maxUsageTZOffsetMinutes || offset > maxUsageTZOffsetMinutes {
		return query, fmt.Errorf("tz_offset_minutes must be an integer between %d and %d", -maxUsageTZOffsetMinutes, maxUsageTZOffsetMinutes)
	}

	query.From = from
	query.To = to
	query.TZOffsetMinutes = int(offset)
	return query, nil
}

func parseOptionalInt64(value string, fallback int64) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	return strconv.ParseInt(value, 10, 64)
}
