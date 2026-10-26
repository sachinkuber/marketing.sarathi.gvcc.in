import { useForm } from 'react-hook-form'
import type { EditValues } from './item-actions'

const KEYWORD_MAX = 60

// The approver's own edit (app-flow 5.6 step 6): saved as a new version, which goes through the checks again
// before it can be approved.
export function EditForm(props: {
  initial: EditValues
  busy: boolean
  onSave: (values: EditValues) => void
  onCancel: () => void
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EditValues>({ defaultValues: props.initial })
  return (
    <form className="panel pad stack" onSubmit={handleSubmit(props.onSave)} noValidate>
      <h3 className="strong">Edit as a new version</h3>
      <div className="field">
        <label htmlFor="edit-title">Title</label>
        <input
          id="edit-title"
          className={errors.title ? 'input err' : 'input'}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? 'edit-title-error' : undefined}
          {...register('title', { validate: (v) => v.trim().length > 0 || 'A title is needed.' })}
        />
        {errors.title ? (
          <p className="errtext" id="edit-title-error">
            {errors.title.message}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="edit-summary">Summary</label>
        <textarea
          id="edit-summary"
          className={errors.summary ? 'input err' : 'input'}
          aria-invalid={errors.summary ? true : undefined}
          aria-describedby={errors.summary ? 'edit-summary-error' : undefined}
          {...register('summary', { validate: (v) => v.trim().length > 0 || 'The summary cannot be empty.' })}
        />
        {errors.summary ? (
          <p className="errtext" id="edit-summary-error">
            {errors.summary.message}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="edit-keywords">Keywords</label>
        <span className="hint" id="edit-keywords-hint">
          One per line, each up to {KEYWORD_MAX} characters.
        </span>
        <textarea
          id="edit-keywords"
          className={errors.keywords ? 'input err' : 'input'}
          aria-invalid={errors.keywords ? true : undefined}
          aria-describedby={errors.keywords ? 'edit-keywords-hint edit-keywords-error' : 'edit-keywords-hint'}
          {...register('keywords', {
            validate: (v) => {
              const lines = v
                .split('\n')
                .map((k) => k.trim())
                .filter((k) => k.length > 0)
              if (lines.length === 0) return 'Give at least one keyword.'
              if (lines.some((k) => k.length > KEYWORD_MAX))
                return `Keep each keyword under ${KEYWORD_MAX} characters.`
              return true
            },
          })}
        />
        {errors.keywords ? (
          <p className="errtext" id="edit-keywords-error">
            {errors.keywords.message}
          </p>
        ) : null}
      </div>
      <div className="row">
        <button className="btn primary" type="submit" disabled={props.busy}>
          Save as a new version
        </button>
        <button className="btn" type="button" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}
