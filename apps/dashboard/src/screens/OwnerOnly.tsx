import { OWNER_ONLY } from './onboarding-words'

// What a person without the permission sees instead of an onboarding screen: the one sentence, nothing to use.
export function OwnerOnly() {
  return (
    <main id="content" className="page">
      <div className="callout warn" role="alert">
        {OWNER_ONLY}
      </div>
    </main>
  )
}
