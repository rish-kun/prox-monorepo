import { useContext, useLayoutEffect, useRef } from 'react';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { PageToolbarContext } from './pageToolbarContext';

type PageToolbarSlotProps = {
  className?: string;
};

/**
 * Place at the end of a page's header row; MainLayout portals the app toolbar into it on
 * desktop. Only the slot in the current page-transition layer claims the toolbar (exiting /
 * stacked layers stay empty). Pages without a slot get the toolbar in a right-aligned row
 * above the page.
 */
export function PageToolbarSlot({ className }: PageToolbarSlotProps) {
  const register = useContext(PageToolbarContext);
  const layer = usePageTransitionLayer();
  const isCurrentLayer = layer?.isCurrentLayer ?? true;
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!register || !node || !isCurrentLayer) return undefined;
    return register(node);
  }, [register, isCurrentLayer]);

  return (
    <div ref={ref} className={className ? `page-toolbar-slot ${className}` : 'page-toolbar-slot'} />
  );
}
