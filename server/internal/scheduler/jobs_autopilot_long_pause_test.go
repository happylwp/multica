package scheduler

import (
	"context"
	"testing"
	"time"
)

// planAutopilotTrigger runs the autopilot PlansForScope hook for a single
// trigger whose last stored plan_time is lastPlan. The LatestPlanInfo the
// hook sees is built from found: found=true means the scheduler has
// dispatch history (resume-after-plan_time path), found=false is a cold
// start (last-fired / created anchor, WS-1465 policy).
func planAutopilotTrigger(t *testing.T, cron string, lastPlan, now time.Time, found bool) []time.Time {
	t.Helper()
	cache := newAutopilotScheduleCache()
	cache.replace(map[string]autopilotTriggerConfig{
		"trigger": {TriggerID: "trigger", CronExpression: cron, Timezone: "UTC"},
	})
	plans, err := autopilotPlansForScope(cache)(
		context.Background(),
		Scope{Kind: ScopeKindAutopilotTrigger, ID: "trigger"},
		now,
		LatestPlanInfo{Found: found, PlanTime: lastPlan, Status: "SUCCESS"},
	)
	if err != nil {
		t.Fatalf("plans hook: %v", err)
	}
	return plans
}

// Dense cron schedules must resume even when the pause exceeds the
// occurrence enumerator's 1024-entry cap (#8939).
func TestAutopilotPlansForScopeDenseCronAfterLongPause(t *testing.T) {
	now := time.Date(2026, 9, 4, 16, 5, 10, 0, time.UTC)

	cases := []struct {
		name     string
		cron     string
		lastPlan time.Time
		want     time.Time
	}{
		{
			name:     "every minute, 18h pause (1080 occurrences)",
			cron:     "* * * * *",
			lastPlan: time.Date(2026, 9, 3, 22, 5, 0, 0, time.UTC),
			want:     time.Date(2026, 9, 4, 16, 5, 0, 0, time.UTC),
		},
		{
			name:     "every minute, 3-day pause",
			cron:     "* * * * *",
			lastPlan: time.Date(2026, 9, 1, 16, 5, 0, 0, time.UTC),
			want:     time.Date(2026, 9, 4, 16, 5, 0, 0, time.UTC),
		},
		{
			name:     "every minute, short pause",
			cron:     "* * * * *",
			lastPlan: time.Date(2026, 9, 4, 15, 55, 0, 0, time.UTC),
			want:     time.Date(2026, 9, 4, 16, 5, 0, 0, time.UTC),
		},
		{
			name:     "every two minutes, 18h pause (540 occurrences)",
			cron:     "*/2 * * * *",
			lastPlan: time.Date(2026, 9, 3, 22, 5, 0, 0, time.UTC),
			want:     time.Date(2026, 9, 4, 16, 4, 0, 0, time.UTC),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plans := planAutopilotTrigger(t, tc.cron, tc.lastPlan, now, true)
			if len(plans) != 1 || !plans[0].Equal(tc.want) {
				t.Fatalf("plans = %v, want [%s]", plans, tc.want.Format(time.RFC3339))
			}
		})
	}
}

// An already-stuck trigger must recover on the next tick and keep firing
// without a cron change or trigger recreation.
func TestAutopilotStuckTriggerSelfHealsWithoutManualRecovery(t *testing.T) {
	// Reproduce the stale anchor reported in #8939.
	firstTick := time.Date(2026, 9, 4, 16, 5, 10, 0, time.UTC)
	silentSince := time.Date(2026, 9, 3, 22, 5, 0, 0, time.UTC)

	plans := planAutopilotTrigger(t, "* * * * *", silentSince, firstTick, true)
	wantFirst := time.Date(2026, 9, 4, 16, 5, 0, 0, time.UTC)
	if len(plans) != 1 || !plans[0].Equal(wantFirst) {
		t.Fatalf("first tick after the fix: plans = %v, want [%s]", plans, wantFirst.Format(time.RFC3339))
	}

	// The dispatch stores plan_time, so the next tick resumes from the
	// healed anchor and keeps firing on the normal minute cadence.
	nextTick := firstTick.Add(time.Minute)
	wantNext := wantFirst.Add(time.Minute)
	plans = planAutopilotTrigger(t, "* * * * *", plans[0], nextTick, true)
	if len(plans) != 1 || !plans[0].Equal(wantNext) {
		t.Fatalf("second tick: plans = %v, want [%s]", plans, wantNext.Format(time.RFC3339))
	}
}

// Preserve the existing behavior for future and already-claimed anchors:
// wait for a later occurrence instead of moving the anchor backwards.
func TestAutopilotPlansForScopeDoesNotRewindAnchor(t *testing.T) {
	now := time.Date(2026, 9, 4, 16, 5, 10, 0, time.UTC)
	current := time.Date(2026, 9, 4, 16, 5, 0, 0, time.UTC)
	future := current.Add(6 * time.Hour)

	if plans := planAutopilotTrigger(t, "* * * * *", future, now, true); len(plans) != 0 {
		t.Fatalf("future anchor: plans = %v, want none", plans)
	}
	// An anchor exactly at `now` is a healthy already-claimed slot: stay
	// quiet this tick (no duplicate claim of the same occurrence) and fire
	// the next one.
	if plans := planAutopilotTrigger(t, "* * * * *", now, now, true); len(plans) != 0 {
		t.Fatalf("anchor at now: plans = %v, want none this tick", plans)
	}
	next := current.Add(time.Minute)
	if plans := planAutopilotTrigger(t, "* * * * *", current, now.Add(time.Minute), true); len(plans) != 1 || !plans[0].Equal(next) {
		t.Fatalf("steady state past an anchor at now: plans = %v, want [%s]", plans, next.Format(time.RFC3339))
	}
	if plans := planAutopilotTrigger(t, "* * * * *", future, future, true); len(plans) != 0 {
		t.Fatalf("clock reaches the stored anchor: plans = %v, want none", plans)
	}
	firstDue := future.Add(time.Minute)
	if plans := planAutopilotTrigger(t, "* * * * *", future, firstDue, true); len(plans) != 1 || !plans[0].Equal(firstDue) {
		t.Fatalf("clock passes the stored anchor: plans = %v, want [%s]", plans, firstDue.Format(time.RFC3339))
	}
}

// TestAutopilotPlansForScopeSurfacesMissedOccurrences pins the catch-up
// contract: a missed occurrence inside the dense window is surfaced (the
// handler dispatches it — the old policy dropped anything more than five
// minutes late), a sparser miss inside the lookback window is surfaced too
// (the handler records a skip and advances the display next_run_at), and
// only occurrences older than the lookback window are ignored outright.
func TestAutopilotPlansForScopeSurfacesMissedOccurrences(t *testing.T) {
	// Hourly cron, slot missed by 40 minutes — inside the dense window.
	lastPlan := time.Date(2026, 9, 4, 15, 0, 0, 0, time.UTC)
	due := time.Date(2026, 9, 4, 16, 0, 0, 0, time.UTC)
	if plans := planAutopilotTrigger(t, "0 * * * *", lastPlan, due.Add(40*time.Minute), true); len(plans) != 1 || !plans[0].Equal(due) {
		t.Fatalf("40-minute-old occurrence: plans = %v, want [%s]", plans, due.Format(time.RFC3339))
	}

	// Monthly cron, slot missed by 3 days — beyond the dense window but
	// inside the lookback window: surfaced via the sparse lookup.
	monthlyLast := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	monthlyDue := time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)
	if plans := planAutopilotTrigger(t, "0 9 1 * *", monthlyLast, monthlyDue.Add(72*time.Hour), true); len(plans) != 1 || !plans[0].Equal(monthlyDue) {
		t.Fatalf("3-day-old monthly occurrence: plans = %v, want [%s]", plans, monthlyDue.Format(time.RFC3339))
	}

	// Monthly cron, slot missed by more than the lookback window: ignored.
	if plans := planAutopilotTrigger(t, "0 9 1 * *", monthlyLast, monthlyDue.Add(maxAutopilotScheduleLookback+time.Hour), true); len(plans) != 0 {
		t.Fatalf("beyond the lookback window: plans = %v, want none", plans)
	}

	// Cold start (no scheduler history): WS-1465 keeps its policy — a
	// trigger that became schedulable after its time had passed must not
	// fire the missed occurrence, however recent. The catch-up contract
	// above applies only to triggers the scheduler has dispatched before.
	if plans := planAutopilotTrigger(t, "0 * * * *", lastPlan, due.Add(40*time.Minute), false); len(plans) != 0 {
		t.Fatalf("cold start must not surface a 40-minute-old occurrence: plans = %v", plans)
	}
}
