import { expect, test } from '@playwright/test'
import { makeBrand, makeUser, signIn, tinyPdf, unique } from './control.ts'
import {
  ASK_TEXT,
  AUDIENCE_NAME,
  CHANGED_CADENCE,
  CHOICE_AUDIENCE,
  CHOICE_CHANNELS,
  CHOICE_RHYTHM,
  FACT_CONFIRMED,
  FACT_DROPPED,
  FACT_EDITED,
  FIRST_CADENCE,
  RECOMMENDED_AUDIENCE,
  RECOMMENDED_CHANNELS,
  RECOMMENDED_RHYTHM,
  RULE_SUGGESTED,
} from './decision-script.ts'

const EDITED_WORDING = 'Aztek coatings carry ISO 9001 certification.'
const OWN_RULE = 'Never compare prices with a named rival.'
const OWN_AUDIENCE = 'Bike owners in Pune who ride every day'
const CHANGE_COMMENT = 'Post on Instagram three times a week.'
const REWORDED = 'Aztek makes ceramic coatings for cars, bikes and scooters.'

// Milestone 9, through the screens (spec 12, test 53): the platform owner gives the intake and a document,
// starts research (the stand-in model answers each group and the merge, see research-script.ts), waits for it,
// accepts what was found, edits one suggestion and rejects another, and the decisions hold after a reload.
// Milestones 10 and 11 carry the same brand on through the questionnaire, facts and rules, the brief choices and
// the strategy brief to gate 1 (test 42).
test('the platform owner onboards a brand from the intake to gate 1', async ({ page }) => {
  // Every agent of onboarding runs once or more in this one journey.
  test.setTimeout(300_000)
  const slug = unique('onboard')
  const brandId = await makeBrand(slug)
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
  // The suggestion is shown, never chosen for the owner (R40).
  await expect(goals.getByText('Suggested: More enquiries')).toBeVisible()
  await expect(goals.getByRole('radio', { name: /^More enquiries/ })).not.toBeChecked()
  await goals.getByRole('radio', { name: 'More walk-ins' }).check()
  await expect(goals.getByText('Saved', { exact: true })).toBeVisible()
  const audience = page.getByRole('listitem').filter({ hasText: 'Who matters most to you?' })
  await audience.getByLabel('Your answer').fill('Bike owners in Pune')
  await expect(audience.getByText('Saved', { exact: true })).toBeVisible()
  await page.reload()
  await expect(goals).toBeVisible()
  await expect(goals.getByRole('radio', { name: 'More walk-ins' })).toBeChecked()
  await expect(audience.getByLabel('Your answer')).toHaveValue('Bike owners in Pune')

  // 7. Finish: only the two answers the owner gave count; the suggestions left alone stay blank.
  await page.getByRole('button', { name: 'Finish questionnaire' }).click()
  await expect(page.getByText('2 answered, 8 left blank. Finish now?')).toBeVisible()
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
  // The sources under a card repeat the site's wording, so a card is found by the statement it carries. A card
  // waits in "Facts to confirm" or "Rules to confirm"; once decided it leaves them (an edited or dropped one is
  // repeated under "Your corrections").
  const card = (text: string) =>
    page
      .getByRole('region', { name: /^(Facts|Rules) to confirm$/ })
      .locator('li.dp-item')
      .filter({ has: page.locator('p.dp-value', { hasText: text }) })
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
  for (const region of ['Facts to confirm', 'Confirmed facts']) {
    await expect(page.getByRole('region', { name: region }).getByText(FACT_DROPPED)).toHaveCount(0)
    await expect(
      page.getByRole('region', { name: region }).getByText(FACT_EDITED, { exact: true }),
    ).toHaveCount(0)
  }
  // The edited and the dropped suggestion are kept only as the owner's corrections.
  const corrections = page.getByRole('region', { name: 'Your corrections' })
  await expect(corrections.locator('li.dp-item', { hasText: FACT_EDITED })).toContainText(
    `You changed it to: ${EDITED_WORDING}`,
  )
  await expect(corrections.locator('li.dp-item', { hasText: FACT_DROPPED })).toContainText('You dropped it.')
  await expect(page.getByRole('region', { name: 'Confirmed rules' }).getByText(OWN_RULE)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Facts to confirm' }).getByText(FACT_CONFIRMED)).toHaveCount(
    0,
  )
  // The suggested rule was not decided, so it still waits and is not among the confirmed rules.
  await expect(page.getByRole('region', { name: 'Rules to confirm' }).getByText(RULE_SUGGESTED)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Confirmed rules' }).getByText(RULE_SUGGESTED)).toHaveCount(0)

  // Milestone 11 continues from facts and rules (spec 4, 6, 10, 12; app flow 5.6; tests 42, 53).
  // 12. Brief choices: settle the last rule, find the open choices, keep two recommended options and put the
  // third in your own words; the picks hold after a reload.
  await card(RULE_SUGGESTED).getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('region', { name: 'Confirmed rules' }).getByText(RULE_SUGGESTED)).toBeVisible()
  await page.getByRole('link', { name: 'Continue to brief choices' }).click()
  await expect(page).toHaveURL(new RegExp(`/b/${brandId}/onboarding/brief-choices$`))
  await expect(page.getByRole('heading', { name: 'Brief choices', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Find the open choices' }).click()
  const choice = (question: string) => page.getByRole('region', { name: question })
  await expect(choice(CHOICE_AUDIENCE)).toBeVisible({ timeout: 120_000 })
  // The recommended option is marked and chosen until the owner changes it.
  for (const [question, value] of [
    [CHOICE_AUDIENCE, RECOMMENDED_AUDIENCE],
    [CHOICE_CHANNELS, RECOMMENDED_CHANNELS],
    [CHOICE_RHYTHM, RECOMMENDED_RHYTHM],
  ] as const) {
    await expect(choice(question).getByRole('radio', { name: new RegExp(`^${value}`) })).toBeChecked()
    await expect(choice(question).getByText('Recommended', { exact: true })).toBeVisible()
  }
  const saveButton = page.getByRole('button', { name: 'Save my picks' })
  await choice(CHOICE_AUDIENCE).getByRole('radio', { name: 'Other', exact: true }).check()
  // Other needs the owner's words before anything is saved.
  await expect(saveButton).toBeDisabled()
  await choice(CHOICE_AUDIENCE).getByLabel('Your own words').fill(OWN_AUDIENCE)
  await saveButton.click()
  await expect(page.getByRole('status').filter({ hasText: 'Picks saved.' })).toBeVisible()
  await page.reload()
  await expect(choice(CHOICE_AUDIENCE)).toContainText(`Your own words ${OWN_AUDIENCE}`)
  await expect(choice(CHOICE_CHANNELS)).toContainText(`Accepted ${RECOMMENDED_CHANNELS}`)
  await expect(choice(CHOICE_RHYTHM)).toContainText(`Accepted ${RECOMMENDED_RHYTHM}`)
  await expect(saveButton).toHaveCount(0)

  // 13. Write the brief and wait until it waits for approval.
  await page.getByRole('button', { name: 'Write the strategy brief' }).click()
  await expect(page.getByText('The brief is waiting for your approval.')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('link', { name: 'Review the brief' })).toBeVisible()

  // 14. Open it from the inbox: the brief's sections are headings, its picks and facts are in it.
  const briefTitle = `Strategy brief: ${slug}`
  await page.goto(`/b/${brandId}/inbox`)
  await page.getByRole('link', { name: briefTitle }).click()
  await expect(page.getByRole('heading', { name: briefTitle, level: 1 })).toBeVisible()
  await expect(page.getByText('Strategy brief · version 1 of 1')).toBeVisible()
  for (const section of [
    'Positioning',
    'Audiences',
    'Content themes',
    'Channels',
    'Plan: posts per week',
    '90-day goals',
    'Choices made',
    'Facts used',
  ]) {
    await expect(page.getByRole('heading', { name: section, level: 3, exact: true })).toBeVisible()
  }
  await expect(page.getByRole('heading', { name: AUDIENCE_NAME, level: 4 })).toBeVisible()
  await expect(page.getByText(FIRST_CADENCE, { exact: true })).toBeVisible()
  await expect(page.getByText('Enquiries a month: from baseline needed (B1) to 30')).toBeVisible()
  await expect(page.getByText(new RegExp(`^${OWN_AUDIENCE} \\(not taken: `))).toBeVisible()
  await expect(page.getByText(FACT_CONFIRMED, { exact: true })).toBeVisible()
  await expect(page.getByText(EDITED_WORDING, { exact: true })).toBeVisible()

  // 15. Ask for changes: the comment starts the strategist again, and the second version follows it.
  await page.getByRole('button', { name: 'Ask for changes' }).click()
  await page.getByLabel('What should change?').fill(CHANGE_COMMENT)
  await page.getByRole('button', { name: 'Send the comment' }).click()
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Your comment was sent. A new version will come back to your inbox.' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled()
  // The brief choices screen follows the rewrite until the new version waits.
  await page.goto(`/b/${brandId}/onboarding/brief-choices`)
  await expect(page.getByText('The brief is waiting for your approval.')).toBeVisible({ timeout: 120_000 })
  await page.goto(`/b/${brandId}/inbox`)
  await page.getByRole('link', { name: briefTitle }).click()
  await expect(page.getByText('Strategy brief · version 2 of 2')).toBeVisible()
  await expect(page.getByText(CHANGED_CADENCE, { exact: true })).toBeVisible()
  await expect(page.getByText(FIRST_CADENCE, { exact: true })).toHaveCount(0)

  // 16. Approve it.
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Approved. Nothing is published in this phase.' }),
  ).toBeVisible()

  // 17. Gate 1: the overview says the brand is onboarded.
  await page.goto(`/b/${brandId}/onboarding`)
  await expect(page.getByText('Onboarded: the strategy brief is approved.')).toBeVisible()

  // 18. Reword a fact the brief cites: the approval is cancelled and the overview asks for re-approval.
  await page.goto(`/b/${brandId}/onboarding/facts-rules`)
  const activeFact = (text: string) =>
    confirmedFacts.locator('li.dp-item').filter({ has: page.locator('p.dp-value', { hasText: text }) })
  await activeFact(FACT_CONFIRMED).getByRole('button', { name: 'Replace' }).click()
  await activeFact(FACT_CONFIRMED).getByLabel('The new wording').fill(REWORDED)
  await activeFact(FACT_CONFIRMED).getByRole('button', { name: 'Replace fact' }).click()
  await expect(activeFact(REWORDED)).toBeVisible()
  await expect(activeFact(FACT_CONFIRMED)).toHaveCount(0)
  await page.goto(`/b/${brandId}/onboarding`)
  await expect(page.getByText('The brief needs re-approval: a fact it cites changed.')).toBeVisible()
  await expect(page.getByText('Onboarded: the strategy brief is approved.')).toHaveCount(0)
})
