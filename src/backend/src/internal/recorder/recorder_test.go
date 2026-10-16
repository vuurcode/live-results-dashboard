package recorder

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readArchive(t *testing.T, b []byte) map[string]string {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		out[h.Name] = string(body)
	}
}

// clockedStore returns a store whose clock the test sets.
func clockedStore(t *testing.T, retention time.Duration) (*Store, *time.Time) {
	t.Helper()
	s, err := New(t.TempDir(), retention)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 3, 8, 10, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	return s, &now
}

func TestOnlyChangedRepliesAreKept(t *testing.T) {
	s, now := clockedStore(t, 0)
	r := s.Open("m1")
	r.Add([]byte(`{"a":1}`))
	r.Add([]byte(`{"a":1}`))
	*now = now.Add(time.Second)
	r.Add([]byte(`{"a":2}`))
	infos, _ := s.List()
	if len(infos) != 1 || infos[0].ID != "m1_2026-03-08" || infos[0].State != "recording" || infos[0].Snapshots != 2 {
		t.Fatalf("got %+v", infos)
	}
	// a restart carries on with the latest snapshot as the one to compare with
	s2, _ := New(s.dir, 0)
	s2.now = s.now
	s2.Open("m1").Add([]byte(`{"a":2}`))
	if infos, _ = s2.List(); infos[0].Snapshots != 2 {
		t.Fatalf("an unchanged reply after a restart was stored: %+v", infos)
	}
}

func TestEachDayIsARecordingOfItsOwn(t *testing.T) {
	s, now := clockedStore(t, 0)
	r := s.Open("m1")
	r.Add([]byte(`{"a":1}`))
	*now = now.AddDate(0, 0, 1)
	r.Add([]byte(`{"a":2}`))
	infos, _ := s.List()
	if len(infos) != 2 || infos[0].ID != "m1_2026-03-08" || infos[1].ID != "m1_2026-03-09" || infos[1].State != "recording" {
		t.Fatalf("got %+v", infos)
	}
	var buf bytes.Buffer
	if err := s.Write(&buf, "m1_2026-03-08"); err != nil {
		t.Fatal(err)
	}
	for name := range readArchive(t, buf.Bytes()) {
		if !strings.HasPrefix(name, "m1_2026-03-08/") {
			t.Fatalf("entry %q", name)
		}
	}
}

func TestADayThatIsRecordedAlreadyIsNotRecordedAgain(t *testing.T) {
	s, _ := clockedStore(t, 0)
	s.Open("m1").Add([]byte(`{"a":1}`))
	age(t, s, "m1_2026-03-08", 2*time.Hour)
	s.Sweep()
	r := s.Open("m1") // the match is opened again the same day
	r.Add([]byte(`{"a":2}`))
	infos, _ := s.List()
	if len(infos) != 1 || infos[0].State != "complete" {
		t.Fatalf("got %+v", infos)
	}
}

// age makes the snapshots of a recording as old as d is on the store's clock.
func age(t *testing.T, s *Store, name string, d time.Duration) {
	t.Helper()
	mt := s.now().Add(-d)
	dir := filepath.Join(s.dir, name)
	files, _ := os.ReadDir(dir)
	for _, f := range files {
		if err := os.Chtimes(filepath.Join(dir, f.Name()), mt, mt); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chtimes(dir, mt, mt); err != nil {
		t.Fatal(err)
	}
}

func TestFolderIsKeptForAnHourAndThenPacked(t *testing.T) {
	s, now := clockedStore(t, 0)
	r := s.Open("m1")
	r.Add([]byte(`{"a":1}`))
	*now = now.Add(time.Second)
	r.Add([]byte(`{"a":2}`))
	s.Finish("m1")
	age(t, s, "m1_2026-03-08", 59*time.Minute)
	s.Sweep()
	if infos, _ := s.List(); infos[0].State != "recording" {
		t.Fatalf("packed too early: %+v", infos)
	}
	// the match is picked up again within the hour: same recording
	*now = now.Add(time.Second)
	s.Open("m1").Add([]byte(`{"a":3}`))
	if infos, _ := s.List(); len(infos) != 1 || infos[0].Snapshots != 3 {
		t.Fatalf("got %+v", infos)
	}
	age(t, s, "m1_2026-03-08", 61*time.Minute)
	s.Sweep()
	infos, _ := s.List()
	if len(infos) != 1 || infos[0].State != "complete" || infos[0].Bytes == 0 {
		t.Fatalf("got %+v", infos)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "m1_2026-03-08")); !os.IsNotExist(err) {
		t.Fatal("the folder of snapshots is still there")
	}
	var buf bytes.Buffer
	if err := s.Write(&buf, "m1_2026-03-08"); err != nil {
		t.Fatal(err)
	}
	if files := readArchive(t, buf.Bytes()); len(files) != 3 {
		t.Fatalf("archive holds %v", files)
	}
}

func TestDownloadOfARecordingThatIsGoing(t *testing.T) {
	s, _ := clockedStore(t, 0)
	s.Open("m1").Add([]byte(`{"a":1}`))
	var buf bytes.Buffer
	if err := s.Write(&buf, "m1_2026-03-08"); err != nil {
		t.Fatal(err)
	}
	if files := readArchive(t, buf.Bytes()); len(files) != 1 {
		t.Fatalf("got %v", files)
	}
}

func TestDeleteAndUnknownNames(t *testing.T) {
	s, now := clockedStore(t, 0)
	r := s.Open("m1")
	r.Add([]byte(`{"a":1}`))
	if err := s.Delete("m1_2026-03-08"); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Second)
	r.Add([]byte(`{"a":2}`)) // the match carries on after the delete; the rest of the day is not stored
	if infos, _ := s.List(); len(infos) != 0 {
		t.Fatalf("got %+v", infos)
	}
	if err := s.Delete("m1_2026-03-08"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	if err := s.Delete("../x"); !errors.Is(err, ErrBadID) {
		t.Fatalf("got %v", err)
	}
	if err := s.Write(io.Discard, "nope_2026-03-08"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestSweepRemovesPastRetention(t *testing.T) {
	s, now := clockedStore(t, 30*24*time.Hour)
	s.Open("m1").Add([]byte(`{"a":1}`))
	age(t, s, "m1_2026-03-08", 2*time.Hour)
	s.Sweep() // packed
	if err := os.Chtimes(s.archive("m1_2026-03-08"), *now, *now); err != nil {
		t.Fatal(err)
	}
	*now = now.AddDate(0, 0, 29)
	s.Sweep()
	if infos, _ := s.List(); len(infos) != 1 {
		t.Fatalf("removed too early: %+v", infos)
	}
	*now = now.AddDate(0, 0, 2)
	s.Sweep()
	if infos, _ := s.List(); len(infos) != 0 {
		t.Fatalf("still there: %+v", infos)
	}
}

func TestANilStoreAndRecordingDoNothing(_ *testing.T) {
	var s *Store
	r := s.Open("m1")
	r.Add([]byte("x"))
	s.Finish("m1")
}

func TestFollowingWhileLiveRepliesComeIn(t *testing.T) {
	s, now := clockedStore(t, 0)
	if s.Following("m1") {
		t.Fatal("following before anything came in")
	}
	r := s.Open("m1")
	r.Add([]byte(`{"a":1}`))
	if !s.Following("m1") {
		t.Fatal("not following")
	}
	*now = now.Add(settle + time.Second)
	if s.Following("m1") {
		t.Fatal("following without live replies for an hour")
	}
	r.Add([]byte(`{"a":1}`)) // unchanged replies count too
	if !s.Following("m1") {
		t.Fatal("not following")
	}
	s.Finish("m1")
	if s.Following("m1") {
		t.Fatal("following a finished match")
	}
	var nilStore *Store
	if nilStore.Following("m1") {
		t.Fatal("nil store follows")
	}
}
