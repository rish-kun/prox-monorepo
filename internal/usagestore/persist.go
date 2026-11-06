package usagestore

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	log "github.com/sirupsen/logrus"
)

const (
	fileVersion   = 1
	flushInterval = 30 * time.Second
)

type fileRow struct {
	Hour       int64  `json:"hour"`
	Provider   string `json:"provider"`
	AuthIndex  string `json:"auth_index"`
	Model      string `json:"model"`
	PromptTier int    `json:"prompt_tier"`
	Counters
}

type fileData struct {
	Version         int                `json:"version"`
	FirstRecordedAt int64              `json:"first_recorded_at"`
	Rows            []fileRow          `json:"rows"`
	Accounts        map[string]Account `json:"accounts"`
}

// PathForConfig returns the usage file location for a config file path:
// <dir of config file>/usage/hourly.usage. The extension is deliberately not
// ".json": the config directory is often also the auth directory, which is
// scanned recursively for *.json credential files.
func PathForConfig(configFilePath string) string {
	dir := filepath.Dir(configFilePath)
	if abs, errAbs := filepath.Abs(dir); errAbs == nil {
		dir = abs
	}
	return filepath.Join(dir, "usage", "hourly.usage")
}

// migrateLegacyPath renames a usage file written under the old hourly.json name
// next to path, so it stops being listed as a credential. It never overwrites.
func migrateLegacyPath(path string) {
	legacy := filepath.Join(filepath.Dir(path), "hourly.json")
	if legacy == path {
		return
	}
	if _, errStat := os.Stat(path); !errors.Is(errStat, fs.ErrNotExist) {
		return
	}
	if errRename := os.Rename(legacy, path); errRename == nil {
		log.Infof("usagestore: moved %s to %s", legacy, path)
	} else if !errors.Is(errRename, fs.ErrNotExist) {
		log.WithError(errRename).Warn("usagestore: failed to move legacy usage file")
	}
}

// Open loads the store from path (a missing file yields an empty store, a
// corrupt file is renamed aside) and starts the background flusher.
func Open(path string) (*Store, error) {
	migrateLegacyPath(path)
	s, errLoad := newStore(path, time.Now)
	if errLoad != nil {
		return nil, errLoad
	}
	s.stopCh = make(chan struct{})
	s.doneCh = make(chan struct{})
	go s.flushLoop()
	return s, nil
}

func newStore(path string, now func() time.Time) (*Store, error) {
	if path == "" {
		return nil, errors.New("usagestore: empty path")
	}
	s := &Store{
		path:     path,
		now:      now,
		rows:     make(map[rowKey]*Counters),
		accounts: make(map[string]Account),
	}
	if errLoad := s.load(); errLoad != nil {
		return nil, errLoad
	}
	if s.firstRecordedAt == 0 {
		s.firstRecordedAt = now().Unix()
		s.dirty = true
	}
	return s, nil
}

func (s *Store) load() error {
	raw, errRead := os.ReadFile(s.path)
	if errRead != nil {
		if errors.Is(errRead, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("usagestore: read %s: %w", s.path, errRead)
	}
	var data fileData
	errParse := json.Unmarshal(raw, &data)
	if errParse == nil && data.Version != fileVersion {
		errParse = fmt.Errorf("unsupported version %d", data.Version)
	}
	if errParse != nil {
		corruptPath := fmt.Sprintf("%s.corrupt-%d", s.path, s.now().Unix())
		log.WithError(errParse).Warnf("usagestore: usage file is corrupt; moving it to %s and starting empty", corruptPath)
		if errRename := os.Rename(s.path, corruptPath); errRename != nil {
			log.WithError(errRename).Warn("usagestore: failed to move corrupt usage file aside")
		}
		return nil
	}
	s.firstRecordedAt = data.FirstRecordedAt
	for _, row := range data.Rows {
		key := rowKey{hour: row.Hour, provider: row.Provider, authIndex: row.AuthIndex, model: row.Model, promptTier: row.PromptTier}
		counters := s.rows[key]
		if counters == nil {
			counters = &Counters{}
			s.rows[key] = counters
		}
		counters.add(row.Counters)
	}
	for authIndex, account := range data.Accounts {
		s.accounts[authIndex] = account
	}
	return nil
}

func (s *Store) flushLoop() {
	defer close(s.doneCh)
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			if errFlush := s.Flush(); errFlush != nil {
				log.WithError(errFlush).Warn("usagestore: periodic flush failed")
			}
		}
	}
}

// Flush writes the store to disk atomically when it has unsaved changes.
func (s *Store) Flush() error {
	if s == nil {
		return nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return nil
	}
	data := s.snapshotLocked()
	s.dirty = false
	s.mu.Unlock()

	if errWrite := writeAtomic(s.path, data); errWrite != nil {
		s.mu.Lock()
		s.dirty = true
		s.mu.Unlock()
		return errWrite
	}
	return nil
}

// Close stops the background flusher and writes pending changes. Records
// handled after Close stay in memory only.
func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		if s.stopCh != nil {
			close(s.stopCh)
			<-s.doneCh
		}
		s.closeErr = s.Flush()
	})
	return s.closeErr
}

func (s *Store) snapshotLocked() fileData {
	data := fileData{
		Version:         fileVersion,
		FirstRecordedAt: s.firstRecordedAt,
		Rows:            make([]fileRow, 0, len(s.rows)),
		Accounts:        make(map[string]Account, len(s.accounts)),
	}
	for key, counters := range s.rows {
		data.Rows = append(data.Rows, fileRow{
			Hour:       key.hour,
			Provider:   key.provider,
			AuthIndex:  key.authIndex,
			Model:      key.model,
			PromptTier: key.promptTier,
			Counters:   *counters,
		})
	}
	sortFileRows(data.Rows)
	for authIndex, account := range s.accounts {
		data.Accounts[authIndex] = account
	}
	return data
}

func writeAtomic(path string, data fileData) error {
	raw, errMarshal := json.Marshal(data)
	if errMarshal != nil {
		return fmt.Errorf("usagestore: encode: %w", errMarshal)
	}
	dir := filepath.Dir(path)
	if errMkdir := os.MkdirAll(dir, 0o700); errMkdir != nil {
		return fmt.Errorf("usagestore: create dir %s: %w", dir, errMkdir)
	}
	tmp, errCreate := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if errCreate != nil {
		return fmt.Errorf("usagestore: create temp file: %w", errCreate)
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			if errRemove := os.Remove(tmpPath); errRemove != nil && !errors.Is(errRemove, fs.ErrNotExist) {
				log.WithError(errRemove).Warn("usagestore: failed to remove temp file")
			}
		}
	}()
	if errChmod := tmp.Chmod(0o600); errChmod != nil {
		_ = tmp.Close()
		return fmt.Errorf("usagestore: chmod temp file: %w", errChmod)
	}
	if _, errWrite := tmp.Write(raw); errWrite != nil {
		_ = tmp.Close()
		return fmt.Errorf("usagestore: write temp file: %w", errWrite)
	}
	if errSync := tmp.Sync(); errSync != nil {
		_ = tmp.Close()
		return fmt.Errorf("usagestore: sync temp file: %w", errSync)
	}
	if errClose := tmp.Close(); errClose != nil {
		return fmt.Errorf("usagestore: close temp file: %w", errClose)
	}
	if errRename := os.Rename(tmpPath, path); errRename != nil {
		return fmt.Errorf("usagestore: replace %s: %w", path, errRename)
	}
	committed = true
	return nil
}
