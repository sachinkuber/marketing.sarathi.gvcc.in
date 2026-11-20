'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { ApiError, api, upload } from '../api/client'
import {
  deletedReply,
  documentSummary,
  documentsReply,
  intakeSavedReply,
  onboardingReply,
  researchStartedReply,
} from '../api/schemas'
import { LoadError } from '../frame/LoadError'
import { useLoad } from '../api/use-load'
import { DOCUMENT_LIMITS, failureWords, isOpen, megabytes } from './onboarding-words'

type Doc = z.infer<typeof documentSummary>

interface Form {
  website: string
  socials: { instagram: string; facebook: string; linkedin: string; youtube: string }
  competitors: { name: string; website: string }[]
}

const SOCIALS = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'youtube', label: 'YouTube' },
] as const

const MAX_COMPETITORS = 5
const MAX_NAME = 200
const TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']

const EMPTY: Form = {
  website: '',
  socials: { instagram: '', facebook: '', linkedin: '', youtube: '' },
  competitors: [],
}

// What is sent: blank links and blank competitor rows are left out, and keys are in one fixed order, so the
// same intake always compares equal.
function payloadOf(form: Form) {
  const socials: Record<string, string> = {}
  for (const { key } of SOCIALS) {
    const value = form.socials[key].trim()
    if (value) socials[key] = value
  }
  const competitors = form.competitors
    .map((c) => ({ name: c.name.trim(), website: c.website.trim() }))
    .filter((c) => c.name !== '' || c.website !== '')
    .map((c) => (c.website ? { name: c.name, website: c.website } : { name: c.name }))
  return { website: form.website.trim(), socials, competitors }
}

type Saved = ReturnType<typeof payloadOf>

function formOf(intake: {
  website: string
  socials: Partial<Record<(typeof SOCIALS)[number]['key'], string>>
  competitors: { name: string; website?: string | undefined }[]
}): Form {
  return {
    website: intake.website,
    socials: {
      instagram: intake.socials.instagram ?? '',
      facebook: intake.socials.facebook ?? '',
      linkedin: intake.socials.linkedin ?? '',
      youtube: intake.socials.youtube ?? '',
    },
    competitors: intake.competitors.map((c) => ({ name: c.name, website: c.website ?? '' })),
  }
}

// The core's 400 invalid_request names each refused field by path ("competitors.1.website"); the form field
// that path belongs to, or null for a path this form has no field for.
function fieldIdOf(path: string): string | null {
  const parts = path.split('.')
  if (parts[0] === 'website' && parts.length === 1) return 'in-website'
  if (parts[0] === 'socials' && parts[1]) return `in-${parts[1]}`
  if (parts[0] === 'competitors' && parts[1] !== undefined && /^\d+$/.test(parts[1])) {
    return parts[2] ? `in-comp-${parts[1]}-${parts[2]}` : `in-comp-${parts[1]}-name`
  }
  return null
}

function refusedFields(error: unknown): { fields: Record<string, string>; rest: string | null } {
  const fields: Record<string, string> = {}
  let rest: string | null = null
  if (error instanceof ApiError && error.code === 'invalid_request' && Array.isArray(error.details)) {
    for (const issue of error.details as { path?: unknown; message?: unknown }[]) {
      const message = typeof issue.message === 'string' ? issue.message : 'Check this value.'
      const id = typeof issue.path === 'string' ? fieldIdOf(issue.path) : null
      if (id) fields[id] = message
      else rest = message
    }
    if (Object.keys(fields).length > 0 || rest) return { fields, rest }
  }
  return { fields, rest: failureWords(error, 'The intake could not be saved. Try again.') }
}

function TextField(props: {
  id: string
  label: string
  value: string
  placeholder?: string
  error: string | undefined
  onChange: (value: string) => void
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        className={`input onb-touch${props.error ? ' err' : ''}`}
        type="url"
        inputMode="url"
        autoComplete="off"
        placeholder={props.placeholder}
        value={props.value}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? `${props.id}-error` : undefined}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.error ? (
        <p className="errtext" id={`${props.id}-error`}>
          {props.error}
        </p>
      ) : null}
    </div>
  )
}

export function OnboardingIntakeScreen({ brandId }: { brandId: string }) {
  const router = useRouter()
  const overview = useLoad(() => api(onboardingReply, 'GET', `/brands/${brandId}/onboarding`), brandId)
  const docsLoad = useLoad(
    () => api(documentsReply, 'GET', `/brands/${brandId}/onboarding/documents`),
    brandId,
  )

  const [form, setForm] = useState<Form>(EMPTY)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [running, setRunning] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const [docs, setDocs] = useState<Doc[]>([])
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (overview.state !== 'ready') return
    if (overview.data.intake) {
      setForm(formOf(overview.data.intake))
      setSaved(payloadOf(formOf(overview.data.intake)))
    }
    setRunning(isOpen(overview.data.research))
  }, [overview.state, overview.data])
  useEffect(() => {
    if (docsLoad.state === 'ready') setDocs(docsLoad.data.documents)
  }, [docsLoad.state, docsLoad.data])

  const dirty = JSON.stringify(payloadOf(form)) !== JSON.stringify(saved)
  const canStart = saved !== null && saved.website !== '' && !dirty && !running && !busy

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    const body = payloadOf(form)
    setBusy(true)
    setFieldErrors({})
    setFormError(null)
    setNotice(null)
    try {
      const reply = await api(intakeSavedReply, 'PUT', `/brands/${brandId}/onboarding/intake`, body)
      const fresh = formOf(reply.intake)
      setForm(fresh)
      setSaved(payloadOf(fresh))
      setNotice('Saved. You can start research.')
    } catch (error) {
      const { fields, rest } = refusedFields(error)
      setFieldErrors(fields)
      setFormError(rest)
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    setBusy(true)
    setStartError(null)
    try {
      await api(researchStartedReply, 'POST', `/brands/${brandId}/onboarding/research`)
      router.push(`/b/${brandId}/onboarding/research`)
    } catch (error) {
      setStartError(failureWords(error, 'Research could not be started. Try again.'))
      if (error instanceof ApiError && error.code === 'research_running') setRunning(true)
    } finally {
      setBusy(false)
    }
  }

  const sendFiles = async (files: File[]) => {
    setDocError(null)
    for (const file of files) {
      // Checked here so nothing is sent for a file the core would refuse; the core's check is the authority.
      if (file.name.trim().length > MAX_NAME || file.name.trim().length === 0) {
        setDocError(
          `${file.name.slice(0, 40)}…: Rename the file to 200 characters or fewer, then upload it again.`,
        )
        continue
      }
      if (!TYPES.includes(file.type)) {
        setDocError(`${file.name}: Upload a PDF, PNG, JPEG or WebP file.`)
        continue
      }
      setUploading({ name: file.name, fraction: 0 })
      try {
        const made = await upload(
          documentSummary,
          `/brands/${brandId}/onboarding/documents`,
          file,
          (fraction) => setUploading({ name: file.name, fraction }),
        )
        setDocs((now) => [made, ...now.filter((d) => d.id !== made.id)])
      } catch (error) {
        setDocError(`${file.name}: ${failureWords(error, 'The file could not be uploaded. Try again.')}`)
      }
    }
    setUploading(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  const remove = async (doc: Doc) => {
    setRemoving(doc.id)
    setDocError(null)
    try {
      await api(deletedReply, 'DELETE', `/brands/${brandId}/onboarding/documents/${doc.id}`)
      setDocs((now) => now.filter((d) => d.id !== doc.id))
    } catch (error) {
      setDocError(`${doc.fileName}: ${failureWords(error, 'The file could not be removed. Try again.')}`)
    } finally {
      setRemoving(null)
    }
  }

  const setSocial = (key: (typeof SOCIALS)[number]['key'], value: string) =>
    setForm((f) => ({ ...f, socials: { ...f.socials, [key]: value } }))
  const setCompetitor = (i: number, patch: Partial<Form['competitors'][number]>) =>
    setForm((f) => ({
      ...f,
      competitors: f.competitors.map((c, at) => (at === i ? { ...c, ...patch } : c)),
    }))

  return (
    <main id="content" className="page narrow">
      <div className="page-head">
        <div>
          <h1>Onboarding intake</h1>
          <p>Give the research its starting points: the website, social links, competitors and documents.</p>
        </div>
      </div>

      {overview.state === 'error' ? (
        <LoadError what="the intake" error={overview.error} onRetry={overview.retry} />
      ) : null}

      <form className="panel pad stack" onSubmit={(event) => void save(event)} noValidate>
        <TextField
          id="in-website"
          label="Website"
          placeholder="https://"
          value={form.website}
          error={fieldErrors['in-website']}
          onChange={(website) => setForm((f) => ({ ...f, website }))}
        />
        <h2 className="onb-h">Social links (optional)</h2>
        {SOCIALS.map(({ key, label }) => (
          <TextField
            key={key}
            id={`in-${key}`}
            label={label}
            placeholder="https://"
            value={form.socials[key]}
            error={fieldErrors[`in-${key}`]}
            onChange={(value) => setSocial(key, value)}
          />
        ))}
        <h2 className="onb-h">Competitors (optional, up to {MAX_COMPETITORS})</h2>
        {form.competitors.map((c, i) => (
          <fieldset key={i} className="onb-comp">
            <legend>Competitor {i + 1}</legend>
            <div className="field">
              <label htmlFor={`in-comp-${i}-name`}>Name</label>
              <input
                id={`in-comp-${i}-name`}
                className={`input onb-touch${fieldErrors[`in-comp-${i}-name`] ? ' err' : ''}`}
                value={c.name}
                maxLength={120}
                aria-describedby={fieldErrors[`in-comp-${i}-name`] ? `in-comp-${i}-name-error` : undefined}
                onChange={(event) => setCompetitor(i, { name: event.target.value })}
              />
              {fieldErrors[`in-comp-${i}-name`] ? (
                <p className="errtext" id={`in-comp-${i}-name-error`}>
                  {fieldErrors[`in-comp-${i}-name`]}
                </p>
              ) : null}
            </div>
            <TextField
              id={`in-comp-${i}-website`}
              label="Website"
              placeholder="https://"
              value={c.website}
              error={fieldErrors[`in-comp-${i}-website`]}
              onChange={(website) => setCompetitor(i, { website })}
            />
            <button
              className="btn onb-touch"
              type="button"
              aria-label={`Remove competitor ${i + 1}`}
              onClick={() =>
                setForm((f) => ({ ...f, competitors: f.competitors.filter((_, at) => at !== i) }))
              }
            >
              Remove competitor
            </button>
          </fieldset>
        ))}
        {form.competitors.length < MAX_COMPETITORS ? (
          <div>
            <button
              className="btn onb-touch"
              type="button"
              onClick={() =>
                setForm((f) => ({ ...f, competitors: [...f.competitors, { name: '', website: '' }] }))
              }
            >
              Add a competitor
            </button>
          </div>
        ) : null}
        {formError ? (
          <p className="callout danger" role="alert">
            {formError}
          </p>
        ) : null}
        {notice ? (
          <p className="callout ok" role="status">
            {notice}
          </p>
        ) : null}
        <div>
          <button className="btn primary onb-touch" type="submit" disabled={busy}>
            Save intake
          </button>
        </div>
      </form>

      <section className="sec" aria-labelledby="h-docs">
        <div className="sec-head">
          <h2 id="h-docs">Documents</h2>
        </div>
        <div className="panel pad stack">
          <p className="sub">{DOCUMENT_LIMITS}</p>
          <div className="field">
            <label htmlFor="in-file">Add a file</label>
            <input
              id="in-file"
              ref={fileInput}
              className="input onb-touch"
              type="file"
              multiple
              accept="application/pdf,image/png,image/jpeg,image/webp"
              disabled={uploading !== null}
              onChange={(event) => void sendFiles([...(event.target.files ?? [])])}
            />
          </div>
          {uploading ? (
            <div role="status">
              <p className="small">
                {`Uploading ${uploading.name}… ${Math.round(uploading.fraction * 100)}%`}
              </p>
              <progress className="onb-bar" max={1} value={uploading.fraction} />
            </div>
          ) : null}
          {docError ? (
            <p className="callout danger" role="alert">
              {docError}
            </p>
          ) : null}
          {docsLoad.state === 'error' ? (
            <LoadError what="the documents" error={docsLoad.error} onRetry={docsLoad.retry} />
          ) : docs.length === 0 ? (
            <p className="muted">No files yet.</p>
          ) : (
            <ul className="list">
              {docs.map((doc) => (
                <li key={doc.id} className="wrap-row">
                  <div className="grow onb-wrap">
                    <b>{doc.fileName}</b>
                    <div className="muted small">
                      {megabytes(doc.sizeBytes)}
                      {doc.parts > 0
                        ? ` · Prepared in ${doc.parts} ${doc.parts === 1 ? 'part' : 'parts'}`
                        : ''}
                    </div>
                  </div>
                  <button
                    className="btn onb-touch"
                    type="button"
                    aria-label={`Remove ${doc.fileName}`}
                    disabled={removing !== null}
                    onClick={() => void remove(doc)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="sec" aria-labelledby="h-go">
        <div className="sec-head">
          <h2 id="h-go">Research</h2>
        </div>
        <div className="panel pad stack">
          <p className="sub">
            {running
              ? 'Research is already running for this brand. Wait for it to finish.'
              : saved === null
                ? 'Save the website first. Research starts from what is saved.'
                : dirty
                  ? 'You changed the intake. Save it, then start research.'
                  : 'Research reads the saved intake and the files above.'}
          </p>
          {startError ? (
            <p className="callout danger" role="alert">
              {startError}
            </p>
          ) : null}
          <div>
            <button
              className="btn primary onb-touch"
              type="button"
              disabled={!canStart}
              onClick={() => void start()}
            >
              Start research
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}
