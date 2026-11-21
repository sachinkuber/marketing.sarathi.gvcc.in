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

// The question methods of a stub context whose job has asked nothing and must not ask (spec 9).
export const NO_QUESTIONS: Pick<JobContext, 'answers' | 'ask'> = {
  answers: [],
  async ask() {
    throw new Error('this job may not ask a question')
  },
}
