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

	send, skipped, partial := planIssueDoneAttachments(nil)
	if len(send) != 0 || len(skipped) != 0 || partial {
		t.Fatalf("empty: send=%d skipped=%d partial=%v", len(send), len(skipped), partial)
	}

	send, skipped, partial = planIssueDoneAttachments([]db.Attachment{png, pdf})
	if len(send) != 2 || len(skipped) != 0 || partial {
		t.Fatalf("image+doc: send=%d skipped=%d partial=%v", len(send), len(skipped), partial)
	}

	send, skipped, partial = planIssueDoneAttachments([]db.Attachment{png, exe})
	if len(send) != 2 || partial || send[0].Filename != "a.png" || send[1].Filename != "c.exe" {
		t.Fatalf("off-list still sends: send=%v skipped=%v partial=%v", send, skipped, partial)
	}

	send, skipped, partial = planIssueDoneAttachments([]db.Attachment{huge, pdf})
	if len(send) != 1 || !partial || send[0].Filename != "b.pdf" {
		t.Fatalf("oversize: send=%v skipped=%v partial=%v", send, skipped, partial)
	}

	var many []db.Attachment
	for i := 0; i < 4; i++ {
		many = append(many, db.Attachment{Filename: "x.png", ContentType: "image/png", SizeBytes: 1})
	}
	send, skipped, partial = planIssueDoneAttachments(many)
	if len(send) != 3 || !partial || len(skipped) != 1 {
		t.Fatalf("cap: send=%d skipped=%d partial=%v", len(send), len(skipped), partial)
	}
}

func TestIssueDoneAttachmentKind(t *testing.T) {
	cases := []struct {
		name, ct, file string
		want           issueDoneKind
	}{
		{"png", "image/png", "a.png", issueDoneKindImage},
		{"jpeg param", "image/jpeg; charset=binary", "a.jpg", issueDoneKindImage},
		{"webp", "image/webp", "a.webp", issueDoneKindImage},
		{"svg is not embeddable", "image/svg+xml", "a.svg", issueDoneKindFile},
		{"pdf", "application/pdf", "a.pdf", issueDoneKindFile},
		{"docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", issueDoneKindFile},
		{"xlsx by ext", "application/octet-stream", "a.xlsx", issueDoneKindFile},
		{"pptx off-list", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "a.pptx", issueDoneKindFile},
		{"xls off-list", "application/vnd.ms-excel", "a.xls", issueDoneKindFile},
		{"txt off-list", "text/plain", "a.txt", issueDoneKindFile},
		{"exe off-list", "application/octet-stream", "a.exe", issueDoneKindFile},
		{"empty", "", "", issueDoneKindFile},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := issueDoneAttachmentKind(db.Attachment{ContentType: tc.ct, Filename: tc.file})
			if got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestIssueDoneSampleFileType(t *testing.T) {
	if got := issueDoneSampleFileType("表格.xlsx", ""); got != "xlsx" {
		t.Fatalf("xlsx = %q", got)
	}
	if got := issueDoneSampleFileType("noext", "application/pdf"); got != "pdf" {
		t.Fatalf("pdf mime = %q", got)
	}
	if got := issueDoneSampleFileType("deck.pptx", ""); got != "pptx" {
		t.Fatalf("off-list ext = %q", got)
	}
	if got := issueDoneSampleFileType("noext", ""); got != "file" {
		t.Fatalf("fallback = %q", got)
	}
}

func TestIssueDoneImageMarkdown(t *testing.T) {
	if got := issueDoneImageMarkdown("@media-1"); got != "![](@media-1)" {
		t.Fatalf("got %q", got)
	}
}

func TestAppendIssueDoneImageMarkdown(t *testing.T) {
	got := appendIssueDoneImageMarkdown("# MARO-1 已完成\n", []string{"@a", "@b"})
	if !strings.Contains(got, "# MARO-1 已完成") || !strings.Contains(got, "![](@a)") || !strings.Contains(got, "![](@b)") {
		t.Fatalf("got %q", got)
	}
	if appendIssueDoneImageMarkdown("body", nil) != "body" {
		t.Fatal("empty media list must keep body")
	}
}

func TestAppendIssueDonePartialNote(t *testing.T) {
	got := appendIssueDonePartialNote("# MARO-1 已完成\n")
	if !strings.HasSuffix(got, issueDonePartialNote) {
		t.Fatalf("got %q", got)
	}
}
