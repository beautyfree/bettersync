export default function Home() {
  return (
    <div style={{ padding: 40, maxWidth: 600, margin: '0 auto' }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>better-sync demo</h1>
      <p style={{ color: '#888', marginBottom: 24 }}>
        Open this page in two tabs. Add a todo in one — it appears in the other.
        Turn off network in devtools, add more todos, turn network back on — they sync.
      </p>
      <a href="/sync-demo" style={{ color: '#e94560', fontSize: 18 }}>
        → Open sync demo
      </a>
    </div>
  )
}
