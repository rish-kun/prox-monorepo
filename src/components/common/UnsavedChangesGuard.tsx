import {
  useUnsavedChangesGuard,
  type UseUnsavedChangesGuardOptions,
} from '@/hooks/useUnsavedChangesGuard';

/**
 * Registers the unsaved-changes blocker only while it is rendered.
 *
 * React Router drops POP navigations (back/forward, a typed URL, an external
 * hash change) whenever any blocker is registered — even one that returns
 * false — because hash entries created outside the router carry no history
 * index to revert to. Render this only while there are unsaved changes so
 * ordinary navigation keeps working the rest of the time.
 */
export function UnsavedChangesGuard(props: UseUnsavedChangesGuardOptions) {
  useUnsavedChangesGuard(props);
  return null;
}
