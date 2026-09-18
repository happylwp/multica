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
	if len(send) != 1 || !partial || send[0].Filename != "a.png" || len(skipped) != 1 || skipped[0].Filename != "c.exe" {
		t.Fatalf("unsupported: send=%v skipped=%v partial=%v", send, skipped, partial)
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
		{"svg blocked", "image/svg+xml", "a.svg", issueDoneKindSkip},
		{"pdf", "application/pdf", "a.pdf", issueDoneKindFile},
		{"docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", issueDoneKindFile},
		{"xlsx by ext", "application/octet-stream", "a.xlsx", issueDoneKindFile},
		{"pptx not in sampleFile list", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "a.pptx", issueDoneKindSkip},
		{"xls not in sampleFile list", "application/vnd.ms-excel", "a.xls", issueDoneKindSkip},
		{"txt", "text/plain", "a.txt", issueDoneKindSkip},
		{"exe", "application/octet-stream", "a.exe", issueDoneKindSkip},
		{"empty", "", "", issueDoneKindSkip},
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
	if got, ok := issueDoneSampleFileType("表格.xlsx", ""); !ok || got != "xlsx" {
		t.Fatalf("xlsx = %q ok=%v", got, ok)
	}
	if got, ok := issueDoneSampleFileType("noext", "application/pdf"); !ok || got != "pdf" {
		t.Fatalf("pdf mime = %q ok=%v", got, ok)
	}
	if _, ok := issueDoneSampleFileType("shot.png", "image/png"); ok {
		t.Fatal("png must not use sampleFile")
	}
	if _, ok := issueDoneSampleFileType("deck.pptx", ""); ok {
		t.Fatal("pptx is outside the official sampleFile list")
	}
}

func TestIssueDoneImageMarkdown(t *testing.T) {
	if got := issueDoneImageMarkdown("@media-1"); got != "![图片](@media-1)" {
		t.Fatalf("got %q", got)
	}
}

func TestAppendIssueDonePartialNote(t *testing.T) {
	got := appendIssueDonePartialNote("# MARO-1 已完成\n")
	if !strings.HasSuffix(got, issueDonePartialNote) {
		t.Fatalf("got %q", got)
	}
}
