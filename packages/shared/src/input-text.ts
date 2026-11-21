import { z } from 'zod'

// Text an agent's job input carries from the owner, research or the web. It is only bounded here, and reaches the
// model wrapped as data: refusing an owner's stray character would fail the job.
export const given = (max: number) => z.string().min(1).max(max)

// The input limits the questionnaire and the facts and rules inputs share (their briefs fix none): a brand's or a
// competitor's name, an address, and a profile value (an owner's edited value is at most 4,000 characters).
export const INPUT_NAME_MAX = 200
export const INPUT_ADDRESS_MAX = 2000
export const INPUT_VALUE_MAX = 4000
