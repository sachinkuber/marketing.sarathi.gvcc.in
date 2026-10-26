import type { Metadata, Viewport } from 'next'
import { connection } from 'next/server'
import '../styles/globals.css'

export const metadata: Metadata = { title: 'Marketing platform', robots: { index: false, follow: false } }
export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Every page is rendered per request, so Next.js can put the request's nonce on its scripts (src/proxy.ts).
  await connection()
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
