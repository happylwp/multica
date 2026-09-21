package wechat

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestSessionBudgetWindow(t *testing.T) {
	now := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
	var b SessionBudget
	if b.WindowValid(now) || b.Remaining(now) != 0 {
		t.Fatal("empty budget must have a closed window")
	}
	b = b.NoteInbound(now)
	if !b.WindowValid(now) || b.Remaining(now) != MaxOutboundPerWindow {
		t.Fatalf("just after inbound: valid=%v remaining=%d", b.WindowValid(now), b.Remaining(now))
	}
	if b.WindowValid(now.Add(SessionWindow + time.Second)) {
		t.Fatal("window must expire after 24h without inbound")
	}
	if b.Remaining(now.Add(SessionWindow+time.Second)) != 0 {
		t.Fatal("expired window has zero remaining")
	}
}

func TestSessionBudgetReserveAndRollingWindow(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	b := SessionBudget{}.NoteInbound(now)

	b, n, err := b.Reserve(now, 3)
	if err != nil || n != 3 || b.Remaining(now) != 7 {
		t.Fatalf("reserve 3: n=%d rem=%d err=%v", n, b.Remaining(now), err)
	}

	b, n, err = b.Reserve(now, 10)
	if !errors.Is(err, ErrQuotaExceeded) || n != 7 || b.Remaining(now) != 0 {
		t.Fatalf("partial reserve: n=%d rem=%d err=%v", n, b.Remaining(now), err)
	}

	b, n, err = b.Reserve(now, 1)
	if !errors.Is(err, ErrQuotaExceeded) || n != 0 {
		t.Fatalf("spent quota: n=%d err=%v", n, err)
	}

	// A send from 25h ago must age out of the rolling window, but the window
	// itself is still keyed off last inbound — refresh inbound first.
	old := now.Add(-25 * time.Hour)
	aged := SessionBudget{LastInbound: now, Outbound: []time.Time{old, now}}.Remaining(now)
	if aged != MaxOutboundPerWindow-1 {
		t.Fatalf("aged outbound should not count, remaining=%d", aged)
	}
}

func TestSessionBudgetReserveRequiresWindow(t *testing.T) {
	now := time.Now()
	b := SessionBudget{LastInbound: now.Add(-25 * time.Hour)}
	_, n, err := b.Reserve(now, 1)
	if !errors.Is(err, ErrWindowExpired) || n != 0 {
		t.Fatalf("expired window: n=%d err=%v", n, err)
	}
}

func TestQuotaStoreConcurrentReserve(t *testing.T) {
	s := NewQuotaStore()
	now := time.Now()
	s.NoteInbound("inst", "user", "tok", now)

	var wg sync.WaitGroup
	var mu sync.Mutex
	got := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n, _ := s.TryReserve("inst", "user", now, 1)
			mu.Lock()
			got += n
			mu.Unlock()
		}()
	}
	wg.Wait()
	if got != MaxOutboundPerWindow {
		t.Fatalf("concurrent reserve admitted %d, want %d", got, MaxOutboundPerWindow)
	}
	if s.Remaining("inst", "user", now) != 0 {
		t.Fatalf("remaining after burst = %d", s.Remaining("inst", "user", now))
	}
	tok, ok := s.Token("inst", "user")
	if !ok || tok != "tok" {
		t.Fatal("context token must survive quota updates")
	}
}

func TestQuotaStoreDoesNotBypassExpiredWindow(t *testing.T) {
	s := NewQuotaStore()
	past := time.Now().Add(-25 * time.Hour)
	s.Hydrate("inst", "user", "stale-token", SessionBudget{LastInbound: past})
	if s.WindowValid("inst", "user", time.Now()) {
		t.Fatal("hydrated expired session must not be sendable")
	}
	n, err := s.TryReserve("inst", "user", time.Now(), 1)
	if !errors.Is(err, ErrWindowExpired) || n != 0 {
		t.Fatalf("reserve on expired hydrate: n=%d err=%v", n, err)
	}
}
