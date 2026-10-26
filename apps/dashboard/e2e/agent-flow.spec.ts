import { expect, test } from '@playwright/test'
import { codeFor, makeBrand, makeUser, signIn, unique } from './control.ts'

// Acceptance test 37 through the screens: a brief goes in, an item comes out and is approved, the run shows
// its two jobs, one model call and its cost in both currencies, the audit screen tells the story, and the
// kill switch can be set and released with a fresh code.
test('the platform owner starts the summary agent, approves its item, reads the run and the audit log, and uses the kill switch', async ({
  page,
}) => {
  const brandId = await makeBrand(unique('agent'))
  const owner = await makeUser({
    email: `${unique('owner')}@e2e.test`,
    platformOwner: true,
    enrolled: true,
  })
  const secret = owner.secret as string

  await signIn(page, owner)

  // Start the agent.
  await page.goto(`/b/${brandId}/agents`)
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await page.getByLabel('Brief').fill('Launch of the monsoon range, two lines, friendly tone.')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Started.' })).toBeVisible()
  const runPath = await page.getByRole('link', { name: 'Open the run' }).getAttribute('href')
  expect(runPath).toMatch(new RegExp(`^/b/${brandId}/agents/runs/`))

  // The item appears in the inbox once the worker has made it and its check has passed.
  await page.goto(`/b/${brandId}/inbox`)
  await expect(async () => {
    await page.reload()
    await expect(page.getByRole('link', { name: 'Summary of the brief' })).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 3_000] })

  // Open it and approve it.
  await page.getByRole('link', { name: 'Summary of the brief' }).click()
  await expect(page.getByText('A short, friendly summary.').first()).toBeVisible()
  await expect(page.getByText('Length check')).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByRole('status')).toContainText('Approved.')

  // The run: two jobs, one model call, the cost in dollars and rupees.
  await page.goto(runPath as string)
  await expect(page.getByRole('heading', { name: 'Run of the Summary agent', level: 1 })).toBeVisible()
  const jobs = page.locator('section[aria-labelledby="h-jobs"] tbody tr')
  await expect(jobs).toHaveCount(2)
  await expect(jobs.filter({ hasText: 'summary.v1' })).toHaveCount(1)
  await expect(jobs.filter({ hasText: 'placeholder_check.v1' })).toHaveCount(1)
  const calls = page.locator('section[aria-labelledby="h-calls"] tbody tr')
  await expect(calls).toHaveCount(1)
  await expect(calls.first()).toContainText('Summarise')
  await expect(calls.first()).toContainText('$0.014000 · ₹1.169000')
  await expect(page.locator('dl.kv')).toContainText('$0.014000 · ₹1.169000')

  // The audit screen lists the run's entries.
  await page.goto(`/b/${brandId}/settings/audit`)
  const entries = page.locator('tbody tr')
  await expect(entries.filter({ hasText: 'Run started' })).toHaveCount(1)
  await expect(entries.filter({ hasText: 'Made a new version of an item' })).toHaveCount(1)
  await expect(entries.filter({ hasText: 'Approved an item' })).toHaveCount(1)

  // The kill switch: set with a code, the red banner shows, release it.
  await page.goto(`/b/${brandId}/settings/safety`)
  await page.locator('#ks-code').fill(await codeFor(secret))
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Stopped.' })).toBeVisible()
  const red = page.locator('.banner.danger')
  await expect(red).toContainText('Kill switch is on')

  await page.getByRole('button', { name: 'Release', exact: true }).first().click()
  await page.locator('#rel-code').fill(await codeFor(secret))
  await page.locator('form[aria-labelledby="rel-title"]').getByRole('button', { name: 'Release' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Released.' })).toBeVisible()
  await expect(red).toHaveCount(0)
})
