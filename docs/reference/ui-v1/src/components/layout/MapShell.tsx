import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Map-first layout for the rider and captain apps.
 * Phone: full-bleed map, floating top bar, bottom sheet (collapsible) with the primary action pinned in thumb reach.
 * Desktop (md+): the same panel floats as a 400px card over the left of the map.
 */
export function MapShell({ map, topLeft, topRight, children, footer, label, dim = false, tall = false }: {
  map: ReactNode; topLeft?: ReactNode; topRight?: ReactNode; children: ReactNode; footer?: ReactNode; label: string
  /** first-run: map stays in the background until the user has said where they're going */
  dim?: boolean; tall?: boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="relative isolate h-dvh overflow-hidden bg-background">
      <div className="absolute inset-0">{map}</div>
      <div aria-hidden className={cn('pointer-events-none absolute inset-0 z-[450] bg-background motion-safe:transition-opacity motion-safe:duration-500', dim ? 'opacity-70' : 'opacity-0')} />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-[1000] flex items-start justify-between gap-2 px-3 pt-[calc(env(safe-area-inset-top)+12px)] md:px-4 md:pt-4">
        <div className="pointer-events-auto flex h-11 items-center gap-2 rounded-full bg-background/95 pr-2 pl-3 shadow-md ring-1 ring-foreground/5 backdrop-blur">{topLeft}</div>
        <div className="pointer-events-auto flex h-11 items-center gap-1 rounded-full bg-background/95 px-1.5 shadow-md ring-1 ring-foreground/5 backdrop-blur">{topRight}</div>
      </div>

      <section aria-label={label}
        className={cn(
          'absolute inset-x-0 bottom-0 z-[1000] flex max-h-[72dvh] flex-col rounded-t-3xl bg-background shadow-[0_-8px_32px_-8px_rgb(0_0_0/0.18)]',
          'motion-safe:transition-[max-height] motion-safe:duration-300 motion-safe:ease-out',
          'md:inset-x-auto md:top-[76px] md:bottom-auto md:left-4 md:max-h-[calc(100dvh-92px)] md:w-[400px] md:rounded-2xl md:shadow-xl md:ring-1 md:ring-foreground/5',
          tall && !collapsed && 'max-h-[88dvh]',
          collapsed && 'max-h-[30dvh]',
        )}>
        <button type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel to see the map'}
          className="mx-auto flex h-6 w-16 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden">
          <span className="h-1 w-9 rounded-full bg-foreground/20" />
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 md:px-5 md:pt-5">{children}</div>
        {footer && <div className="shrink-0 border-t bg-background px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)] md:rounded-b-2xl md:px-5">{footer}</div>}
      </section>
    </div>
  )
}
