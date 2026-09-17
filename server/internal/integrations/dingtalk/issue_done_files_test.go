package dingtalk

import (
	"strings"
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestPlanIssueDoneAttachments(t *testing.T) {
	png := db.Attachment{Filename: "a.png", ContentType: "image/png", SizeBytes: 10}
	pdf := db.Attachment{Filename: "b.pdf", ContentType: "application/pdf", SizeBytes: 20}
	exe := db.Attachment{Filename: "c.exe", ContentType: "application/octet-stream", SizeBytes: 5}
	huge := db.Attachment{Filename: "d.pdf", ContentType: "application/pdf", SizeBytes: issueDoneMaxFileBytes + 1}

	send, partial := planIssueDoneAttachments(nil)
	if len(send) != 0 || partial {
		t.Fatalf("empty: send=%d partial=%v", len(send), partial)
	}

	send, partial = planIssueDoneAttachments([]db.Attachment{png, pdf})
	if len(send) != 2 || partial {
		t.Fatalf("image+doc: send=%d partial=%v", len(send), partial)
	}

	send, partial = planIssueDoneAttachments([]db.Attachment{png, exe})
	if len(send) != 1 || !partial || send[0].Filename != "a.png" {
		t.Fatalf("unsupported: send=%v partial=%v", send, partial)
	}

	send, partial = planIssueDoneAttachments([]db.Attachment{huge, pdf})
	if len(send) != 1 || !partial || send[0].Filename != "b.pdf" {
		t.Fatalf("oversize: send=%v partial=%v", send, partial)
	}

	var many []db.Attachment
	for i := 0; i < 4; i++ {
		many = append(many, db.Attachment{Filename: "x.png", ContentType: "image/png", SizeBytes: 1})
	}
	send, partial = planIssueDoneAttachments(many)
	if len(send) != 3 || !partial {
		t.Fatalf("cap: send=%d partial=%v", len(send), partial)
	}
}

func TestIssueDoneForwardable(t *testing.T) {
	cases := []struct {
		name, ct, file string
		want           bool
	}{
		{"png", "image/png", "a.png", true},
		{"jpeg param", "image/jpeg; charset=binary", "a.jpg", true},
		{"svg blocked", "image/svg+xml", "a.svg", false},
		{"pdf", "application/pdf", "a.pdf", true},
		{"docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", true},
		{"xlsx by ext", "application/octet-stream", "a.xlsx", true},
		{"exe", "application/octet-stream", "a.exe", false},
		{"empty", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := issueDoneForwardable(db.Attachment{ContentType: tc.ct, Filename: tc.file})
			if got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestIssueDoneFileType(t *testing.T) {
	if got := issueDoneFileType("表格.xlsx", ""); got != "xlsx" {
		t.Fatalf("ext = %q", got)
	}
	if got := issueDoneFileType("shot.jpeg", "image/jpeg"); got != "jpg" {
		t.Fatalf("jpeg = %q", got)
	}
	if got := issueDoneFileType("noext", "application/pdf"); got != "pdf" {
		t.Fatalf("mime = %q", got)
	}
}

func TestAppendIssueDonePartialNote(t *testing.T) {
	got := appendIssueDonePartialNote("# MARO-1 已完成\n")
	if !strings.HasSuffix(got, issueDonePartialNote) {
		t.Fatalf("got %q", got)
	}
}
