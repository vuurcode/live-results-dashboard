package recorder

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// personalKeys are the fields of a competitor that name the person.
var personalKeys = map[string]bool{"name": true, "firstname": true, "lastname": true, "fullname": true, "middlename": true, "surname": true}

// anonymize removes who the competitors are from a reply of the data source: names become "Competitor <start
// number>" and the competitor id becomes a hash of itself, in the shape of an id. Everything else is kept as it is,
// apart from the key order and spacing of the JSON.
func anonymize(body []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var doc map[string]any
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	distances, _ := doc["distances"].([]any)
	for _, d := range distances {
		dist, _ := d.(map[string]any)
		races, _ := dist["races"].([]any)
		for _, r := range races {
			race, _ := r.(map[string]any)
			if c, ok := race["competitor"].(map[string]any); ok {
				anonymizeCompetitor(c)
			}
		}
	}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return bytes.TrimRight(out.Bytes(), "\n"), nil
}

func anonymizeCompetitor(c map[string]any) {
	label := "Competitor"
	if n := fmt.Sprint(c["startNumber"]); c["startNumber"] != nil && n != "" {
		label += " " + n
	}
	for k, v := range c {
		str, ok := v.(string)
		switch {
		case !ok || str == "":
		case personalKeys[strings.ToLower(k)]:
			c[k] = label
		case strings.EqualFold(k, "id"):
			sum := sha256.Sum256([]byte(str))
			h := hex.EncodeToString(sum[:])
			c[k] = fmt.Sprintf("%s-%s-%s-%s-%s", h[:8], h[8:12], h[12:16], h[16:20], h[20:32])
		}
	}
}
