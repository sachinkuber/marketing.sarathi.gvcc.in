import { expect, test } from '@playwright/test'
import { makeBrand, makeUser, signIn, tinyPdf, unique } from './control.ts'

// Milestone 9, through the screens (spec 12, test 53): the platform owner gives the intake and a document,
// starts research (the stand-in model answers each group and the merge, see research-script.ts), waits for it,
// accepts what was found, edits one suggestion and rejects another, and the decisions hold after a reload.
test('the platform owner runs research and decides the draft profile', async ({ page }) => {
  const brandId = await makeBrand(unique('onboard'))
  const owner = await makeUser({
    email: `${unique('owner')}@e2e.test`,
    platformOwner: true,
    enrolled: true,
  })
  await signIn(page, owner)

  // 1. The intake and one small PDF.
  await page.goto(`/b/${brandId}/onboarding/intake`)
  await expect(page.getByRole('heading', { name: 'Onboarding intake', level: 1 })).toBeVisible()
  await page.locator('#in-website').fill('https://aztek.example/')
  await page.locator('#in-instagram').fill('https://www.instagram.com/aztek')
  await page.getByRole('button', { name: 'Add a competitor' }).click()
  await page.locator('#in-comp-0-name').fill('Rival')
  await page.locator('#in-comp-0-website').fill('https://rival.example/')
  await page.getByRole('button', { name: 'Save intake' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  await page.locator('#in-file').setInputFiles({
    name: 'aztek-brochure.pdf',
    mimeType: 'application/pdf',
    buffer: tinyPdf(),
  })
  await expect(page.getByText('aztek-brochure.pdf', { exact: true })).toBeVisible()

  // 2. Start research and wait for it to finish.
  await page.getByRole('button', { name: 'Start research' }).click()
  await expect(page).toHaveURL(new RegExp(`/b/${brandId}/onboarding/research$`))
  await expect(page.getByRole('heading', { name: 'Research progress', level: 1 })).toBeVisible()
  const seeProfile = page.getByRole('link', { name: 'See the draft profile' })
  await expect(seeProfile).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Could not be read')).toHaveCount(0)
  await seeProfile.click()
  await expect(page.getByRole('heading', { name: 'Draft profile', level: 1 })).toBeVisible()

  // The topics, the gaps, and a flagged source with its reason.
  await expect(page.getByRole('heading', { name: 'The business', level: 2 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Online presence', level: 2 })).toBeVisible()
  await expect(page.getByText('Not found yet — will be asked in the questionnaire').first()).toBeVisible()
  const visibility = page.locator('li[data-key="search_visibility"]')
  await visibility.getByRole('button', { name: 'Show sources' }).click()
  await expect(visibility.getByText('Flagged: asks the reader to follow an instruction')).toBeVisible()
  await expect(visibility.getByText('https://news.example/aztek')).toBeVisible()

  // 3. Accept all found items: the three from the site and the one from the document.
  const acceptAll = page.getByRole('button', { name: 'Accept all found items (4)' })
  await expect(acceptAll).toBeVisible()
  await acceptAll.click()
  await expect(page.getByRole('status').filter({ hasText: 'Accepted 4 items.' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Accept all found items/ })).toHaveCount(0)
  for (const key of ['business_name', 'what_they_sell', 'contact_points', 'certifications']) {
    await expect(page.locator(`li[data-key="${key}"]`).getByText('Accepted', { exact: true })).toBeVisible()
  }

  // 4. Edit one (pre-filled with the suggestion) and reject another.
  await page.getByRole('button', { name: 'Edit Competitors' }).click()
  const field = page.getByLabel('Your wording for Competitors')
  await expect(field).toHaveValue('Rival')
  await field.fill('Rival Coatings Pune')
  await page.getByRole('button', { name: 'Save edit' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Competitors: saved with your wording.' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Reject Search visibility' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Search visibility: rejected.' })).toBeVisible()

  // 5. Reload: the decisions hold, and only the one undecided suggestion still has buttons.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Draft profile', level: 1 })).toBeVisible()
  await expect(page.locator('li[data-key="competitors"]')).toContainText('Edited to: Rival Coatings Pune')
  await expect(
    page.locator('li[data-key="search_visibility"]').getByText('Rejected', { exact: true }),
  ).toBeVisible()
  for (const key of ['business_name', 'what_they_sell', 'contact_points', 'certifications']) {
    await expect(page.locator(`li[data-key="${key}"]`).getByText('Accepted', { exact: true })).toBeVisible()
  }
  await expect(page.getByRole('button', { name: /^Accept all found items/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Accept Social presence' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^(Accept|Edit|Reject) (Business name|Competitors|Search visibility)/ }),
  ).toHaveCount(0)
})
