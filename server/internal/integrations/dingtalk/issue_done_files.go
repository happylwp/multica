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

func appendIssueDonePartialNote(body string) string {
	body = strings.TrimRight(body, "\n")
	return body + "\n\n" + issueDonePartialNote
}

// planIssueDoneAttachments keeps images and common documents, drops oversize
// files, and caps the send list at issueDoneMaxFiles. partial is true when
// anything was skipped so the markdown can say so.
func planIssueDoneAttachments(rows []db.Attachment) (send []db.Attachment, partial bool) {
	var eligible []db.Attachment
	for _, row := range rows {
		if !issueDoneForwardable(row) || row.SizeBytes > issueDoneMaxFileBytes {
			partial = true
			continue
		}
		eligible = append(eligible, row)
	}
	if len(eligible) > issueDoneMaxFiles {
		partial = true
		eligible = eligible[:issueDoneMaxFiles]
	}
	return eligible, partial
}

func issueDoneForwardable(row db.Attachment) bool {
	ct := normalizeIssueDoneMediaType(row.ContentType)
	if strings.HasPrefix(ct, "image/") && ct != "image/svg+xml" {
		return true
	}
	switch ct {
	case "application/pdf",
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.ms-excel.sheet.macroenabled.12",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/zip",
		"application/x-zip-compressed",
		"application/x-rar-compressed",
		"application/vnd.rar",
		"application/x-7z-compressed",
		"text/plain",
		"text/markdown",
		"text/csv":
		return true
	}
	switch issueDoneExt(row.Filename) {
	case "png", "jpg", "jpeg", "gif", "webp", "bmp",
		"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
		"zip", "rar", "7z", "txt", "md", "csv":
		return true
	}
	return false
}

func issueDoneExt(filename string) string {
	return strings.ToLower(strings.TrimPrefix(path.Ext(filename), "."))
}

func issueDoneFileType(filename, contentType string) string {
	ext := issueDoneExt(filename)
	if ext == "jpeg" {
		return "jpg"
	}
	if ext != "" {
		return ext
	}
	switch normalizeIssueDoneMediaType(contentType) {
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpg"
	case "image/gif":
		return "gif"
	case "image/webp":
		return "webp"
	case "image/bmp":
		return "bmp"
	case "application/pdf":
		return "pdf"
	case "application/zip", "application/x-zip-compressed":
		return "zip"
	case "text/plain":
		return "txt"
	case "text/csv":
		return "csv"
	case "text/markdown":
		return "md"
	default:
		return "file"
	}
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
	data, err := n.readIssueDoneFile(ctx, row)
	if err != nil {
		return err
	}
	filename := issueDoneFilename(row.Filename)
	_, err = s.sendFile(ctx, target, filename, issueDoneFileType(filename, row.ContentType), data)
	return err
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
