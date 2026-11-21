import type { JobContext } from '../src/runner.ts'

// The document methods of a stub context whose job lists no documents.
export const NO_DOCUMENTS: Pick<JobContext, 'document' | 'documents' | 'documentPart'> = {
  async document() {
    throw new Error('this job lists no documents')
  },
  async documents() {
    return []
  },
  async documentPart() {
    throw new Error('this job lists no documents')
  },
}
