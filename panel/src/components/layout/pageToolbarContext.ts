import { createContext } from 'react';

/**
 * Registers a page-header slot with MainLayout; returns the unregister callback.
 * MainLayout portals the app toolbar (refresh / language / theme / logout) into
 * the slot so it sits in the page's header row and scrolls with the page instead
 * of floating over content.
 */
export type RegisterPageToolbarSlot = (slot: HTMLElement) => () => void;

export const PageToolbarContext = createContext<RegisterPageToolbarSlot | null>(null);
