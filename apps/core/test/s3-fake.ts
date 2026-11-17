import type { PutObjectCommand } from '@aws-sdk/client-s3'
import type { S3Like } from '../src/audit/s3-store.ts'

export interface Stored {
  body: string
  input: Record<string, unknown>
}

// An in-memory bucket speaking the three commands the store sends. Lists pages of `pageSize`, so paging is exercised.
export class FakeS3 implements S3Like {
  readonly objects = new Map<string, Stored>()
  readonly sent: Array<{ command: string; input: Record<string, unknown> }> = []
  private readonly pageSize: number
  constructor(pageSize = 2) {
    this.pageSize = pageSize
  }

  async send(sent: Parameters<S3Like['send']>[0]): Promise<unknown> {
    const command = sent as PutObjectCommand
    const name = command.constructor.name
    const input = command.input as unknown as Record<string, unknown>
    this.sent.push({ command: name, input })
    if (name === 'PutObjectCommand') {
      const key = String(input.Key)
      if (input.IfNoneMatch === '*' && this.objects.has(key)) {
        throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        })
      }
      this.objects.set(key, { body: String(input.Body), input })
      return {}
    }
    if (name === 'ListObjectsV2Command') {
      const prefix = String(input.Prefix ?? '')
      const delimiter = input.Delimiter as string | undefined
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const entries: Array<{ Key?: string; Prefix?: string }> = []
      const seen = new Set<string>()
      for (const key of keys) {
        const rest = key.slice(prefix.length)
        const at = delimiter ? rest.indexOf(delimiter) : -1
        if (at === -1) entries.push({ Key: key })
        else {
          const common = prefix + rest.slice(0, at + 1)
          if (!seen.has(common)) {
            seen.add(common)
            entries.push({ Prefix: common })
          }
        }
      }
      const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0
      const page = entries.slice(start, start + this.pageSize)
      const more = start + this.pageSize < entries.length
      return {
        Contents: page.filter((e) => e.Key).map((e) => ({ Key: e.Key })),
        CommonPrefixes: page.filter((e) => e.Prefix).map((e) => ({ Prefix: e.Prefix })),
        IsTruncated: more,
        NextContinuationToken: more ? String(start + this.pageSize) : undefined,
      }
    }
    throw new Error(`unexpected command ${name}`)
  }
}
