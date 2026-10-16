// Package recorder keeps the replies of the live results API for later replay. Each UTC day of a match is a recording
// of its own, named <id>_<date>: a folder of snapshots, one file per reply that differs from the one before (the
// layout the mockserver replays from, named by UTC time so that filename order is time order). A folder stays as it
// is for an hour after its last snapshot, so that a match whose live timing drops or restarts carries on in the same
// recording. After that Sweep packs it into <name>.tar.gz, which extracts to that same layout. A day that has an
// archive is wrapped up and is not recorded again. Recordings older than the retention are removed.
package recorder

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	// ErrNotFound means nothing is stored for the id.
	ErrNotFound = errors.New("no recording with this id")
	// ErrBadID means the id could not name a recording.
	ErrBadID = errors.New("invalid recording id")

	idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	// nameRe matches the name of a recording: a competition id, an underscore and a date.
	nameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}_\d{4}-\d{2}-\d{2}$`)
)

const (
	snapshotExt = ".json"
	archiveExt  = ".tar.gz"
	// snapshotTime names a snapshot: fixed width, so that sorting the names sorts the snapshots in time.
	snapshotTime = "20060102T150405.000Z"
	settle       = time.Hour // how long a folder of snapshots is left alone before it is packed
)

// Store is the folder the recordings live in.
type Store struct {
	dir       string
	retention time.Duration // how long a recording is kept, counted from its last snapshot; 0 keeps them
	now       func() time.Time

	mu     sync.Mutex
	active map[string]*Recording
}

// New returns a store in dir, which is created when missing. Recordings are removed retention after their last
// snapshot (see Sweep).
func New(dir string, retention time.Duration) (*Store, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	return &Store{dir: dir, retention: retention, now: time.Now, active: map[string]*Recording{}}, nil
}

// Info describes one stored recording.
type Info struct {
	ID        string    `json:"id"`
	State     string    `json:"state"` // "recording" while the folder of snapshots is still growing, "complete" once packed
	Snapshots int       `json:"snapshots,omitempty"`
	Bytes     int64     `json:"bytes"`
	Modified  time.Time `json:"modified"`
}

// Recording is the stream of snapshots of one match. A nil Recording ignores everything, so callers need no check.
type Recording struct {
	store *Store
	id    string

	mu      sync.Mutex
	started bool   // whether a day is open: name, day, dir and last are set
	name    string // <id>_<date> of the day being recorded
	day     string
	dir     string
	last    []byte // the latest snapshot, to leave out replies that did not change
	skip    bool   // the day is not recorded: it has an archive already, or was deleted
	closed  bool
}

// Open returns the recording of a match, which carries on across restarts and days. It returns nil when recording is
// off. The day is chosen by the replies that come in.
func (s *Store) Open(id string) *Recording {
	if s == nil || !idRe.MatchString(id) {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.active[id]; ok {
		return r
	}
	r := &Recording{store: s, id: id}
	s.active[id] = r
	return r
}

func (s *Store) archive(name string) string { return filepath.Join(s.dir, name+archiveExt) }

// begin opens the recording of a day.
func (r *Recording) begin(day string) {
	r.name = r.id + "_" + day
	r.day, r.dir = day, filepath.Join(r.store.dir, r.name)
	r.started, r.skip, r.last = true, false, nil
	if _, err := os.Stat(r.store.archive(r.name)); err == nil {
		r.skip = true
		return
	}
	r.last = r.latestOnDisk()
}

// Add stores body when it differs from the snapshot before it. The first reply of a new day opens the next recording.
func (r *Recording) Add(body []byte) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	if day := r.store.now().UTC().Format(time.DateOnly); !r.started || day != r.day {
		r.started = false
		r.begin(day)
	}
	if r.skip || bytes.Equal(body, r.last) {
		return
	}
	if err := os.MkdirAll(r.dir, 0o750); err != nil {
		slog.Error("Recording failed", "competition", r.id, "err", err)
		return
	}
	name := filepath.Join(r.dir, r.store.now().UTC().Format(snapshotTime)+snapshotExt)
	// written under another name first, so that a download never reads half a snapshot
	if err := writeFile(name, body); err != nil {
		slog.Error("Recording failed", "competition", r.id, "err", err)
		return
	}
	r.last = append(r.last[:0], body...)
}

// packLocked packs the open day, if there is one, and leaves the recording without one.
func (r *Recording) packLocked() {
	if !r.started {
		return
	}
	r.started = false
	if err := r.store.pack(r.name); err != nil {
		slog.Error("Packing the recording failed", "recording", r.name, "err", err)
	}
}

func (r *Recording) latestOnDisk() []byte {
	names := snapshotNames(r.dir)
	if len(names) == 0 {
		return nil
	}
	b, _ := os.ReadFile(filepath.Join(r.dir, names[len(names)-1])) //nolint:gosec // a name read from the recording's own folder
	return b
}

func writeFile(name string, body []byte) error {
	tmp := name + ".tmp"
	if err := os.WriteFile(tmp, body, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, name)
}

// snapshotNames lists the snapshot files of a folder in time order.
func snapshotNames(dir string) []string {
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), snapshotExt) {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}

// Finish ends the recording of a match that is over. Its folder is packed by Sweep once it has been quiet for an hour.
func (s *Store) Finish(id string) error {
	if s == nil || !idRe.MatchString(id) {
		return nil
	}
	s.mu.Lock()
	r := s.active[id]
	delete(s.active, id)
	s.mu.Unlock()
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	return nil
}

// pack turns the folder of snapshots of a recording into <name>.tar.gz and removes the folder. A folder without
// snapshots leaves nothing behind.
func (s *Store) pack(name string) error {
	dir := filepath.Join(s.dir, name)
	names := snapshotNames(dir)
	if len(names) == 0 {
		return os.RemoveAll(dir)
	}
	tmp := s.archive(name) + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640) //nolint:gosec // inside the store, named by a validated name
	if err != nil {
		return err
	}
	err = writeArchive(f, name, dir, names)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, s.archive(name)); err != nil {
		return err
	}
	slog.Info("Recording complete", "recording", name, "snapshots", len(names))
	return os.RemoveAll(dir)
}

// writeArchive writes the snapshots as a gzipped tar whose entries are <dirName>/<snapshot>.
func writeArchive(w io.Writer, dirName, dir string, names []string) error {
	gz, err := gzip.NewWriterLevel(w, gzip.BestCompression)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(gz)
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(dir, name)) //nolint:gosec // a name from the recording's own folder
		if err != nil {
			return err
		}
		hdr := &tar.Header{Name: dirName + "/" + name, Mode: 0o640, Size: int64(len(b)), ModTime: modTime(name)}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if _, err := tw.Write(b); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

func modTime(name string) time.Time {
	t, err := time.Parse(snapshotTime, strings.TrimSuffix(name, snapshotExt))
	if err != nil {
		return time.Time{}
	}
	return t
}

// List describes every stored recording, by id.
func (s *Store) List() ([]Info, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	out := []Info{}
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil {
			continue
		}
		switch {
		case e.IsDir() && nameRe.MatchString(e.Name()):
			info := Info{ID: e.Name(), State: "recording", Modified: fi.ModTime()}
			for _, n := range snapshotNames(filepath.Join(s.dir, e.Name())) {
				if sfi, err := os.Stat(filepath.Join(s.dir, e.Name(), n)); err == nil {
					info.Snapshots++
					info.Bytes += sfi.Size()
					if sfi.ModTime().After(info.Modified) {
						info.Modified = sfi.ModTime()
					}
				}
			}
			out = append(out, info)
		case strings.HasSuffix(e.Name(), archiveExt) && nameRe.MatchString(strings.TrimSuffix(e.Name(), archiveExt)):
			out = append(out, Info{ID: strings.TrimSuffix(e.Name(), archiveExt), State: "complete", Bytes: fi.Size(), Modified: fi.ModTime()})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// Write sends a recording as a gzipped tar: the packed file of a complete one, or the snapshots so far of one that
// is still going. It returns ErrNotFound, before writing anything, for a name nothing is stored under.
func (s *Store) Write(w io.Writer, name string) error {
	if !nameRe.MatchString(name) {
		return ErrBadID
	}
	if f, err := os.Open(s.archive(name)); err == nil { //nolint:gosec // named by a validated name
		defer func() { _ = f.Close() }()
		_, err = io.Copy(w, f)
		return err
	}
	dir := filepath.Join(s.dir, name)
	names := snapshotNames(dir)
	if len(names) == 0 {
		return ErrNotFound
	}
	return writeArchive(w, name, dir, names)
}

// Info describes the recording stored under name.
func (s *Store) Info(name string) (Info, error) {
	if !nameRe.MatchString(name) {
		return Info{}, ErrBadID
	}
	infos, err := s.List()
	if err != nil {
		return Info{}, err
	}
	for _, i := range infos {
		if i.ID == name {
			return i, nil
		}
	}
	return Info{}, ErrNotFound
}

// Delete removes a recording, also one that is still going: the rest of its day is not stored.
func (s *Store) Delete(name string) error {
	if _, err := s.Info(name); err != nil {
		return err
	}
	s.mu.Lock()
	for _, r := range s.active {
		r.mu.Lock()
		if r.started && r.name == name {
			r.skip = true
		}
		r.mu.Unlock()
	}
	s.mu.Unlock()
	if err := os.RemoveAll(filepath.Join(s.dir, name)); err != nil {
		return err
	}
	if err := os.Remove(s.archive(name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove archive: %w", err)
	}
	return nil
}

// Sweep packs the folders that have had no snapshot for an hour and removes the recordings that are older than the
// retention. It is meant to run regularly.
func (s *Store) Sweep() {
	s.mu.Lock()
	open := map[string]bool{}
	for _, r := range s.active {
		r.mu.Lock()
		if r.started && s.idle(r.name) {
			r.packLocked()
		}
		if r.started {
			open[r.name] = true
		}
		r.mu.Unlock()
	}
	s.mu.Unlock()

	infos, err := s.List()
	if err != nil {
		slog.Error("Sweeping the recordings failed", "err", err)
		return
	}
	for _, i := range infos {
		if i.State == "recording" && !open[i.ID] && s.now().Sub(i.Modified) > settle {
			if err := s.pack(i.ID); err != nil {
				slog.Error("Packing the recording failed", "recording", i.ID, "err", err)
			}
		}
	}
	if s.retention <= 0 {
		return
	}
	infos, _ = s.List()
	for _, i := range infos {
		if s.now().Sub(i.Modified) > s.retention {
			if err := s.Delete(i.ID); err == nil {
				slog.Info("Recording removed (past retention)", "recording", i.ID)
			}
		}
	}
}

// idle reports whether the folder of a recording has had no snapshot for the settle time.
func (s *Store) idle(name string) bool {
	i, err := s.Info(name)
	return err == nil && i.State == "recording" && s.now().Sub(i.Modified) > settle
}
