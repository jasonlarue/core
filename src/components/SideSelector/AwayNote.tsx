'use client'

import { cn } from '@/lib/utils'
import { useSingleSleeperSide } from '@/src/providers/SideProvider'

/**
 * Light note for views that show only the single sleeper's side: says which
 * side is away. Renders nothing unless exactly one side is in away mode.
 */
export function AwayNote({ className }: { className?: string }) {
  const single = useSingleSleeperSide()
  if (!single) return null
  return (
    <span className={cn('text-xs text-fg-3', className)} data-testid="away-note">
      {`${single === 'left' ? 'Right' : 'Left'} side set to away`}
    </span>
  )
}
