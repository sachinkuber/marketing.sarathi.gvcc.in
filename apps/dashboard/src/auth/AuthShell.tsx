export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main id="content" className="bare">
      <div className="side">
        <div className="row strong">Marketing platform</div>
        <div>
          <h2>Marketing work, done and checked. You approve.</h2>
          <p>Sign in to see results, approve what goes live, and step in when a lead needs a person.</p>
        </div>
        <div />
      </div>
      <div className="main">
        <div className="box">{children}</div>
      </div>
    </main>
  )
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <div className="callout danger" role="alert">
      <b>{error}</b>
    </div>
  )
}
