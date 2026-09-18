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
	issueDoneKindImage issueDoneKind = iota
	issueDoneKindFile
)

func appendIssueDonePartialNote(body string) string {
	body = strings.TrimRight(body, "\n")
	return body + "\n\n" + issueDonePartialNote
}

func issueDoneImageMarkdown(mediaID string) string {
	return "![](" + mediaID + ")"
}

func appendIssueDoneImageMarkdown(body string, mediaIDs []string) string {
	if len(mediaIDs) == 0 {
		return body
	}
	var b strings.Builder
	b.WriteString(strings.TrimRight(body, "\n"))
	for _, id := range mediaIDs {
		b.WriteString("\n\n")
		b.WriteString(issueDoneImageMarkdown(id))
	}
	return b.String()
}

// planIssueDoneAttachments drops oversize files and caps the send list.
// Images (except svg) embed into the same terminal markdown; every other
// format — official sampleFile types and off-list formats — goes out as
// sampleFile.
func planIssueDoneAttachments(rows []db.Attachment) (send, skipped []db.Attachment, partial bool) {
	var eligible []db.Attachment
	for _, row := range rows {
		if row.SizeBytes > issueDoneMaxFileBytes {
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
	return issueDoneKindFile
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

func issueDoneUploadType(kind issueDoneKind) string {
	if kind == issueDoneKindImage {
		return "image"
	}
	return "file"
}

// issueDoneSampleFileType maps an attachment to sampleFile's fileType.
// Official docs list xlsx/pdf/zip/rar/doc/docx; off-list formats still
// send as sampleFile using the extension (or "file").
func issueDoneSampleFileType(filename, contentType string) string {
	switch issueDoneExt(filename) {
	case "xlsx", "pdf", "zip", "rar", "doc", "docx":
		return issueDoneExt(filename)
	}
	switch normalizeIssueDoneMediaType(contentType) {
	case "application/pdf":
		return "pdf"
	case "application/msword":
		return "doc"
	case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		return "docx"
	case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		return "xlsx"
	case "application/zip", "application/x-zip-compressed":
		return "zip"
	case "application/x-rar-compressed", "application/vnd.rar":
		return "rar"
	}
	if ext := issueDoneExt(filename); ext != "" {
		return ext
	}
	return "file"
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

func (n *IssueDoneNotifier) prepareIssueDoneMarkdown(ctx context.Context, s *sender, body string, files []db.Attachment) (string, []db.Attachment) {
	if n.store == nil || len(files) == 0 {
		return body, nil
	}
	var docs []db.Attachment
	var mediaIDs []string
	for _, row := range files {
		if issueDoneAttachmentKind(row) != issueDoneKindImage {
			docs = append(docs, row)
			continue
		}
		mediaID, err := n.uploadIssueDoneAttachment(ctx, s, row, issueDoneUploadType(issueDoneKindImage))
		if err != nil {
			n.logger.WarnContext(ctx, "dingtalk issue-done notify: attachment not forwarded",
				"error", err,
				"filename", row.Filename,
				"content_type", row.ContentType,
				"size_bytes", row.SizeBytes)
			continue
		}
		mediaIDs = append(mediaIDs, mediaID)
	}
	return appendIssueDoneImageMarkdown(body, mediaIDs), docs
}

func (n *IssueDoneNotifier) forwardIssueDoneFiles(ctx context.Context, s *sender, target sendTarget, files []db.Attachment) {
	if n.store == nil || len(files) == 0 {
		return
	}
	for _, row := range files {
		if err := n.forwardOneIssueDoneFile(ctx, s, target, row); err != nil {
			n.logger.WarnContext(ctx, "dingtalk issue-done notify: attachment not forwarded",
				"error", err,
				"filename", row.Filename,
				"content_type", row.ContentType,
				"size_bytes", row.SizeBytes)
		}
	}
}

func (n *IssueDoneNotifier) forwardOneIssueDoneFile(ctx context.Context, s *sender, target sendTarget, row db.Attachment) error {
	filename := issueDoneFilename(row.Filename)
	mediaID, err := n.uploadIssueDoneAttachment(ctx, s, row, issueDoneUploadType(issueDoneKindFile))
	if err != nil {
		return err
	}
	_, err = s.sendSampleFile(ctx, target, filename, issueDoneSampleFileType(filename, row.ContentType), mediaID)
	return err
}

func (n *IssueDoneNotifier) uploadIssueDoneAttachment(ctx context.Context, s *sender, row db.Attachment, mediaType string) (string, error) {
	data, err := n.readIssueDoneFile(ctx, row)
	if err != nil {
		return "", err
	}
	return s.uploadMedia(ctx, issueDoneFilename(row.Filename), mediaType, data)
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
