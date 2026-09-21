package wechat

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestStripMarkdown(t *testing.T) {
	in := "## Title\n**bold** and *it* and `code` and [link](https://ex) and ~~x~~\n- item"
	got := stripMarkdown(in)
	for _, banned := range []string{"**", "`", "##", "]("} {
		if strings.Contains(got, banned) {
			t.Fatalf("still has %q: %q", banned, got)
		}
	}
	if !strings.Contains(got, "Title") || !strings.Contains(got, "bold") || !strings.Contains(got, "link (https://ex)") {
		t.Fatalf("stripped = %q", got)
	}
}

func TestChunkAndFit(t *testing.T) {
	long := strings.Repeat("字", 4500)
	chunks := chunkText(long, 2000)
	if len(chunks) < 3 {
		t.Fatalf("chunks = %d", len(chunks))
	}
	for _, c := range chunks {
		if utf8.RuneCountInString(c) > 2000 {
			t.Fatalf("chunk too long: %d", utf8.RuneCountInString(c))
		}
	}
	kept, dropped := fitChunks(chunks, 1, 2000)
	if len(kept) != 1 || dropped != len(chunks)-1 {
		t.Fatalf("fit = %d dropped=%d", len(kept), dropped)
	}
	if utf8.RuneCountInString(kept[0]) > 2000 {
		t.Fatal("merged chunk exceeds cap")
	}
}

func TestRenderOutboundRespectsFlag(t *testing.T) {
	md := "**hi**"
	if renderOutbound(md, true) != md {
		t.Fatal("markdown opt-in must pass through")
	}
	if renderOutbound(md, false) == md {
		t.Fatal("default must strip")
	}
}
