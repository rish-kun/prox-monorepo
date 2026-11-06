package quotapoll

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	log "github.com/sirupsen/logrus"
)

const (
	fileVersion      = 1
	snapshotFileName = "latest.quota"
	historyFileName  = "history.quota"
)

// DirForConfig returns <dir of config file>/quota, or "" without a config path.
// The files inside deliberately avoid the ".json" extension: the config
// directory is often also the auth directory, scanned for *.json credentials.
func DirForConfig(configFilePath string) string {
	if configFilePath == "" {
		return ""
	}
	dir := filepath.Dir(configFilePath)
	if abs, errAbs := filepath.Abs(dir); errAbs == nil {
		dir = abs
	}
	return filepath.Join(dir, "quota")
}

type persistedSnapshot struct {
	Snapshot
	Failures int `json:"failures,omitempty"`
}

type snapshotFile struct {
	Version   int                          `json:"version"`
	Snapshots map[string]persistedSnapshot `json:"snapshots"`
}

type historyFile struct {
	Version         int      `json:"version"`
	FirstRecordedAt int64    `json:"first_recorded_at"`
	Samples         []Sample `json:"samples"`
}

func (s *Service) snapshotPath() string { return filepath.Join(s.dir, snapshotFileName) }
func (s *Service) historyPath() string  { return filepath.Join(s.dir, historyFileName) }

// load reads both files. A corrupt file is moved aside; an unreadable file
// disables persistence so the service runs in memory.
func (s *Service) load() {
	if s.dir == "" {
		return
	}
	var snaps snapshotFile
	okSnaps, errSnaps := s.readFile(s.snapshotPath(), &snaps, func() bool { return snaps.Version == fileVersion })
	var hist historyFile
	okHist, errHist := s.readFile(s.historyPath(), &hist, func() bool { return hist.Version == fileVersion })
	if errSnaps != nil || errHist != nil {
		log.WithError(errors.Join(errSnaps, errHist)).Error("quotapoll: cannot read quota files; quota history is kept in memory only")
		s.dir = ""
		return
	}
	if okSnaps {
		for index, persisted := range snaps.Snapshots {
			if index == "" {
				continue
			}
			snap := persisted.Snapshot
			snap.AuthIndex = index
			if snap.Responses == nil {
				snap.Responses = map[string]Response{}
			}
			s.entries[index] = &entry{snap: snap, failures: persisted.Failures}
		}
	}
	if okHist {
		s.history.loadSamples(hist.FirstRecordedAt, hist.Samples)
	}
}

// readFile decodes path into v. It returns ok=false for a missing or corrupt
// file (the latter is renamed to <path>.corrupt-<unix>) and an error only when
// the file exists but cannot be read.
func (s *Service) readFile(path string, v any, valid func() bool) (bool, error) {
	raw, errRead := os.ReadFile(path)
	if errRead != nil {
		if errors.Is(errRead, fs.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("read %s: %w", path, errRead)
	}
	errParse := json.Unmarshal(raw, v)
	if errParse == nil && !valid() {
		errParse = errors.New("unsupported version")
	}
	if errParse != nil {
		corruptPath := fmt.Sprintf("%s.corrupt-%d", path, s.now().Unix())
		log.WithError(errParse).Warnf("quotapoll: %s is corrupt; moving it to %s and starting empty", path, corruptPath)
		if errRename := os.Rename(path, corruptPath); errRename != nil {
			log.WithError(errRename).Warn("quotapoll: failed to move corrupt quota file aside")
		}
		return false, nil
	}
	return true, nil
}

// Flush writes changed state to disk atomically.
func (s *Service) Flush() error {
	if s == nil {
		return nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.dir == "" {
		return nil
	}

	var errs []error

	s.mu.Lock()
	snapDirty := s.snapDirty
	var snaps snapshotFile
	if snapDirty {
		snaps = snapshotFile{Version: fileVersion, Snapshots: make(map[string]persistedSnapshot, len(s.entries))}
		for index, e := range s.entries {
			snaps.Snapshots[index] = persistedSnapshot{Snapshot: e.snap.clone(), Failures: e.failures}
		}
		s.snapDirty = false
	}
	s.mu.Unlock()
	if snapDirty {
		if errWrite := writeAtomic(s.snapshotPath(), snaps); errWrite != nil {
			s.mu.Lock()
			s.snapDirty = true
			s.mu.Unlock()
			errs = append(errs, errWrite)
		}
	}

	s.history.mu.Lock()
	histDirty := s.history.dirty
	var hist historyFile
	if histDirty {
		hist = historyFile{Version: fileVersion, FirstRecordedAt: s.history.firstRecordedAt, Samples: s.history.allLocked()}
		s.history.dirty = false
	}
	s.history.mu.Unlock()
	if histDirty {
		if errWrite := writeAtomic(s.historyPath(), hist); errWrite != nil {
			s.history.mu.Lock()
			s.history.dirty = true
			s.history.mu.Unlock()
			errs = append(errs, errWrite)
		}
	}
	return errors.Join(errs...)
}

func writeAtomic(path string, v any) error {
	raw, errMarshal := json.Marshal(v)
	if errMarshal != nil {
		return fmt.Errorf("quotapoll: encode: %w", errMarshal)
	}
	dir := filepath.Dir(path)
	if errMkdir := os.MkdirAll(dir, 0o700); errMkdir != nil {
		return fmt.Errorf("quotapoll: create dir %s: %w", dir, errMkdir)
	}
	tmp, errCreate := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if errCreate != nil {
		return fmt.Errorf("quotapoll: create temp file: %w", errCreate)
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			if errRemove := os.Remove(tmpPath); errRemove != nil && !errors.Is(errRemove, fs.ErrNotExist) {
				log.WithError(errRemove).Warn("quotapoll: failed to remove temp file")
			}
		}
	}()
	if errChmod := tmp.Chmod(0o600); errChmod != nil {
		_ = tmp.Close()
		return fmt.Errorf("quotapoll: chmod temp file: %w", errChmod)
	}
	if _, errWrite := tmp.Write(raw); errWrite != nil {
		_ = tmp.Close()
		return fmt.Errorf("quotapoll: write temp file: %w", errWrite)
	}
	if errSync := tmp.Sync(); errSync != nil {
		_ = tmp.Close()
		return fmt.Errorf("quotapoll: sync temp file: %w", errSync)
	}
	if errClose := tmp.Close(); errClose != nil {
		return fmt.Errorf("quotapoll: close temp file: %w", errClose)
	}
	if errRename := os.Rename(tmpPath, path); errRename != nil {
		return fmt.Errorf("quotapoll: replace %s: %w", path, errRename)
	}
	committed = true
	return nil
}
