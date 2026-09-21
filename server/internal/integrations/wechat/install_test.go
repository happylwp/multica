package wechat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type fakeWechatInstallQueries struct {
	upsertCalled bool
	upsert       db.UpsertChannelInstallationParams
	rowID        pgtype.UUID
	appIDTaken   bool
	owner        db.GetChannelInstallationOwnerByAppIDRow
	listed       []db.ChannelInstallation
	listParams   db.ListChannelInstallationsByWorkspaceParams
	got          db.ChannelInstallation
	getParams    db.GetChannelInstallationInWorkspaceParams
	getErr       error
	statusParams db.SetChannelInstallationStatusParams
	bound        db.CreateChannelUserBindingParams
}

func (f *fakeWechatInstallQueries) WithTx(pgx.Tx) installQueries { return f }
func (f *fakeWechatInstallQueries) ReclaimDeadChannelInstallationByAppID(context.Context, db.ReclaimDeadChannelInstallationByAppIDParams) (pgtype.UUID, error) {
	return pgtype.UUID{}, pgx.ErrNoRows
}
func (f *fakeWechatInstallQueries) UpsertChannelInstallation(_ context.Context, p db.UpsertChannelInstallationParams) (db.ChannelInstallation, error) {
	f.upsertCalled, f.upsert = true, p
	if f.appIDTaken {
		return db.ChannelInstallation{}, &pgconn.PgError{Code: pgUniqueViolation}
	}
	return db.ChannelInstallation{ID: f.rowID, WorkspaceID: p.WorkspaceID, AgentID: p.AgentID, ChannelType: p.ChannelType, Config: p.Config, InstallerUserID: p.InstallerUserID, Status: "active"}, nil
}
func (f *fakeWechatInstallQueries) GetChannelInstallationOwnerByAppID(context.Context, db.GetChannelInstallationOwnerByAppIDParams) (db.GetChannelInstallationOwnerByAppIDRow, error) {
	return f.owner, nil
}
func (f *fakeWechatInstallQueries) ListChannelInstallationsByWorkspace(_ context.Context, p db.ListChannelInstallationsByWorkspaceParams) ([]db.ChannelInstallation, error) {
	f.listParams = p
	return f.listed, nil
}
func (f *fakeWechatInstallQueries) GetChannelInstallationInWorkspace(_ context.Context, p db.GetChannelInstallationInWorkspaceParams) (db.ChannelInstallation, error) {
	f.getParams = p
	if f.getErr != nil {
		return db.ChannelInstallation{}, f.getErr
	}
	return f.got, nil
}
func (f *fakeWechatInstallQueries) GetChannelInstallation(context.Context, db.GetChannelInstallationParams) (db.ChannelInstallation, error) {
	return f.got, f.getErr
}
func (f *fakeWechatInstallQueries) SetChannelInstallationStatus(_ context.Context, p db.SetChannelInstallationStatusParams) error {
	f.statusParams = p
	return nil
}
func (f *fakeWechatInstallQueries) SetChannelInstallationConfig(context.Context, db.SetChannelInstallationConfigParams) error {
	return nil
}
func (f *fakeWechatInstallQueries) CreateChannelUserBinding(_ context.Context, p db.CreateChannelUserBindingParams) (db.ChannelUserBinding, error) {
	f.bound = p
	return db.ChannelUserBinding{}, nil
}

type fakeWechatTx struct {
	pgx.Tx
	committed bool
}

func (t *fakeWechatTx) Commit(context.Context) error   { t.committed = true; return nil }
func (t *fakeWechatTx) Rollback(context.Context) error { return nil }

type fakeWechatTxStarter struct{ tx *fakeWechatTx }

func (f fakeWechatTxStarter) Begin(context.Context) (pgx.Tx, error) { return f.tx, nil }

func wechatInstallTestBox(t *testing.T) *secretbox.Box {
	t.Helper()
	key := make([]byte, secretbox.KeySize)
	for i := range key {
		key[i] = byte(i + 3)
	}
	box, err := secretbox.New(key)
	if err != nil {
		t.Fatal(err)
	}
	return box
}

func wechatTestUUID(b byte) pgtype.UUID {
	var id pgtype.UUID
	id.Bytes[0] = b
	id.Valid = true
	return id
}

func testLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newWechatInstallTestService(t *testing.T, q installQueries) *InstallService {
	t.Helper()
	svc, err := newInstallService(q, fakeWechatTxStarter{tx: &fakeWechatTx{}}, wechatInstallTestBox(t), NewQuotaStore(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func TestQRConfirmEncryptsTokenAndBindsInstaller(t *testing.T) {
	status := QRStatusWait
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "get_bot_qrcode"):
			_, _ = w.Write([]byte(`{"qrcode":"qr-1","qrcode_img_content":"https://img/q"}`))
		case strings.Contains(r.URL.Path, "get_qrcode_status"):
			if status != QRStatusConfirmed {
				_ = json.NewEncoder(w).Encode(map[string]any{"status": status})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": QRStatusConfirmed, "bot_token": "live-secret",
				"ilink_bot_id": "bot-9", "ilink_user_id": "wxid_me", "nickname": "Ada",
			})
		default:
			t.Fatalf("unexpected %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	q := &fakeWechatInstallQueries{rowID: wechatTestUUID(9)}
	svc := newWechatInstallTestService(t, q)
	svc.api = newILinkClient(srv.URL, "", srv.Client())

	started, err := svc.StartQR(context.Background(), StartQRParams{
		WorkspaceID: wechatTestUUID(1), AgentID: wechatTestUUID(2), InitiatorID: wechatTestUUID(3),
	})
	if err != nil || started.Key != "qr-1" {
		t.Fatalf("start = %+v err=%v", started, err)
	}

	polled, err := svc.PollQR(context.Background(), PollQRParams{WorkspaceID: wechatTestUUID(1), QRCode: started.Key})
	if err != nil || polled.Status != QRStatusWait {
		t.Fatalf("wait = %+v err=%v", polled, err)
	}

	status = QRStatusConfirmed
	polled, err = svc.PollQR(context.Background(), PollQRParams{WorkspaceID: wechatTestUUID(1), QRCode: started.Key})
	if err != nil || polled.Status != QRStatusConfirmed {
		t.Fatalf("confirm = %+v err=%v", polled, err)
	}
	if !q.upsertCalled || q.upsert.ChannelType != channelTypeWechat {
		t.Fatalf("upsert = %+v", q.upsert)
	}
	var cfg installConfig
	if err := json.Unmarshal(q.upsert.Config, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.AppID != "bot-9" || strings.Contains(cfg.BotTokenEncrypted, "live-secret") {
		t.Fatalf("unsafe config = %+v", cfg)
	}
	plain, err := decryptToken(cfg.BotTokenEncrypted, svc.box.Open)
	if err != nil || plain != "live-secret" {
		t.Fatalf("decrypted = %q err=%v", plain, err)
	}
	if q.bound.ChannelUserID != "wxid_me" || q.bound.MulticaUserID != wechatTestUUID(3) {
		t.Fatalf("auto-bind = %+v", q.bound)
	}
	if _, err := svc.PollQR(context.Background(), PollQRParams{WorkspaceID: wechatTestUUID(1), QRCode: started.Key}); !errors.Is(err, ErrQRSessionUnknown) {
		t.Fatalf("consumed qr still live: %v", err)
	}
}

func TestPollQRRejectsForeignWorkspace(t *testing.T) {
	q := &fakeWechatInstallQueries{}
	svc := newWechatInstallTestService(t, q)
	svc.pending["qr"] = pendingQR{WorkspaceID: wechatTestUUID(1), CreatedAt: time.Now()}
	_, err := svc.PollQR(context.Background(), PollQRParams{WorkspaceID: wechatTestUUID(2), QRCode: "qr"})
	if !errors.Is(err, ErrQRNotInWorkspace) {
		t.Fatalf("err = %v", err)
	}
}

func TestInstallationManagementStaysWorkspaceScoped(t *testing.T) {
	q := &fakeWechatInstallQueries{
		listed: []db.ChannelInstallation{{ID: wechatTestUUID(9)}},
		got:    db.ChannelInstallation{ID: wechatTestUUID(8)},
	}
	svc := newWechatInstallTestService(t, q)
	rows, err := svc.ListByWorkspace(context.Background(), wechatTestUUID(1))
	if err != nil || len(rows) != 1 || q.listParams.ChannelType != channelTypeWechat {
		t.Fatalf("list = %+v err=%v params=%+v", rows, err, q.listParams)
	}
	if err := svc.Revoke(context.Background(), wechatTestUUID(8)); err != nil || q.statusParams.Status != "revoked" {
		t.Fatalf("revoke = %+v err=%v", q.statusParams, err)
	}
}

func TestPublicConfigOmitsSecrets(t *testing.T) {
	raw, _ := json.Marshal(installConfig{
		AppID: "bot", Nickname: "Ada", ILinkUserID: "wx",
		BotTokenEncrypted: "ciphertext-sentinel",
		Sessions:          map[string]persistedSession{"wx": {ContextTokenEncrypted: "tok-sentinel"}},
	})
	pub := DecodePublicConfig(raw)
	if pub.BotID != "bot" || pub.Nickname != "Ada" {
		t.Fatalf("pub = %+v", pub)
	}
	b, _ := json.Marshal(pub)
	if strings.Contains(string(b), "sentinel") || strings.Contains(string(b), "token") {
		t.Fatalf("leaked: %s", b)
	}
}
