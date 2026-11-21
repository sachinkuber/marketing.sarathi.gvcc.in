import { z } from 'zod'
import { DISALLOWED } from './disallowed.ts'

// Text the owner will read: not blank, and without the invisible and control characters the payload refuses.
export const NOT_VISIBLE = 'is blank or contains an invisible or control character'
export const visible = (value: string): boolean => !DISALLOWED.test(value) && value.trim() !== ''
export const shown = (max: number) => z.string().min(1).max(max).refine(visible, NOT_VISIBLE)
