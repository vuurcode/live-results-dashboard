package wire

import (
	"encoding/json"
	"testing"
)

func TestStampKeepsTheMessageValid(t *testing.T) {
	for _, msg := range [][]byte{Wrap("reset", nil), Wrap("event_name", Marshal(map[string]string{"name": "x"}))} {
		var v struct {
			Seq  uint64
			Type string
		}
		if err := json.Unmarshal(Stamp(msg, 42), &v); err != nil || v.Seq != 42 || v.Type == "" {
			t.Fatalf("%s: %+v %v", Stamp(msg, 42), v, err)
		}
	}
}
