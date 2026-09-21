package wechat

import (
	"errors"
	"sort"
	"sync"
	"time"
)

// Official iLink hard limits. A conversation whose user has not messaged
// the bot in 24h has an expired context_token — proactive push is refused.
// After a user message, the bot may send at most 10 independent messages
// in any rolling 24h window. These are the documented ceilings themselves.
const (
	SessionWindow        = 24 * time.Hour
	MaxOutboundPerWindow = 10
	sessionWindow        = SessionWindow
	maxOutboundPerWindow = MaxOutboundPerWindow
)

var (
	// ErrWindowExpired: no inbound inside the 24h session window. The
	// context_token must not be used to push.
	ErrWindowExpired = errors.New("wechat: 24h session window expired")
	// ErrQuotaExceeded: the rolling 24h outbound allowance is spent.
	ErrQuotaExceeded = errors.New("wechat: outbound quota exceeded")
)

// SessionBudget is the pure quota state for one WeChat conversation.
// Methods return copies so tests can assert without sharing memory.
type SessionBudget struct {
	LastInbound time.Time
	Outbound    []time.Time
}

// WindowValid reports whether a user inbound still keeps the session open.
func (s SessionBudget) WindowValid(now time.Time) bool {
	return !s.LastInbound.IsZero() && !now.Before(s.LastInbound) && now.Sub(s.LastInbound) <= sessionWindow
}

// WindowExpiry is when the current inbound window closes. Zero if none.
func (s SessionBudget) WindowExpiry() time.Time {
	if s.LastInbound.IsZero() {
		return time.Time{}
	}
	return s.LastInbound.Add(sessionWindow)
}

// Remaining is how many independent outbound messages may still be sent.
func (s SessionBudget) Remaining(now time.Time) int {
	if !s.WindowValid(now) {
		return 0
	}
	n := 0
	cutoff := now.Add(-sessionWindow)
	for _, t := range s.Outbound {
		if t.After(cutoff) {
			n++
		}
	}
	left := maxOutboundPerWindow - n
	if left < 0 {
		return 0
	}
	return left
}

// NoteInbound records a user message and opens / refreshes the 24h window.
func (s SessionBudget) NoteInbound(at time.Time) SessionBudget {
	s.LastInbound = at
	s.Outbound = trimOutbound(s.Outbound, at.Add(-sessionWindow))
	return s
}

// Reserve admits n outbound sends at now. reserved is how many were taken
// (may be less than n when the allowance is short). A window miss returns
// ErrWindowExpired and reserved=0. A fully spent quota returns
// ErrQuotaExceeded and reserved=0. A partial admit returns ErrQuotaExceeded
// with reserved>0 so the caller can merge / drop the remainder.
func (s SessionBudget) Reserve(now time.Time, n int) (SessionBudget, int, error) {
	if n <= 0 {
		return s, 0, nil
	}
	if !s.WindowValid(now) {
		return s, 0, ErrWindowExpired
	}
	left := s.Remaining(now)
	if left <= 0 {
		return s, 0, ErrQuotaExceeded
	}
	take := n
	var err error
	if take > left {
		take = left
		err = ErrQuotaExceeded
	}
	out := append(trimOutbound(s.Outbound, now.Add(-sessionWindow)), timesOf(now, take)...)
	s.Outbound = out
	return s, take, err
}

func timesOf(at time.Time, n int) []time.Time {
	out := make([]time.Time, n)
	for i := range out {
		out[i] = at
	}
	return out
}

func trimOutbound(sent []time.Time, cutoff time.Time) []time.Time {
	if len(sent) == 0 {
		return nil
	}
	i := sort.Search(len(sent), func(i int) bool { return sent[i].After(cutoff) })
	if i == 0 {
		return append([]time.Time(nil), sent...)
	}
	if i >= len(sent) {
		return nil
	}
	return append([]time.Time(nil), sent[i:]...)
}

// liveSession is the in-process conversation state: budget plus the
// context_token required to reply. The token is never logged.
type liveSession struct {
	budget SessionBudget
	token  string
}

type storeKey struct {
	inst string
	user string
}

// QuotaStore is the process-wide, concurrent-safe quota + token map.
// One instance is shared by the Channel receive loop, outbound delivery,
// the replier, and issue-done notify so they draw on the same allowance.
type QuotaStore struct {
	mu       sync.Mutex
	sessions map[storeKey]*liveSession
}

// NewQuotaStore constructs an empty store.
func NewQuotaStore() *QuotaStore {
	return &QuotaStore{sessions: make(map[storeKey]*liveSession)}
}

func (s *QuotaStore) key(instID, userID string) storeKey {
	return storeKey{inst: instID, user: userID}
}

func (s *QuotaStore) getLocked(instID, userID string) *liveSession {
	if s.sessions == nil {
		s.sessions = make(map[storeKey]*liveSession)
	}
	k := s.key(instID, userID)
	live := s.sessions[k]
	if live == nil {
		live = &liveSession{}
		s.sessions[k] = live
	}
	return live
}

// NoteInbound records a user message and stores the latest context_token.
func (s *QuotaStore) NoteInbound(instID, userID, token string, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	live := s.getLocked(instID, userID)
	live.budget = live.budget.NoteInbound(at)
	if token != "" {
		live.token = token
	}
}

// Hydrate restores a persisted session (restart / factory build).
func (s *QuotaStore) Hydrate(instID, userID, token string, budget SessionBudget) {
	s.mu.Lock()
	defer s.mu.Unlock()
	live := s.getLocked(instID, userID)
	live.budget = budget
	live.budget.Outbound = trimOutbound(budget.Outbound, time.Now().Add(-sessionWindow))
	if token != "" {
		live.token = token
	}
}

// Token returns the current context_token, if any. Callers must not log it.
func (s *QuotaStore) Token(instID, userID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	live := s.sessions[s.key(instID, userID)]
	if live == nil || live.token == "" {
		return "", false
	}
	return live.token, true
}

// Snapshot copies one conversation's budget.
func (s *QuotaStore) Snapshot(instID, userID string) SessionBudget {
	s.mu.Lock()
	defer s.mu.Unlock()
	live := s.sessions[s.key(instID, userID)]
	if live == nil {
		return SessionBudget{}
	}
	return SessionBudget{
		LastInbound: live.budget.LastInbound,
		Outbound:    append([]time.Time(nil), live.budget.Outbound...),
	}
}

// Export copies every conversation for one installation (persist path).
func (s *QuotaStore) Export(instID string) map[string]liveSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]liveSession)
	for k, live := range s.sessions {
		if k.inst != instID || live == nil {
			continue
		}
		out[k.user] = liveSession{
			budget: SessionBudget{
				LastInbound: live.budget.LastInbound,
				Outbound:    append([]time.Time(nil), live.budget.Outbound...),
			},
			token: live.token,
		}
	}
	return out
}

// TryReserve admits n outbound sends. See SessionBudget.Reserve.
func (s *QuotaStore) TryReserve(instID, userID string, now time.Time, n int) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	live := s.getLocked(instID, userID)
	next, reserved, err := live.budget.Reserve(now, n)
	live.budget = next
	return reserved, err
}

// Remaining is the current unused allowance.
func (s *QuotaStore) Remaining(instID, userID string, now time.Time) int {
	return s.Snapshot(instID, userID).Remaining(now)
}

// WindowValid reports whether proactive / reply send is allowed.
func (s *QuotaStore) WindowValid(instID, userID string, now time.Time) bool {
	return s.Snapshot(instID, userID).WindowValid(now)
}
