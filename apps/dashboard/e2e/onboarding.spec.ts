import { expect, test } from '@playwright/test'
import { makeBrand, makeUser, signIn, tinyPdf, unique } from './control.ts'
import { ASK_TEXT, FACT_CONFIRMED, FACT_DROPPED, FACT_EDITED, RULE_SUGGESTED } from './decision-script.ts'

const EDITED_WORDING = 'Aztek coatings carry ISO 9001 certification.'
const OWN_RULE = 'Never compare prices with a named rival.'

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

  // Milestone 10 continues from the draft profile (spec 4, 7, 9; tests 43, 53).
  // 6. The questionnaire: prepare it, answer two questions (one chosen, one written), and the answers hold.
  await page.goto(`/b/${brandId}/onboarding/questionnaire`)
  await expect(page.getByRole('heading', { name: 'Questionnaire', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Prepare the questionnaire' }).click()
  const goals = page.getByRole('listitem').filter({ hasText: 'What should the next three months bring?' })
  await expect(goals).toBeVisible({ timeout: 120_000 })
  await goals.getByRole('radio', { name: 'More walk-ins' }).check()
  await expect(goals.getByText('Saved', { exact: true })).toBeVisible()
  const audience = page.getByRole('listitem').filter({ hasText: 'Who matters most to you?' })
  await audience.getByLabel('Your answer').fill('Bike owners in Pune')
  await expect(audience.getByText('Saved', { exact: true })).toBeVisible()
  await page.reload()
  await expect(goals).toBeVisible()
  await expect(goals.getByRole('radio', { name: 'More walk-ins' })).toBeChecked()
  await expect(audience.getByLabel('Your answer')).toHaveValue('Bike owners in Pune')

  // 7. Finish: the suggestions that were left alone become answers, and the screen moves on.
  await page.getByRole('button', { name: 'Finish questionnaire' }).click()
  await expect(page.getByText(/2 answered by you, \d+ suggested answers? kept/)).toBeVisible()
  await page.getByRole('button', { name: 'Yes, finish' }).click()
  await expect(page).toHaveURL(new RegExp(`/b/${brandId}/onboarding/facts-rules$`))
  await expect(page.getByRole('heading', { name: 'Facts and rules', level: 1 })).toBeVisible()

  // 8. Facts and rules: the agent asks before it answers; the overview lists the question too.
  await page.getByRole('button', { name: 'Find facts and rules' }).click()
  const question = page.getByRole('region', { name: 'A question from the agent' })
  await expect(question.getByText(ASK_TEXT)).toBeVisible({ timeout: 120_000 })
  await page.goto(`/b/${brandId}/onboarding`)
  await expect(page.getByText('1 question waits for your answer.')).toBeVisible()
  await expect(page.getByText(ASK_TEXT)).toBeVisible()
  await page.goto(`/b/${brandId}/onboarding/facts-rules`)
  await question.getByRole('radio', { name: 'Premium' }).check()
  await question.getByRole('button', { name: 'Send answer' }).click()
  await expect(question.getByText('Sent. The job starts again with your answer.')).toBeVisible()

  // 9. The job resumes with the answer and the suggestions arrive.
  // The sources under a card repeat the site's wording, so a card is found by the statement it carries.
  const card = (text: string) =>
    page.locator('li.dp-item').filter({ has: page.locator('p.dp-value', { hasText: text }) })
  await expect(card(FACT_CONFIRMED)).toBeVisible({ timeout: 120_000 })
  await expect(question).toHaveCount(0)

  // 10. Confirm one fact, edit one, drop one, and add your own rule.
  await card(FACT_CONFIRMED).getByRole('button', { name: 'Confirm' }).click()
  const confirmedFacts = page.getByRole('region', { name: 'Confirmed facts' })
  await expect(confirmedFacts.locator('p.dp-value', { hasText: FACT_CONFIRMED })).toBeVisible()
  await card(FACT_EDITED).getByRole('button', { name: 'Edit' }).click()
  await card(FACT_EDITED).getByLabel('Your wording').fill(EDITED_WORDING)
  await card(FACT_EDITED).getByRole('button', { name: 'Save edit' }).click()
  await expect(confirmedFacts.locator('p.dp-value', { hasText: EDITED_WORDING })).toBeVisible()
  await expect(card(FACT_EDITED)).toHaveCount(0)
  await card(FACT_DROPPED).getByRole('button', { name: 'Drop' }).click()
  await card(FACT_DROPPED).getByRole('button', { name: 'Yes, drop' }).click()
  await expect(card(FACT_DROPPED)).toHaveCount(0)
  await page.getByRole('button', { name: 'Add your own rule' }).click()
  await page.getByLabel('The rule, in your words').fill(OWN_RULE)
  await page.getByLabel('Why', { exact: true }).fill('The owner asked for it.')
  await page.getByRole('button', { name: 'Add rule' }).click()
  await expect(page.getByRole('region', { name: 'Confirmed rules' }).getByText(OWN_RULE)).toBeVisible()

  // 11. Reload: the decisions hold, and nothing is used before it was decided.
  await page.reload()
  await expect(confirmedFacts.locator('p.dp-value', { hasText: FACT_CONFIRMED })).toBeVisible()
  await expect(confirmedFacts.locator('p.dp-value', { hasText: EDITED_WORDING })).toBeVisible()
  await expect(page.getByText(FACT_DROPPED)).toHaveCount(0)
  await expect(page.getByText(FACT_EDITED, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Confirmed rules' }).getByText(OWN_RULE)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Facts to confirm' }).getByText(FACT_CONFIRMED)).toHaveCount(
    0,
  )
  // The suggested rule was not decided, so it still waits and is not among the confirmed rules.
  await expect(page.getByRole('region', { name: 'Rules to confirm' }).getByText(RULE_SUGGESTED)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Confirmed rules' }).getByText(RULE_SUGGESTED)).toHaveCount(0)
})
