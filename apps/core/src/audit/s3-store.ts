import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { errorName } from '../notify/ports.ts'
import type { ExportBatch, ExportMark, ExportStore } from './store.ts'

// The part of S3Client the store uses, so tests hand in an in-memory bucket.
export interface S3Like {
  send(command: PutObjectCommand | ListObjectsV2Command | GetObjectCommand): Promise<unknown>
}

export interface S3ExportStoreOptions {
  client: S3Like
  bucket: string
  retentionDays: number
  // true: send the compliance-mode lock headers with every object (a bucket with Object Lock). false: write-once
  // at the API only (If-None-Match) and rely on the bucket's own lock rule for retention (R2).
  objectLock: boolean
  now?: () => Date
}

interface ListPage {
  Contents?: Array<{ Key?: string }>
  CommonPrefixes?: Array<{ Prefix?: string }>
  IsTruncated?: boolean
  NextContinuationToken?: string
}

const DAY_MS = 86_400_000
const ROOT = 'audit/'

// Builds the client for an S3-compatible endpoint (R2, MinIO, S3). Credentials stay inside the SDK.
export function createS3Client(opts: { url: string; keyId: string; secret: string }): S3Client {
  return new S3Client({
    endpoint: opts.url,
    region: 'auto',
    forcePathStyle: true,
    credentials: { accessKeyId: opts.keyId, secretAccessKey: opts.secret },
  })
}

// Errors keep their name and code only: a provider message can echo a URL, a key or the object.
function fail(action: string, error: unknown): Error {
  return new Error(`the audit store could not ${action}: ${errorName(error)}`)
}

function isPreconditionFailed(error: unknown): boolean {
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412
}

// Write-once audit copies in an S3-compatible bucket: audit/<chainKey>/<throughSeq>-<headHash>.jsonl.
// The hash is part of the key, so the same chain and throughSeq with another hash is a different key; the store
// looks for that first and refuses it, since a chain has one copy per throughSeq.
export class S3ExportStore implements ExportStore {
  private readonly client: S3Like
  private readonly bucket: string
  private readonly retentionDays: number
  private readonly objectLock: boolean
  private readonly now: () => Date

  constructor(opts: S3ExportStoreOptions) {
    if (!opts.bucket) throw new Error('the audit store needs a bucket')
    if (!Number.isInteger(opts.retentionDays) || opts.retentionDays < 1) {
      throw new Error('the audit store needs a retention of at least one day')
    }
    this.client = opts.client
    this.bucket = opts.bucket
    this.retentionDays = opts.retentionDays
    this.objectLock = opts.objectLock
    this.now = opts.now ?? (() => new Date())
  }

  async put(batch: ExportBatch): Promise<string> {
    const held = await this.heldFor(batch)
    if (held) return held
    const key = this.keyOf(batch.chainKey, batch.throughSeq, batch.headHash)
    const body =
      batch.entries.map((entry) => JSON.stringify(entry)).join('\n') + (batch.entries.length ? '\n' : '')
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/x-ndjson',
          IfNoneMatch: '*',
          ...(this.objectLock
            ? {
                ObjectLockMode: 'COMPLIANCE' as const,
                ObjectLockRetainUntilDate: new Date(this.now().getTime() + this.retentionDays * DAY_MS),
              }
            : {}),
        }),
      )
    } catch (error) {
      if (!isPreconditionFailed(error)) throw fail('store the copy', error)
      // Someone stored this key after we looked: same hash is a repeat, any other hash is refused.
      const raced = await this.heldFor(batch)
      if (!raced) throw fail('store the copy', error)
      return raced
    }
    return this.locationOf(key)
  }

  async marks(chainKey: string): Promise<ExportMark[]> {
    const prefix = `${ROOT}${chainKey}/`
    const marks: ExportMark[] = []
    for await (const page of this.pages(prefix, undefined)) {
      for (const item of page.Contents ?? []) {
        const parsed = item.Key ? parseKey(item.Key.slice(prefix.length)) : null
        if (!parsed) continue
        marks.push({
          chainKey,
          throughSeq: parsed.throughSeq,
          chainHash: parsed.headHash,
          location: this.locationOf(item.Key!),
        })
      }
    }
    return marks.sort((a, b) => a.throughSeq - b.throughSeq)
  }

  async chainKeys(): Promise<string[]> {
    const keys: string[] = []
    for await (const page of this.pages(ROOT, '/')) {
      for (const item of page.CommonPrefixes ?? []) {
        if (item.Prefix) keys.push(item.Prefix.slice(ROOT.length, -1))
      }
    }
    return keys.sort()
  }

  // The location of an object already held for this chain and throughSeq: this batch's own (a repeat), or a throw
  // if it holds another hash. Null when nothing is held.
  private async heldFor(batch: ExportBatch): Promise<string | null> {
    const prefix = `${ROOT}${batch.chainKey}/${batch.throughSeq}-`
    for await (const page of this.pages(prefix, undefined)) {
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue
        const parsed = parseKey(item.Key.slice(`${ROOT}${batch.chainKey}/`.length))
        if (parsed?.throughSeq !== batch.throughSeq) continue
        if (parsed.headHash !== batch.headHash) {
          throw new Error(
            `the store already holds ${batch.chainKey}/${batch.throughSeq} with a different hash and will not overwrite it`,
          )
        }
        return this.locationOf(item.Key)
      }
    }
    return null
  }

  private async *pages(prefix: string, delimiter: string | undefined): AsyncGenerator<ListPage> {
    let token: string | undefined
    do {
      let page: ListPage
      try {
        page = (await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ...(delimiter ? { Delimiter: delimiter } : {}),
            ContinuationToken: token,
          }),
        )) as ListPage
      } catch (error) {
        throw fail('list the copies', error)
      }
      yield page
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }

  private keyOf(chainKey: string, throughSeq: number, headHash: string): string {
    return `${ROOT}${chainKey}/${throughSeq}-${headHash}.jsonl`
  }

  private locationOf(key: string): string {
    return `s3://${this.bucket}/${key}`
  }
}

// "<throughSeq>-<headHash>.jsonl" -> its parts; anything else under the prefix is not ours.
function parseKey(name: string): { throughSeq: number; headHash: string } | null {
  const match = /^(\d+)-(.+)\.jsonl$/.exec(name)
  if (!match) return null
  return { throughSeq: Number(match[1]), headHash: match[2]! }
}
