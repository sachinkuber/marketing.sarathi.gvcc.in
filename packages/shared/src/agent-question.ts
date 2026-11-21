import { z } from 'zod'
import { DISALLOWED } from './disallowed.ts'

// Text the owner will read: not blank, and without the invisible and control characters the payload refuses.
const NOT_VISIBLE = 'is blank or contains an invisible or control character'
const shown = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !DISALLOWED.test(value) && value.trim() !== '', NOT_VISIBLE)

// What an agent asks the owner when its input cannot settle what blocks its output (spec 9), with why it asks
// and, where it can, options and a suggestion. The limits are the ones the core's question route takes.
// Ruling R7: an agent that may ask carries this as `ask` in its one result object (null when it does not ask),
// never as a second schema beside the result, so the provider schema has no anyOf at its root.
export const askSchema = z.strictObject({
  text: shown(500),
  why: shown(300),
  options: z.array(shown(200)).max(5),
  suggested: shown(500).nullable(),
})
export type Ask = z.infer<typeof askSchema>
