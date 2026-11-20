import { fileURLToPath } from 'node:url'

export { agentFilesHash } from '../src/agent-files.ts'

export const SUMMARY_AGENT_DIR = fileURLToPath(new URL('../../../agents/summary', import.meta.url))
