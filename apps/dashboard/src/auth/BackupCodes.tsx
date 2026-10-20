'use client'
import { useState } from 'react'

export function BackupCodes({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const [saved, setSaved] = useState(false)
  return (
    <section className="stack" aria-labelledby="s2">
      <h2 className="stepno" id="s2">
        Save your backup codes
      </h2>
      <div className="callout warn">
        <b>These are shown only once.</b> Each code works one time if you lose your phone. Store them
        somewhere safe, such as a password manager.
      </div>
      <div className="codes" aria-label="Backup codes">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="checks">
        <label>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved
          these codes
        </label>
      </div>
      <button className="btn primary block" type="button" disabled={!saved} onClick={onContinue}>
        Continue
      </button>
      <p className="muted small">
        Continue turns on once the box is ticked. If you leave now, your next sign-in returns here.
      </p>
    </section>
  )
}
