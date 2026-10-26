'use client'
import { createContext, useContext } from 'react'

export interface FrameValue {
  // Reads the brand's status again now, so the banner follows a kill-switch or shadow-mode change at once
  // instead of at the next poll. It never throws: a failed read leaves the banner to the next poll.
  refreshStatus: () => Promise<void>
}

// Outside a brand's frame there is no banner to refresh.
const NONE: FrameValue = { refreshStatus: async () => {} }

export const FrameContext = createContext<FrameValue>(NONE)

export function useFrame(): FrameValue {
  return useContext(FrameContext)
}
