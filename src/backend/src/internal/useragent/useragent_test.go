package useragent

import (
	"strings"
	"testing"
)

func TestSanitize(t *testing.T) {
	if got := Sanitize("Mozilla/5.0\r\nX-Evil: 1\x00"); got != "Mozilla/5.0X-Evil: 1" {
		t.Errorf("got %q", got)
	}
	if got := Sanitize(strings.Repeat("a", 1000)); len(got) != maxLength {
		t.Errorf("length %d", len(got))
	}
}

func TestFixedOverridesMirroring(t *testing.T) {
	mirror := New("")
	mirror.Set("Browser/1.0")
	if got := mirror.Get(); got != "Browser/1.0" {
		t.Errorf("mirrored = %q", got)
	}
	fixed := New("MyDashboard/1.0\r\n")
	fixed.Set("Browser/1.0")
	if got := fixed.Get(); got != "MyDashboard/1.0" {
		t.Errorf("fixed = %q, want MyDashboard/1.0", got)
	}
}
