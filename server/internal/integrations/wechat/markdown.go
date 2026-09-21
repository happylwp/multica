package wechat

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// iLink rich-text is unverified. Default path is plain text + chunking.
// support_markdown on the installation config is the opt-in; when false
// (the default) markdown is stripped before send.

const maxMessageRunes = 2000

var (
	reFence      = regexp.MustCompile("(?s)```[a-zA-Z0-9_-]*\\n?(.*?)```")
	reInlineCode = regexp.MustCompile("`([^`]+)`")
	reBold       = regexp.MustCompile(`\*\*(.+?)\*\*`)
	reItalic     = regexp.MustCompile(`(^|[^*])\*([^*]+?)\*`)
	reStrike     = regexp.MustCompile(`~~(.+?)~~`)
	reLink       = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)\)`)
	reHeading    = regexp.MustCompile(`(?m)^#{1,6}\s+`)
	reBullet     = regexp.MustCompile(`(?m)^(\s*)[-*]\s+`)
)

// renderOutbound converts agent markdown to the wire body. When
// supportMarkdown is false the formatting is stripped so WeChat shows
// readable plain text.
func renderOutbound(text string, supportMarkdown bool) string {
	if supportMarkdown {
		return text
	}
	return stripMarkdown(text)
}

func stripMarkdown(md string) string {
	s := reFence.ReplaceAllString(md, "$1")
	s = reInlineCode.ReplaceAllString(s, "$1")
	s = reBold.ReplaceAllString(s, "$1")
	s = reItalic.ReplaceAllString(s, "$1$2")
	s = reStrike.ReplaceAllString(s, "$1")
	s = reLink.ReplaceAllString(s, "$1 ($2)")
	s = reHeading.ReplaceAllString(s, "")
	s = reBullet.ReplaceAllString(s, "$1• ")
	return strings.TrimSpace(s)
}

// chunkText splits on rune boundaries, preferring newlines, so a long
// reply becomes several independent iLink messages (each counts against
// the 10/24h quota).
func chunkText(text string, maxRunes int) []string {
	if maxRunes <= 0 {
		maxRunes = maxMessageRunes
	}
	if text == "" {
		return nil
	}
	if utf8.RuneCountInString(text) <= maxRunes {
		return []string{text}
	}
	runes := []rune(text)
	var chunks []string
	for len(runes) > 0 {
		end := maxRunes
		if end > len(runes) {
			end = len(runes)
		}
		if i := lastNewline(runes[:end]); i >= maxRunes/2 {
			end = i + 1
		}
		chunks = append(chunks, strings.TrimRight(string(runes[:end]), "\n"))
		runes = runes[end:]
	}
	return chunks
}

func lastNewline(rs []rune) int {
	for i := len(rs) - 1; i >= 0; i-- {
		if rs[i] == '\n' {
			return i
		}
	}
	return -1
}

// fitChunks reduces chunks to at most n slots by merging leftovers into
// the last allowed chunk (truncated to maxRunes). Used when the quota
// cannot cover every piece — official 超限降级.
func fitChunks(chunks []string, n, maxRunes int) (kept []string, dropped int) {
	if n <= 0 {
		return nil, len(chunks)
	}
	if len(chunks) <= n {
		return chunks, 0
	}
	kept = append([]string(nil), chunks[:n-1]...)
	rest := strings.Join(chunks[n-1:], "\n")
	if utf8.RuneCountInString(rest) > maxRunes {
		rest = string([]rune(rest)[:maxRunes])
	}
	kept = append(kept, rest)
	return kept, len(chunks) - n
}
