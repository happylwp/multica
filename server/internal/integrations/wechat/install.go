package wechat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	qrSessionTTL            = 5 * time.Minute
	pgUniqueViolation       = "23505"
	credentialVerifyTimeout = 15 * time.Second
)

var (
	ErrInstallationNotFound           = errors.New("wechat installation not found")
	ErrQRSessionUnknown               = errors.New("wechat: qr session unknown or expired")
	ErrQRNotInWorkspace               = errors.New("wechat: qr session does not belong to this workspace")
	ErrAccountOwnedByAnotherWorkspace = errors.New("wechat: this WeChat account is already connected to a different Multica workspace")
	ErrAccountOwnedBySameWorkspace    = errors.New("wechat: this WeChat account is already connected to another agent in this workspace")
	ErrAccountOwnedByArchivedAgent    = errors.New("wechat: this WeChat account is connected to an archived agent in this workspace")
	ErrQRUnreachable                  = errors.New("wechat: could not reach iLink")
)

type installQueries interface {
	WithTx(tx pgx.Tx) installQueries
	UpsertChannelInstallation(ctx context.Context, arg db.UpsertChannelInstallationParams) (db.ChannelInstallation, error)
	ReclaimDeadChannelInstallationByAppID(ctx context.Context, arg db.ReclaimDeadChannelInstallationByAppIDParams) (pgtype.UUID, error)
	GetChannelInstallationOwnerByAppID(ctx context.Context, arg db.GetChannelInstallationOwnerByAppIDParams) (db.GetChannelInstallationOwnerByAppIDRow, error)
	ListChannelInstallationsByWorkspace(ctx context.Context, arg db.ListChannelInstallationsByWorkspaceParams) ([]db.ChannelInstallation, error)
	GetChannelInstallationInWorkspace(ctx context.Context, arg db.GetChannelInstallationInWorkspaceParams) (db.ChannelInstallation, error)
	GetChannelInstallation(ctx context.Context, arg db.GetChannelInstallationParams) (db.ChannelInstallation, error)
	SetChannelInstallationStatus(ctx context.Context, arg db.SetChannelInstallationStatusParams) error
	SetChannelInstallationConfig(ctx context.Context, arg db.SetChannelInstallationConfigParams) error
	CreateChannelUserBinding(ctx context.Context, arg db.CreateChannelUserBindingParams) (db.ChannelUserBinding, error)
}

type dbInstallQueries struct{ *db.Queries }

func (q dbInstallQueries) WithTx(tx pgx.Tx) installQueries {
	return dbInstallQueries{q.Queries.WithTx(tx)}
}

type pendingQR struct {
	WorkspaceID pgtype.UUID
	AgentID     pgtype.UUID
	InitiatorID pgtype.UUID
	CreatedAt   time.Time
}

// InstallService owns QR login, at-rest encryption of the bot token, and
// the list / get / revoke management surface.
type InstallService struct {
	box    *secretbox.Box
	q      installQueries
	tx     engine.TxStarter
	quota  *QuotaStore
	logger *slog.Logger
	client *http.Client
	api    *iLinkClient

	mu      sync.Mutex
	pending map[string]pendingQR
	cfgMu   sync.Mutex
}

// NewInstallService binds queries, a tx starter, encryption, and the shared
// quota store. The box MUST be non-nil.
func NewInstallService(q *db.Queries, tx engine.TxStarter, box *secretbox.Box, quota *QuotaStore, logger *slog.Logger) (*InstallService, error) {
	if q == nil {
		return nil, errors.New("wechat: InstallService requires queries")
	}
	return newInstallService(dbInstallQueries{q}, tx, box, quota, logger)
}

func newInstallService(q installQueries, tx engine.TxStarter, box *secretbox.Box, quota *QuotaStore, logger *slog.Logger) (*InstallService, error) {
	if box == nil {
		return nil, errors.New("wechat: InstallService requires a non-nil secretbox.Box")
	}
	if q == nil {
		return nil, errors.New("wechat: InstallService requires queries")
	}
	if tx == nil {
		return nil, errors.New("wechat: InstallService requires a tx starter")
	}
	if quota == nil {
		quota = NewQuotaStore()
	}
	if logger == nil {
		logger = slog.Default()
	}
	httpClient := &http.Client{Timeout: credentialVerifyTimeout}
	return &InstallService{
		box:     box,
		q:       q,
		tx:      tx,
		quota:   quota,
		logger:  logger,
		client:  httpClient,
		api:     newILinkClient("", "", httpClient),
		pending: make(map[string]pendingQR),
	}, nil
}

// Quota returns the shared store so list responses can surface remaining
// allowance without a second construction.
func (s *InstallService) Quota() *QuotaStore { return s.quota }

// StartQRParams are the inputs for a QR login session.
type StartQRParams struct {
	WorkspaceID pgtype.UUID
	AgentID     pgtype.UUID
	InitiatorID pgtype.UUID
}

// StartedQR is returned once to the installer. ImageURL is the QR to render.
type StartedQR struct {
	Key       string
	ImageURL  string
	ExpiresIn int
}

// StartQR asks iLink for a login QR and remembers the Multica identity that
// started it so a later confirm can persist + auto-bind.
func (s *InstallService) StartQR(ctx context.Context, p StartQRParams) (StartedQR, error) {
	qr, err := s.api.GetBotQRCode(ctx)
	if err != nil {
		return StartedQR{}, fmt.Errorf("%w: %v", ErrQRUnreachable, err)
	}
	s.mu.Lock()
	s.sweepPendingLocked(time.Now())
	s.pending[qr.Key] = pendingQR{
		WorkspaceID: p.WorkspaceID,
		AgentID:     p.AgentID,
		InitiatorID: p.InitiatorID,
		CreatedAt:   time.Now(),
	}
	s.mu.Unlock()
	return StartedQR{Key: qr.Key, ImageURL: qr.ImageURL, ExpiresIn: int(qrSessionTTL.Seconds())}, nil
}

// PollQRParams identify the session the installer is watching.
type PollQRParams struct {
	WorkspaceID pgtype.UUID
	QRCode      string
	VerifyCode  string
}

// PolledQR is one status snapshot. Installation is set only on confirmed.
type PolledQR struct {
	Status       string
	Installation db.ChannelInstallation
}

// PollQR asks iLink for the current scan state. On confirmed it encrypts the
// bot token, upserts the installation, and binds the initiator to the
// scanned WeChat user id.
func (s *InstallService) PollQR(ctx context.Context, p PollQRParams) (PolledQR, error) {
	s.mu.Lock()
	s.sweepPendingLocked(time.Now())
	pending, ok := s.pending[p.QRCode]
	s.mu.Unlock()
	if !ok {
		return PolledQR{}, ErrQRSessionUnknown
	}
	if pending.WorkspaceID != p.WorkspaceID {
		return PolledQR{}, ErrQRNotInWorkspace
	}

	st, err := s.api.GetQRCodeStatus(ctx, p.QRCode, p.VerifyCode)
	if err != nil {
		return PolledQR{}, fmt.Errorf("%w: %v", ErrQRUnreachable, err)
	}
	out := PolledQR{Status: st.Status}
	if st.Status != QRStatusConfirmed {
		if st.Status == QRStatusExpired {
			s.mu.Lock()
			delete(s.pending, p.QRCode)
			s.mu.Unlock()
		}
		return out, nil
	}

	inst, err := s.persistConfirmed(ctx, pending, st)
	if err != nil {
		return PolledQR{}, err
	}
	s.mu.Lock()
	delete(s.pending, p.QRCode)
	s.mu.Unlock()
	out.Installation = inst
	return out, nil
}

func (s *InstallService) persistConfirmed(ctx context.Context, pending pendingQR, st QRStatus) (db.ChannelInstallation, error) {
	if st.BotID == "" || st.Token == "" {
		return db.ChannelInstallation{}, errors.New("wechat: confirmed QR missing bot identity")
	}
	sealed, err := s.box.Seal([]byte(st.Token))
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("encrypt wechat bot token: %w", err)
	}
	cfgJSON, err := json.Marshal(installConfig{
		AppID:             st.BotID,
		Nickname:          st.Nickname,
		ILinkUserID:       st.UserID,
		BotTokenEncrypted: base64.StdEncoding.EncodeToString(sealed),
		BaseURL:           st.BaseURL,
		Sessions:          map[string]persistedSession{},
	})
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("encode wechat installation config: %w", err)
	}

	tx, err := s.tx.Begin(ctx)
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("begin wechat install tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := s.q.WithTx(tx)

	if _, err := qtx.ReclaimDeadChannelInstallationByAppID(ctx, db.ReclaimDeadChannelInstallationByAppIDParams{
		ChannelType: channelTypeWechat,
		AppID:       st.BotID,
		WorkspaceID: pending.WorkspaceID,
		AgentID:     pending.AgentID,
	}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return db.ChannelInstallation{}, fmt.Errorf("reclaim dead wechat installation: %w", err)
	}

	inst, err := qtx.UpsertChannelInstallation(ctx, db.UpsertChannelInstallationParams{
		WorkspaceID:     pending.WorkspaceID,
		AgentID:         pending.AgentID,
		ChannelType:     channelTypeWechat,
		Config:          cfgJSON,
		InstallerUserID: pending.InitiatorID,
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			return db.ChannelInstallation{}, s.liveOwnerConflictErr(ctx, pending.WorkspaceID, st.BotID)
		}
		return db.ChannelInstallation{}, fmt.Errorf("upsert wechat installation: %w", err)
	}

	if st.UserID != "" && pending.InitiatorID.Valid {
		if _, err := qtx.CreateChannelUserBinding(ctx, db.CreateChannelUserBindingParams{
			WorkspaceID:    pending.WorkspaceID,
			MulticaUserID:  pending.InitiatorID,
			InstallationID: inst.ID,
			ChannelType:    channelTypeWechat,
			ChannelUserID:  st.UserID,
			Config:         []byte(`{}`),
		}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			// Already bound to this initiator is fine; a cross-user steal
			// returns ErrNoRows from the gated upsert.
			s.logger.WarnContext(ctx, "wechat: auto-bind installer failed", "error", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("commit wechat install: %w", err)
	}
	return inst, nil
}

func (s *InstallService) liveOwnerConflictErr(ctx context.Context, requestingWorkspaceID pgtype.UUID, appID string) error {
	owner, err := s.q.GetChannelInstallationOwnerByAppID(ctx, db.GetChannelInstallationOwnerByAppIDParams{
		ChannelType: channelTypeWechat,
		AppID:       appID,
	})
	if err != nil {
		return ErrAccountOwnedByAnotherWorkspace
	}
	switch {
	case owner.WorkspaceID != requestingWorkspaceID:
		return ErrAccountOwnedByAnotherWorkspace
	case owner.AgentArchivedAt.Valid:
		return ErrAccountOwnedByArchivedAgent
	default:
		return ErrAccountOwnedBySameWorkspace
	}
}

func (s *InstallService) sweepPendingLocked(now time.Time) {
	for k, p := range s.pending {
		if now.Sub(p.CreatedAt) > qrSessionTTL {
			delete(s.pending, k)
		}
	}
}

// ListByWorkspace returns every WeChat installation in the workspace.
func (s *InstallService) ListByWorkspace(ctx context.Context, wsID pgtype.UUID) ([]db.ChannelInstallation, error) {
	return s.q.ListChannelInstallationsByWorkspace(ctx, db.ListChannelInstallationsByWorkspaceParams{
		WorkspaceID: wsID,
		ChannelType: channelTypeWechat,
	})
}

// GetInWorkspace is workspace-scoped so a forged id cannot leak existence.
func (s *InstallService) GetInWorkspace(ctx context.Context, id, wsID pgtype.UUID) (db.ChannelInstallation, error) {
	inst, err := s.q.GetChannelInstallationInWorkspace(ctx, db.GetChannelInstallationInWorkspaceParams{
		ID:          id,
		WorkspaceID: wsID,
		ChannelType: channelTypeWechat,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.ChannelInstallation{}, ErrInstallationNotFound
		}
		return db.ChannelInstallation{}, err
	}
	return inst, nil
}

// Revoke flips status to revoked. The Supervisor drops the polling loop.
func (s *InstallService) Revoke(ctx context.Context, id pgtype.UUID) error {
	return s.q.SetChannelInstallationStatus(ctx, db.SetChannelInstallationStatusParams{
		ID:     id,
		Status: "revoked",
	})
}

// UpdateConfig is the serialized read-modify-write used to persist the
// getupdates cursor and per-conversation quota snapshot. The mutator must
// not log secrets from cfg.
func (s *InstallService) UpdateConfig(ctx context.Context, id pgtype.UUID, fn func(*installConfig) error) error {
	if !id.Valid {
		return errors.New("wechat: installation id required")
	}
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	row, err := s.q.GetChannelInstallation(ctx, db.GetChannelInstallationParams{
		ID:          id,
		ChannelType: channelTypeWechat,
	})
	if err != nil {
		return err
	}
	cfg, err := decodeInstallConfig(row.Config)
	if err != nil {
		return err
	}
	if err := fn(&cfg); err != nil {
		return err
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	return s.q.SetChannelInstallationConfig(ctx, db.SetChannelInstallationConfigParams{
		ID:     id,
		Config: raw,
	})
}

// QuotaView is the display-safe remaining-allowance snapshot for one
// installation's primary WeChat user (the account that scanned).
type QuotaView struct {
	Remaining       int
	WindowValid     bool
	WindowExpiresAt time.Time
	LastInboundAt   time.Time
}

// QuotaFor returns the primary conversation's quota. Falls back to the
// persisted sessions map when the process store is empty (just after boot,
// before Connect hydrates).
func (s *InstallService) QuotaFor(row db.ChannelInstallation, now time.Time) QuotaView {
	cfg, err := decodeInstallConfig(row.Config)
	if err != nil {
		return QuotaView{}
	}
	userID := cfg.ILinkUserID
	instID := util.UUIDToString(row.ID)
	budget := s.quota.Snapshot(instID, userID)
	if budget.LastInbound.IsZero() && cfg.Sessions != nil {
		if sess, ok := cfg.Sessions[userID]; ok {
			budget = SessionBudget{LastInbound: sess.LastInboundAt, Outbound: sess.OutboundAt}
		}
	}
	return QuotaView{
		Remaining:       budget.Remaining(now),
		WindowValid:     budget.WindowValid(now),
		WindowExpiresAt: budget.WindowExpiry(),
		LastInboundAt:   budget.LastInbound,
	}
}

func persistSessions(ctx context.Context, p interface {
	UpdateConfig(context.Context, pgtype.UUID, func(*installConfig) error) error
}, encrypt Encrypter, instID pgtype.UUID, quota *QuotaStore, cursor string) error {
	if p == nil || !instID.Valid {
		return nil
	}
	inst := util.UUIDToString(instID)
	snaps := quota.Export(inst)
	return p.UpdateConfig(ctx, instID, func(cfg *installConfig) error {
		if cursor != "" {
			cfg.GetUpdatesBuf = cursor
		}
		cfg.Sessions = make(map[string]persistedSession, len(snaps))
		for user, live := range snaps {
			enc, err := encryptToken(live.token, encrypt)
			if err != nil {
				return err
			}
			cfg.Sessions[user] = persistedSession{
				ContextTokenEncrypted: enc,
				LastInboundAt:         live.budget.LastInbound,
				OutboundAt:            live.budget.Outbound,
			}
		}
		return nil
	})
}

// hydrateQuota seeds the process store from a persisted snapshot. Only the
// Factory / restart path should call this; outbound Send must not, or a
// stale DB row would roll back a live token and quota count.
func hydrateQuota(quota *QuotaStore, instID string, cfg installConfig, decrypt Decrypter) {
	if quota == nil || instID == "" || cfg.Sessions == nil {
		return
	}
	for user, sess := range cfg.Sessions {
		token, err := decryptToken(sess.ContextTokenEncrypted, decrypt)
		if err != nil {
			continue
		}
		quota.Hydrate(instID, user, token, SessionBudget{
			LastInbound: sess.LastInboundAt,
			Outbound:    sess.OutboundAt,
		})
	}
}
