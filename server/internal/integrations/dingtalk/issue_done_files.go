package dingtalk

import (
	"context"
	"fmt"
	"io"
	"path"
	"strings"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type issueDoneResult struct {
	summary string
	files   []db.Attachment
	partial bool
}

type issueDoneKind int

const (
	issueDoneKindSkip issueDoneKind = iota
	issueDoneKindImage
	issueDoneKindFile
)

func appendIssueDonePartialNote(body string) string {
	body = strings.TrimRight(body, "\n")
	return body + "\n\n" + issueDonePartialNote
}

func issueDoneImageMarkdown(mediaID string) string {
	return "![图片](" + mediaID + ")"
}

// planIssueDoneAttachments keeps images and official sampleFile documents,
// drops oversize / unsupported files, and caps the send list. skipped rows
// are returned so the caller can warn without blocking the text push.
func planIssueDoneAttachments(rows []db.Attachment) (send, skipped []db.Attachment, partial bool) {
	var eligible []db.Attachment
	for _, row := range rows {
		if issueDoneAttachmentKind(row) == issueDoneKindSkip || row.SizeBytes > issueDoneMaxFileBytes {
			skipped = append(skipped, row)
			partial = true
			continue
		}
		eligible = append(eligible, row)
	}
	if len(eligible) > issueDoneMaxFiles {
		partial = true
		skipped = append(skipped, eligible[issueDoneMaxFiles:]...)
		eligible = eligible[:issueDoneMaxFiles]
	}
	return eligible, skipped, partial
}

func issueDoneAttachmentKind(row db.Attachment) issueDoneKind {
	if issueDoneIsImage(row) {
		return issueDoneKindImage
	}
	if _, ok := issueDoneSampleFileType(row.Filename, row.ContentType); ok {
		return issueDoneKindFile
	}
	return issueDoneKindSkip
}

func issueDoneIsImage(row db.Attachment) bool {
	ct := normalizeIssueDoneMediaType(row.ContentType)
	if ct == "image/svg+xml" {
		return false
	}
	if strings.HasPrefix(ct, "image/") {
		return true
	}
	switch issueDoneExt(row.Filename) {
	case "png", "jpg", "jpeg", "gif", "webp", "bmp":
		return true
	}
	return false
}

// issueDoneSampleFileType maps an attachment to DingTalk sampleFile's fileType.
// Official template only accepts xlsx/pdf/zip/rar/doc/docx.
func issueDoneSampleFileType(filename, contentType string) (string, bool) {
	switch issueDoneExt(filename) {
	case "xlsx", "pdf", "zip", "rar", "doc", "docx":
		return issueDoneExt(filename), true
	}
	switch normalizeIssueDoneMediaType(contentType) {
	case "application/pdf":
		return "pdf", true
	case "application/msword":
		return "doc", true
	case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		return "docx", true
	case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		return "xlsx", true
	case "application/zip", "application/x-zip-compressed":
		return "zip", true
	case "application/x-rar-compressed", "application/vnd.rar":
		return "rar", true
	}
	return "", false
}

func issueDoneExt(filename string) string {
	return strings.ToLower(strings.TrimPrefix(path.Ext(filename), "."))
}

func issueDoneFilename(filename string) string {
	name := path.Base(strings.TrimSpace(filename))
	if name == "" || name == "." || name == "/" {
		return "attachment"
	}
	return name
}

func normalizeIssueDoneMediaType(contentType string) string {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	return ct
}

func (n *IssueDoneNotifier) forwardIssueDoneFiles(ctx context.Context, s *sender, target sendTarget, files []db.Attachment) {
	if n.store == nil || len(files) == 0 {
		return
	}
	fileCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), issueDoneFileTimeout)
	defer cancel()
	for _, row := range files {
		if err := n.forwardOneIssueDoneFile(fileCtx, s, target, row); err != nil {
			n.logger.WarnContext(fileCtx, "dingtalk issue-done notify: attachment not forwarded",
				"error", err,
				"filename", row.Filename,
				"content_type", row.ContentType,
				"size_bytes", row.SizeBytes)
		}
	}
}

func (n *IssueDoneNotifier) forwardOneIssueDoneFile(ctx context.Context, s *sender, target sendTarget, row db.Attachment) error {
	kind := issueDoneAttachmentKind(row)
	if kind == issueDoneKindSkip {
		return fmt.Errorf("dingtalk: attachment format is not forwardable")
	}
	data, err := n.readIssueDoneFile(ctx, row)
	if err != nil {
		return err
	}
	filename := issueDoneFilename(row.Filename)
	mediaID, err := s.uploadMedia(ctx, filename, data)
	if err != nil {
		return err
	}
	switch kind {
	case issueDoneKindImage:
		_, err = s.send(ctx, target, issueDoneImageMarkdown(mediaID))
		return err
	case issueDoneKindFile:
		fileType, ok := issueDoneSampleFileType(filename, row.ContentType)
		if !ok {
			return fmt.Errorf("dingtalk: attachment format is not forwardable")
		}
		_, err = s.sendSampleFile(ctx, target, filename, fileType, mediaID)
		return err
	default:
		return fmt.Errorf("dingtalk: attachment format is not forwardable")
	}
}

func (n *IssueDoneNotifier) readIssueDoneFile(ctx context.Context, row db.Attachment) ([]byte, error) {
	key := n.store.KeyFromURL(row.Url)
	if key == "" {
		return nil, fmt.Errorf("dingtalk: attachment storage key is empty")
	}
	rc, err := n.store.GetReader(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("read attachment: %w", err)
	}
	defer func() { _ = rc.Close() }()
	data, err := io.ReadAll(io.LimitReader(rc, issueDoneMaxFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read attachment: %w", err)
	}
	if int64(len(data)) > issueDoneMaxFileBytes {
		return nil, fmt.Errorf("attachment exceeds the %d MB limit", issueDoneMaxFileBytes>>20)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("dingtalk: attachment is empty")
	}
	return data, nil
}
