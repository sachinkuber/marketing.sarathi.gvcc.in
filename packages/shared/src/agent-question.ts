import { z } from 'zod'
import { shown } from './visible-text.ts'

// What an agent asks the owner when its input cannot settle what blocks its output (spec 9), with why it asks
// and, where it can, options and a suggestion. The limits are the ones the core's question route takes.
// Ruling R7: an agent that may ask carries this as `ask` in its one result object (null when it does not
// ask), never as a second schema beside the result, so the provider schema has no anyOf at its root. With
// options, the suggestion is pre-selected among them, so it must be one of them (or null).
export const askSchema = z
  .strictObject({
    text: shown(500),
    why: shown(300),
    options: z.array(shown(200)).max(5),
    suggested: shown(500).nullable(),
  })
  .refine(
    (ask) => ask.options.length === 0 || ask.suggested === null || ask.options.includes(ask.suggested),
    { message: 'the suggestion is not one of the options', path: ['suggested'] },
  )
export type Ask = z.infer<typeof askSchema>
