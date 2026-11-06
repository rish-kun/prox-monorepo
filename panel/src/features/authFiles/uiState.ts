/**
 * The grouped auth-files page keeps no persisted view state. Earlier versions
 * stored filter/search/sort/pagination/compact preferences; drop those keys once.
 */
const LEGACY_KEYS = ['authFilesPage.uiState', 'authFilesPage.compactMode'];

export const clearLegacyAuthFilesUiState = () => {
  if (typeof window === 'undefined') return;
  try {
    LEGACY_KEYS.forEach((key) => {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    });
  } catch {
    // storage unavailable: nothing to clean
  }
};
