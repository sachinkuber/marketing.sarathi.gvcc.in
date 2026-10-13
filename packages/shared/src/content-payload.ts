import { z } from 'zod'

export const HASH_SCHEME = 'cv1'
export const PAYLOAD_SCHEMA = 'content-version/1'

// The values of the database enum app.content_kind (packages/db/migrations/0002_enums_tenancy.sql).
export const CONTENT_KINDS = [
  'summary',
  'article',
  'answer_page',
  'social_post',
  'carousel',
  'short_video',
  'long_video',
  'email',
  'ad',
  'landing_page',
  'reply',
  'strategy_brief',
  'campaign',
  'correction',
] as const

const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const SHA256 = /^sha256:[0-9a-f]{64}$/
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

const text = z.string().min(1)
const id = z.uuid()
const hash = z.string().regex(SHA256)
// A time in UTC to the second that is a real moment (not 31 February).
const time = z
  .string()
  .regex(UTC_SECOND)
  .refine((value) => {
    const parsed = new Date(value)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) + 'Z' === value
  }, 'not a real time')
const nonEmpty = <T extends z.ZodType>(item: T) => z.array(item).min(1)

export const bodyBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('paragraph'), text }),
  z.strictObject({ type: z.literal('heading'), level: z.int().min(1).max(3), text }),
  z.strictObject({ type: z.literal('quote'), text }),
  z.strictObject({ type: z.literal('list'), ordered: z.boolean(), items: nonEmpty(text) }),
  z.strictObject({ type: z.literal('image'), asset_id: id }),
])
export type BodyBlock = z.infer<typeof bodyBlockSchema>

// Every field that can affect what is published, to whom, or where (spec 10.3). kind_specific is added
// with the first kind that needs it.
export const contentPayloadSchema = z.strictObject({
  schema: z.literal(PAYLOAD_SCHEMA),
  brand_id: id,
  content_item_id: id,
  kind: z.enum(CONTENT_KINDS),
  language: z.string().regex(LANGUAGE),
  targets: nonEmpty(z.strictObject({ platform: text, connection_id: id, format: text })).optional(),
  title: text.optional(),
  summary: text.optional(),
  body: nonEmpty(bodyBlockSchema),
  caption: text.optional(),
  hashtags: nonEmpty(text).optional(),
  call_to_action: text.optional(),
  links: nonEmpty(z.strictObject({ url: text, role: text })).optional(),
  assets: nonEmpty(
    z.strictObject({
      asset_id: id,
      sha256: hash,
      byte_length: z.int().min(0),
      media_type: text,
      role: text,
      alt: text.optional(),
    }),
  ).optional(),
  fact_refs: nonEmpty(z.strictObject({ fact_id: id, text_hash: hash })).optional(),
  disclosures: nonEmpty(text).optional(),
  publish_window: z
    .strictObject({ earliest: time.optional(), latest: time.optional() })
    .refine((w) => w.earliest !== undefined || w.latest !== undefined, 'a window needs at least one end')
    .refine(
      (w) => w.earliest === undefined || w.latest === undefined || w.earliest <= w.latest,
      'the window ends before it starts',
    )
    .optional(),
})
export type ContentPayload = z.infer<typeof contentPayloadSchema>
