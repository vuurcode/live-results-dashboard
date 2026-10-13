package config

import (
	"bufio"
	_ "embed"
	"log/slog"
	"os"
	"strconv"
	"strings"
)

// limitsFile holds the limits and timings the image is built with; see limits.conf.
//
//go:embed limits.conf
var limitsFile string

var baked = parseSettings(limitsFile)

// parseSettings reads KEY=VALUE lines; blank lines and lines starting with # are skipped.
func parseSettings(text string) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if key, value, ok := strings.Cut(line, "="); ok && line != "" && !strings.HasPrefix(line, "#") {
			out[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return out
}

func positive(f float64) bool    { return f > 0 }
func nonNegative(f float64) bool { return f >= 0 }

// number reads a numeric setting. The environment wins; a value in it that does not parse or is out of range is
// ignored. The baked value is the default, and an invalid one stops the start, because the image itself is wrong.
func number(key string, valid func(float64) bool) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && valid(f) {
			return f
		}
		slog.Warn("Ignoring invalid "+key, "value", v)
	}
	f, err := strconv.ParseFloat(baked[key], 64)
	if err != nil || !valid(f) {
		slog.Error("Invalid or missing baked setting", "key", key, "value", baked[key])
		os.Exit(1)
	}
	return f
}
