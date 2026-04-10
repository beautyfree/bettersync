import type { ReactNode } from 'react'
import { SyncClientProvider } from '@/components/sync-provider'

export const metadata = {
  title: 'bettersync demo',
  description: 'Two-tab live sync with PGlite + bettersync',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#eee' }}>
        <SyncClientProvider>{children}</SyncClientProvider>
      </body>
    </html>
  )
}
