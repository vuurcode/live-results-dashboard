package hub

import (
	"context"
	"testing"
	"time"

	"github.com/vuurcode/live-results-experiment/backend/internal/config"
	"github.com/vuurcode/live-results-experiment/backend/internal/source"
	"github.com/vuurcode/live-results-experiment/backend/internal/useragent"
)

func TestAllowanceDropsDaysOutsideTheWindow(t *testing.T) {
	h := New(context.Background(), config.Config{MaxClients30Days: 100}, source.NewSet(), useragent.New(""))
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	h.Now = func() time.Time { return now }

	h.mu.Lock()
	defer h.mu.Unlock()
	h.countConnectionLocked()
	now = now.AddDate(0, 0, quotaDays-1)
	h.countConnectionLocked()
	if !h.allowanceLeftLocked() || len(h.connsPerDay) != 2 {
		t.Fatalf("both days are inside the window: %v", h.connsPerDay)
	}
	now = now.AddDate(0, 0, 1)
	h.allowanceLeftLocked()
	if len(h.connsPerDay) != 1 {
		t.Fatalf("the first day must fall out of the window: %v", h.connsPerDay)
	}
}
