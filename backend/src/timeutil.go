package main

import (
	"strconv"
	"strings"
)

// parseSeconds converts "h:mm:ss.fff", "m:ss.fff" or "ss.fff" to seconds.
// Unparseable parts count as zero.
func parseSeconds(t string) float64 {
	if t == "" {
		return 0
	}
	parts := strings.Split(t, ":")
	switch len(parts) {
	case 3:
		return float64(atoi(parts[0]))*3600 + float64(atoi(parts[1]))*60 + atof(parts[2])
	case 2:
		return float64(atoi(parts[0]))*60 + atof(parts[1])
	default:
		return atof(parts[0])
	}
}

// formatTime strips leading zeros and truncates to 3 decimal places.
func formatTime(t string) string {
	if t == "" {
		return ""
	}
	parts := strings.Split(t, ":")
	result := make([]string, 0, len(parts))
	foundNonzero := false
	for i, part := range parts {
		if i < len(parts)-1 {
			n := atoi(part)
			if !foundNonzero && n == 0 {
				continue
			}
			foundNonzero = true
			result = append(result, strconv.Itoa(n))
			continue
		}
		intPart, decPart, hasDot := strings.Cut(part, ".")
		if !foundNonzero {
			intPart = strings.TrimLeft(intPart, "0")
			if intPart == "" {
				intPart = "0"
			}
		}
		if !hasDot {
			result = append(result, intPart)
			continue
		}
		if len(decPart) > 3 {
			decPart = decPart[:3]
		}
		result = append(result, intPart+"."+decPart)
	}
	return strings.Join(result, ":")
}

func atoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

func atof(s string) float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}
