import type { ApiError } from '../api/client'

// A failed load says what failed and offers a retry. Nothing fails silently.
export function LoadError(props: { what: string; error: ApiError | Error | null; onRetry: () => void }) {
  const detail =
    props.error && 'status' in props.error && props.error.status === 0
      ? ' The platform could not be reached.'
      : ''
  return (
    <div className="callout danger" role="alert">
      <b>Could not load {props.what}.</b>
      {detail}
      <div style={{ marginTop: 8 }}>
        <button className="btn sm" type="button" onClick={props.onRetry}>
          Try again
        </button>
      </div>
    </div>
  )
}
