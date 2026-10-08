export interface ExportedRow {
  seq: number
  at: string
  actor_kind: string
  actor_id: string | null
  action: string
  outcome: string
  subject: string | null
  detail: unknown
  prev_hash: string | null
  hash: string
}

export interface ExportBatch {
  chainKey: string
  fromSeq: number
  throughSeq: number
  headHash: string
  entries: ExportedRow[]
}

export interface ExportMark {
  chainKey: string
  throughSeq: number
  chainHash: string
  location: string
}

// Storage outside the server that does not allow a copy to be overwritten or deleted (architecture 13.8).
// The real store arrives with deployment (owner items A4 and A5); until then tests use MemoryExportStore.
export interface ExportStore {
  // Write-once. Putting the same chain and throughSeq again with the same headHash returns the same
  // location (so a run that crashed after storing can be repeated). With a different headHash it throws.
  put(batch: ExportBatch): Promise<string>
  marks(chainKey: string): Promise<ExportMark[]>
  chainKeys(): Promise<string[]>
}

export class MemoryExportStore implements ExportStore {
  private readonly held = new Map<string, ExportMark & { batch: ExportBatch }>()

  async put(batch: ExportBatch): Promise<string> {
    const key = `${batch.chainKey}/${batch.throughSeq}`
    const existing = this.held.get(key)
    if (existing) {
      if (existing.chainHash !== batch.headHash) {
        throw new Error(`the store already holds ${key} with a different hash and will not overwrite it`)
      }
      return existing.location
    }
    const location = `memory://${key}`
    this.held.set(key, {
      chainKey: batch.chainKey,
      throughSeq: batch.throughSeq,
      chainHash: batch.headHash,
      location,
      batch,
    })
    return location
  }

  async marks(chainKey: string): Promise<ExportMark[]> {
    return [...this.held.values()]
      .filter((entry) => entry.chainKey === chainKey)
      .map(({ chainKey: key, throughSeq, chainHash, location }) => ({
        chainKey: key,
        throughSeq,
        chainHash,
        location,
      }))
      .sort((a, b) => a.throughSeq - b.throughSeq)
  }

  async chainKeys(): Promise<string[]> {
    return [...new Set([...this.held.values()].map((entry) => entry.chainKey))].sort()
  }
}
