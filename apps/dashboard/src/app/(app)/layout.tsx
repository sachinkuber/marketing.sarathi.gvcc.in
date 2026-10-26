'use client'
import { Shell } from '../../frame/Shell'

// Every signed-in screen sits inside the shell: the session, the overdue watcher and the pop-up.
export default function SignedInLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>
}
