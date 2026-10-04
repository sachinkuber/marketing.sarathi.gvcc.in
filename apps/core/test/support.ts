import type { Express } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TestServer {
  url: string
  close(): Promise<void>
}

export async function startTestServer(app: Express): Promise<TestServer> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
