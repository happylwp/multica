package scheduler

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// JobNameAutopilotScheduleDispatch is the canonical job name written
// to sys_cron_executions audit rows. Stable across releases — renaming
// it would orphan historic rows.
const JobNameAutopilotScheduleDispatch = "autopilot_schedule_dispatch"

// ScopeKindAutopilotTrigger labels the scope dimension. Each enabled
// schedule trigger is one scope; scope_id is the trigger UUID.
const ScopeKindAutopilotTrigger = "autopilot_trigger"

// DefaultAutopilotScheduleTimezone is the fallback when a trigger's
// timezone column is NULL / empty. Matches
// service.DefaultAutopilotTriggerTimezone.
const DefaultAutopilotScheduleTimezone = "UTC"

// maxAutopilotScheduleLateness is the jitter margin for dispatching a
// cron occurrence after its configured plan_time on a cold start — the
// only acceptance window for triggers without scheduler history
// (WS-1465: an occurrence already missed when the trigger became
// schedulable must not fire). Normal scheduler jitter is tens of
// seconds.
const maxAutopilotScheduleLateness = 5 * time.Minute

// maxAutopilotScheduleCatchUp is how far past its configured plan_time a
// missed cron occurrence is still dispatched once the scheduler is
// available again (host was down for the slot, backend redeployed, …).
// Applies only to triggers with scheduler history, where a gap in the
// plan record means the scheduler itself was unavailable. A self-hosted
// single-node instance routinely gaps its slots by minutes to hours;
// the old 5-minute acceptance window silently dropped those
// occurrences, which for a monthly cron meant losing a whole cycle
// whenever its slot fell on an offline morning. Occurrences older than
// this window are not dispatched — the handler records a skip and
// advances the display next_run_at instead.
const maxAutopilotScheduleCatchUp = 24 * time.Hour

// maxAutopilotScheduleDenseWindow is the enumeration window of the
// planner's fast path. It must stay below NextOccurrencesUTC's 1024-entry
// cap for the densest legal cron ("* * * * *": 720 occurrences in 12h),
// so the most recent occurrence of even a minute-cron can never be
// hidden by the cap after a long pause — the MUL-7973 invariant. It is
// also the lateness the fast path can surface on its own; sparser
// misses are resolved by the single-occurrence lookup below.
const maxAutopilotScheduleDenseWindow = 12 * time.Hour

// maxAutopilotScheduleLookback bounds how far back the planner considers
// missed occurrences at all. Within the window the most recent occurrence
// is surfaced to the handler, which dispatches it if it is inside the
// catch-up window or records a skip that heals the display next_run_at.
// Beyond it occurrences are ignored entirely, so a trigger re-enabled
// after a very long pause does not fire an arbitrary long-stale slot.
const maxAutopilotScheduleLookback = 7 * 24 * time.Hour

// AutopilotScheduleDispatcher is the narrow contract this job needs
// from service.AutopilotService. Defined here so unit tests in this
// package (and the cmd/server integration tests) can stub it without
// pulling in the rest of the service layer.
type AutopilotScheduleDispatcher interface {
	DispatchAutopilotForPlan(
		ctx context.Context,
		autopilot db.Autopilot,
		triggerID pgtype.UUID,
		source string,
		payload []byte,
		plannedAt time.Time,
	) (*db.AutopilotRun, error)
}

// AutopilotScheduleDispatchJob returns the JobSpec that drives
// scheduled Autopilot dispatch through the existing scheduler +
// sys_cron_executions lease infrastructure. Replaces the legacy
// cmd/server/autopilot_scheduler.go goroutine (MUL-3551).
//
// Design highlights:
//
//   - Each enabled schedule trigger is its own scope
//     (scope_kind = "autopilot_trigger", scope_id = trigger.id).
//   - plan_time is a canonical UTC cron occurrence computed from the
//     trigger's cron expression + timezone against DB time. The
//     PlansForScope hook enumerates occurrences in (lastPlan, dbNow]
//     and returns only the most recent one (collapsing missed fires —
//     same policy as the legacy goroutine).
//   - The handler calls AutopilotService.DispatchAutopilotForPlan, which
//     is itself idempotent on (trigger_id, planned_at) via the partial
//     unique index from migration 124. Together with the
//     sys_cron_executions unique key on (job, scope, plan_time), the
//     same planned occurrence cannot produce duplicate runs even under
//     stale-steal retries.
//
// Restart semantics:
//
//   - Triggers are recovered from the autopilot_trigger table on the
//     next tick — no in-memory timer table is maintained. The
//     scope provider runs every tick and re-derives the eligible set
//     from `kind='schedule' AND enabled AND a.status='active'`.
//   - If the previous incarnation crashed after claiming a plan_time
//     but before writing terminal status, the stale-lease sweep in
//     manager.runJob promotes that row to FAILED with
//     error_code='stale_timeout'. AllowStaleReentry=true +
//     attempts < MaxAttempts lets the next tick steal the lease and
//     re-enter dispatch — DispatchAutopilotForPlan's idempotent lookup
//     then returns the already-created run rather than duplicating it.
func AutopilotScheduleDispatchJob(
	pool *pgxpool.Pool,
	queries *db.Queries,
	dispatcher AutopilotScheduleDispatcher,
) JobSpec {
	cache := newAutopilotScheduleCache()

	return JobSpec{
		Name:              JobNameAutopilotScheduleDispatch,
		Cadence:           0, // hook-driven; cron expressions are arbitrary
		ScheduleDelay:     0,
		CatchUpMode:       CatchUpLatestOnly, // ignored when hook is set, but documents intent
		// Mirrors maxAutopilotScheduleCatchUp, which the hook applies
		// itself: missed occurrences inside the window are dispatched
		// once the scheduler is back, older ones are skipped with the
		// display next_run_at advanced.
		CatchUpWindow:     24 * time.Hour,
		RunTimeout:        2 * time.Minute,
		StaleTimeout:      5 * time.Minute,
		HeartbeatInterval: 30 * time.Second,
		AllowStaleReentry: true,
		MaxAttempts:       3,
		RetryBackoff: []time.Duration{
			1 * time.Minute,
			5 * time.Minute,
			15 * time.Minute,
		},
		// Belt-and-suspenders: 5 plan_times is more than CatchUpLatestOnly
		// ever needs; the cap matters only if a future caller flips the
		// hook to every_plan semantics.
		MaxPlansPerTick: 5,

		Scopes:        autopilotScopes(pool, queries, cache),
		PlansForScope: autopilotPlansForScope(cache),
		Handler:       autopilotHandler(queries, dispatcher),
	}
}

// autopilotTriggerConfig is the per-tick view of one trigger that the
// planner hook needs (cron + timezone + bootstrap floor).
type autopilotTriggerConfig struct {
	TriggerID      string
	CronExpression string
	Timezone       string
	CreatedAt      time.Time
	// LastFiredAt is autopilot_trigger.last_fired_at; zero if the
	// trigger has never fired (or under no scheduler so far). Used by
	// the planner hook to anchor cold-start enumeration so that
	// occurrences which have already been processed (e.g. by the
	// legacy goroutine pre-migration, or by a prior incarnation of
	// this process pre-restart) are not replayed.
	LastFiredAt time.Time
}

// autopilotScheduleCache holds the per-tick map of trigger configs.
// The scope provider rewrites it at the top of each tick; the planner
// hook reads it once per scope. Reader-writer synchronisation lets us
// safely add parallel per-scope planning in the future.
type autopilotScheduleCache struct {
	mu       sync.RWMutex
	triggers map[string]autopilotTriggerConfig
}

func newAutopilotScheduleCache() *autopilotScheduleCache {
	return &autopilotScheduleCache{triggers: make(map[string]autopilotTriggerConfig)}
}

func (c *autopilotScheduleCache) replace(next map[string]autopilotTriggerConfig) {
	c.mu.Lock()
	c.triggers = next
	c.mu.Unlock()
}

func (c *autopilotScheduleCache) get(id string) (autopilotTriggerConfig, bool) {
	c.mu.RLock()
	v, ok := c.triggers[id]
	c.mu.RUnlock()
	return v, ok
}

// autopilotScopes lists every schedule trigger eligible to fire this
// tick and populates the cache used by the planner hook. Disabled
// triggers and paused/archived autopilots fall out naturally because
// the SQL filter excludes them.
func autopilotScopes(
	pool *pgxpool.Pool,
	queries *db.Queries,
	cache *autopilotScheduleCache,
) ScopeProvider {
	_ = pool // reserved for future tx-bounded reads
	return func(ctx context.Context, now time.Time) ([]Scope, error) {
		rows, err := queries.ListSchedulableAutopilotTriggers(ctx)
		if err != nil {
			return nil, fmt.Errorf("autopilot scope: list schedulable triggers: %w", err)
		}
		next := make(map[string]autopilotTriggerConfig, len(rows))
		scopes := make([]Scope, 0, len(rows))
		for _, r := range rows {
			id := util.UUIDToString(r.ID)
			if id == "" {
				continue
			}
			tz := DefaultAutopilotScheduleTimezone
			if r.Timezone.Valid && r.Timezone.String != "" {
				tz = r.Timezone.String
			}
			cron := ""
			if r.CronExpression.Valid {
				cron = r.CronExpression.String
			}
			if cron == "" {
				continue
			}
			createdAt := time.Time{}
			if r.CreatedAt.Valid {
				createdAt = r.CreatedAt.Time.UTC()
			}
			lastFiredAt := time.Time{}
			if r.LastFiredAt.Valid {
				lastFiredAt = r.LastFiredAt.Time.UTC()
			}
			next[id] = autopilotTriggerConfig{
				TriggerID:      id,
				CronExpression: cron,
				Timezone:       tz,
				CreatedAt:      createdAt,
				LastFiredAt:    lastFiredAt,
			}
			scopes = append(scopes, Scope{Kind: ScopeKindAutopilotTrigger, ID: id})
		}
		cache.replace(next)
		return scopes, nil
	}
}

// autopilotPlansForScope returns the PlansForScope hook that computes
// the cron occurrences in (lastPlan, dbNow] bounded by the lookback
// window, and keeps only the most recent one. The latest-only collapse
// prevents a long outage from replaying every missed slot; the surfaced
// occurrence is handed to the handler whatever its lateness, where the
// catch-up window decides between dispatching it and recording a skip
// (see maxAutopilotScheduleCatchUp).
//
// Retry-eligible state is handled specially: when the most recent
// stored plan_time is a FAILED row with attempts remaining and
// next_retry_at <= now, the hook returns THAT plan_time unchanged so
// tryClaim's FAILED-with-retry branch can fire. Without this branch,
// the half-open (latest.PlanTime, now] enumeration below would skip
// past the failed bucket and the occurrence would be lost — the
// canonical bug from the #4444 review where a claim+crash sequence
// could leak a scheduled occurrence (MUL-3551 acceptance ③).
func autopilotPlansForScope(cache *autopilotScheduleCache) func(
	ctx context.Context, scope Scope, now time.Time, latest LatestPlanInfo,
) ([]time.Time, error) {
	return func(ctx context.Context, scope Scope, now time.Time, latest LatestPlanInfo) ([]time.Time, error) {
		cfg, ok := cache.get(scope.ID)
		if !ok {
			// Trigger disappeared between scope-list and plan-compute,
			// or was filtered out. Nothing to plan — silent no-op is
			// correct.
			return nil, nil
		}

		// Retry path: the manager's stale-lease sweep has already
		// promoted any abandoned RUNNING row to FAILED. If that
		// FAILED row still has attempts remaining and its
		// next_retry_at has passed, the same plan_time is eligible
		// for another claim. tryClaim's retry-from-FAILED branch only
		// fires when the planner returns that exact plan_time, so we
		// MUST surface it here — moving forward to a newer occurrence
		// would strand the FAILED row at attempt < max_attempts
		// forever and leak the missed dispatch.
		if latest.RetryEligible(now) {
			return []time.Time{latest.PlanTime}, nil
		}

		// Anchor selection — three cases, in order:
		//
		//   1. `latest.Found`: this trigger has at least one
		//      sys_cron_executions row written by the new scheduler.
		//      Resume strictly after the most recent plan_time.
		//
		//   2. `cfg.LastFiredAt` is set: the trigger has been fired
		//      before, either by the legacy goroutine pre-migration
		//      or by a previous incarnation of this process. Resume
		//      strictly after the last successful fire so we do not
		//      replay an already-handled occurrence. This is the case
		//      that produced the post-deploy spurious-fire reported
		//      on MUL-3551 dev: without it, a trigger that fired at
		//      Mon 17:10 under the legacy code would be enumerated
		//      again the moment the new scheduler took over, because
		//      the (created_at, now] half-open interval still
		//      contained Mon 17:10.
		//
		//   3. Brand-new trigger that has never fired: anchor on
		//      created_at so only occurrences after the trigger
		//      existed are enumerated.
		//
		// Case 1 continues into the catch-up paths below; cases 2 and 3
		// are cold starts and stop at the jitter-margin branch.
		var after time.Time
		switch {
		case latest.Found:
			after = latest.PlanTime
		case !cfg.LastFiredAt.IsZero():
			after = cfg.LastFiredAt
		default:
			after = cfg.CreatedAt
		}

		// Cold start — no sys_cron_executions row from this scheduler.
		// Keep the WS-1465 policy verbatim: an occurrence that was
		// already missed when the trigger became schedulable (autopilot
		// re-enabled after a pause, first deploy of this scheduler) is
		// not fired; only occurrences inside the jitter margin go
		// through. The catch-up / skip-and-advance policy below applies
		// exclusively to triggers this scheduler has dispatched before,
		// where a gap in the plan history means the scheduler itself was
		// unavailable (host down, backend redeployed) — a state the
		// operator expects to be recovered, unlike a pause.
		if !latest.Found {
			if floor := now.Add(-maxAutopilotScheduleLateness); after.Before(floor) {
				after = floor.Add(-time.Nanosecond)
			}
			occs, err := service.NextOccurrencesUTC(cfg.CronExpression, cfg.Timezone, after, now)
			if err != nil {
				return nil, fmt.Errorf("autopilot plans: cron eval for trigger %s: %w", scope.ID, err)
			}
			if len(occs) == 0 {
				return nil, nil
			}
			return []time.Time{occs[len(occs)-1]}, nil
		}
		// Fast path — enumerate the dense window capped at
		// maxAutopilotScheduleDenseWindow ago. The window is cap-safe for
		// any legal cron (see the constant), so the latest occurrence it
		// returns is real even after a long pause. Subtract 1ns because
		// enumeration excludes `after`, but the floor bound is inclusive.
		anchor := after
		if floor := now.Add(-maxAutopilotScheduleDenseWindow); after.Before(floor) {
			after = floor.Add(-time.Nanosecond)
		}
		occs, err := service.NextOccurrencesUTC(cfg.CronExpression, cfg.Timezone, after, now)
		if err != nil {
			return nil, fmt.Errorf("autopilot plans: cron eval for trigger %s: %w", scope.ID, err)
		}
		if len(occs) > 0 {
			// CatchUpLatestOnly: collapse missed fires to the most recent.
			return []time.Time{occs[len(occs)-1]}, nil
		}

		// Sparse path — nothing is due inside the dense window, so any
		// due occurrence older than that is also the FIRST occurrence
		// after the anchor (no newer one exists, or the fast path would
		// have seen it). A single-occurrence lookup has no enumeration
		// cap. The anchor is floored at the lookback window — NOT at the
		// dense window — so a monthly cron whose slot was missed days ago
		// still surfaces that occurrence for the handler to skip-and-
		// advance; beyond the lookback it is ignored entirely.
		sparseAfter := anchor
		if floor := now.Add(-maxAutopilotScheduleLookback); sparseAfter.Before(floor) {
			sparseAfter = floor
		}
		occ, err := service.NextOccurrenceAfterUTC(cfg.CronExpression, cfg.Timezone, sparseAfter)
		if err != nil {
			return nil, fmt.Errorf("autopilot plans: cron eval for trigger %s: %w", scope.ID, err)
		}
		if occ.After(now) {
			return nil, nil
		}
		// Surface the missed occurrence regardless of lateness — the
		// handler decides whether it is still inside the catch-up window
		// (dispatch) or is recorded as a skip that advances the display
		// next_run_at. Dropping it here (the old policy) left next_run_at
		// pinned to a past slot for the whole next cycle whenever an
		// occurrence was missed by more than the jitter margin.
		return []time.Time{occ}, nil
	}
}

// autopilotHandler dispatches one (trigger, planTime) attempt and
// returns the lease-affecting outcome. It re-loads the trigger +
// autopilot inside the handler so a between-tick state change (e.g.
// trigger disabled, autopilot paused) takes effect immediately
// without waiting for the next scope-list.
func autopilotHandler(
	queries *db.Queries,
	dispatcher AutopilotScheduleDispatcher,
) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		triggerID, err := parseScopeUUID(in.Scope.ID)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("autopilot handler: scope id is not a valid uuid: %w", err)
		}

		trigger, err := queries.GetAutopilotTrigger(ctx, triggerID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// Trigger was deleted between scope-list and run.
				// A SUCCESS row in sys_cron_executions for a vanished
				// trigger is fine — there is nothing to dispatch and
				// no future tick will return this scope.
				return HandlerResult{RowsAffected: 0, Result: map[string]any{
					"skipped_reason": "trigger_not_found",
				}}, nil
			}
			return HandlerResult{}, fmt.Errorf("load trigger: %w", err)
		}
		if !trigger.Enabled || trigger.Kind != "schedule" {
			return HandlerResult{RowsAffected: 0, Result: map[string]any{
				"skipped_reason": "trigger_disabled",
			}}, nil
		}

		autopilot, err := queries.GetAutopilot(ctx, trigger.AutopilotID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return HandlerResult{RowsAffected: 0, Result: map[string]any{
					"skipped_reason": "autopilot_not_found",
				}}, nil
			}
			return HandlerResult{}, fmt.Errorf("load autopilot: %w", err)
		}
		if autopilot.Status != "active" {
			return HandlerResult{RowsAffected: 0, Result: map[string]any{
				"skipped_reason": "autopilot_inactive",
				"status":         autopilot.Status,
			}}, nil
		}

		// A surfaced occurrence beyond the catch-up window (host offline
		// for days, trigger re-enabled after a long pause) is not
		// dispatched: firing that long after its configured time is worse
		// than skipping. Record the skip so sys_cron_executions anchors
		// past this occurrence (no re-enumeration next tick) and advance
		// the display next_run_at — otherwise it stays pinned to the
		// missed slot for the whole next cycle, which reads as a dead
		// trigger in the UI.
		if time.Now().Sub(in.PlanTime) > maxAutopilotScheduleCatchUp {
			advanceTriggerDisplay(ctx, queries, trigger, in.PlanTime)
			return HandlerResult{RowsAffected: 0, Result: map[string]any{
				"skipped_reason": "catchup_window_expired",
				"plan_time":      in.PlanTime.UTC().Format(time.RFC3339),
			}}, nil
		}

		run, err := dispatcher.DispatchAutopilotForPlan(
			ctx, autopilot, trigger.ID, "schedule", nil, in.PlanTime,
		)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("dispatch for plan: %w", err)
		}

		advanceTriggerDisplay(ctx, queries, trigger, in.PlanTime)

		return HandlerResult{
			RowsAffected: 1,
			Result: map[string]any{
				"run_id":     util.UUIDToString(run.ID),
				"run_status": run.Status,
			},
		}, nil
	}
}

// advanceTriggerDisplay refreshes the display-only next_run_at /
// last_fired_at pair after the given occurrence has been processed —
// dispatched or skipped — so the trigger UI stops showing a "next run"
// that has already fired (MUL-3749). The value stays on the app local
// clock — consistent with the trigger create/update display path — but is
// floored at the plan_time that just fired (see advancedNextRun), so a
// lagging app clock can never recompute the slot we just dispatched.
// Errors are not fatal: the canonical record is autopilot_run.created_at
// and the next dispatch refreshes the value regardless; on a
// cron/timezone parse failure we fall back to the last_fired_at-only
// bump so the fire is still recorded.
func advanceTriggerDisplay(
	ctx context.Context,
	queries *db.Queries,
	trigger db.AutopilotTrigger,
	planTime time.Time,
) {
	tz := DefaultAutopilotScheduleTimezone
	if trigger.Timezone.Valid && trigger.Timezone.String != "" {
		tz = trigger.Timezone.String
	}
	if next, ok := advancedNextRun(trigger.CronExpression.String, tz, planTime, time.Now()); ok {
		_ = queries.AdvanceTriggerNextRun(ctx, db.AdvanceTriggerNextRunParams{
			ID:        trigger.ID,
			NextRunAt: pgtype.Timestamptz{Time: next, Valid: true},
		})
		return
	}
	_ = queries.TouchAutopilotTriggerFiredAt(ctx, trigger.ID)
}

// advancedNextRun computes the display-only next_run_at value to write
// after a schedule trigger fires at planTime. It evaluates the cron on the
// app local clock (`now`, normally time.Now()) but anchors at
// max(now, planTime), so the result is always strictly after the slot that
// just fired — even when this app instance's clock lags the DB clock that
// judged the plan due. Without that floor a sub-second-late local clock
// could recompute the same slot and the next_run_at staleness bug
// (MUL-3749) would reappear at the top-of-period boundary. Returns
// ok=false when the cron/timezone fail to parse, signalling the caller to
// fall back to a last_fired_at-only bump.
func advancedNextRun(cronExpr, timezone string, planTime, now time.Time) (time.Time, bool) {
	anchor := now
	if planTime.After(anchor) {
		anchor = planTime
	}
	next, err := service.NextOccurrenceAfterUTC(cronExpr, timezone, anchor)
	if err != nil {
		return time.Time{}, false
	}
	return next, true
}

// parseScopeUUID converts a scope.ID string back into pgtype.UUID.
// We accept both the standard hyphenated form and the unhyphenated
// raw 32-hex form to keep the contract forgiving.
func parseScopeUUID(s string) (pgtype.UUID, error) {
	var u pgtype.UUID
	if err := u.Scan(s); err != nil {
		return pgtype.UUID{}, err
	}
	if !u.Valid {
		return pgtype.UUID{}, errors.New("invalid uuid")
	}
	return u, nil
}
