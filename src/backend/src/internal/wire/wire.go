// Package wire builds the JSON messages the backend sends to its websocket clients.
package wire

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// Wrap builds a `{"type":...,"data":...}` WebSocket message around pre-encoded data.
func Wrap(typ string, data []byte) []byte {
	var b bytes.Buffer
	b.WriteString(`{"type":`)
	t, _ := json.Marshal(typ)
	b.Write(t)
	if data != nil {
		b.WriteString(`,"data":`)
		b.Write(data)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// Stamp returns msg, a message made by Wrap, with a sequence number as its first field.
func Stamp(msg []byte, seq uint64) []byte {
	out := make([]byte, 0, len(msg)+24)
	out = append(out, `{"seq":`...)
	out = strconv.AppendUint(out, seq, 10)
	out = append(out, ',')
	return append(out, msg[1:]...)
}

// Marshal encodes v as JSON without HTML escaping.
func Marshal(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err) // only plain structs are encoded; cannot fail
	}
	return bytes.TrimRight(b.Bytes(), "\n")
}
