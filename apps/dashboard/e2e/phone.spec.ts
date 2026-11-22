import { expect, test } from '@playwright/test'
import {
  advanceClock,
  codeFor,
  expectNoHorizontalScroll,
  makeBrand,
  makeItem,
  makeUser,
  pollOverdueNow,
  signIn,
  tinyPdf,
  unique,
} from './control.ts'
import {
  ASK_TEXT,
  CHANGED_CADENCE,
  CHOICE_AUDIENCE,
  FACT_CONFIRMED,
  FACT_DROPPED,
  FACT_EDITED,
  RULE_SUGGESTED,
} from './decision-script.ts'

// Runs first: the other phone check moves the clock a hundred hours on, and the platform owner would then see
// its overdue pop-up over these screens.
// The onboarding screens on a phone (test 53, for these screens): the intake with a document, the progress screen,
// the draft profile, the questionnaire, facts and rules, the brief choices and the strategy brief in the inbox work
// by touch, and none of them scrolls sideways.
test('the onboarding screens, from the intake to the strategy brief, work on a phone', async ({ page }) => {
  // Every agent of onboarding runs once or more in this one journey.
  test.setTimeout(300_000)
  const slug = unique('phone-onb')
  const brandId = await makeBrand(slug)
  const owner = await makeUser({
    email: `${unique('owner')}@e2e.test`,
    platformOwner: true,
    enrolled: true,
  })
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 })
  await signIn(page, owner)

  await page.goto(`/b/${brandId}/onboarding/intake`)
  await expect(page.getByRole('heading', { name: 'Onboarding intake', level: 1 })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.locator('#in-website').fill('https://aztek.example/')
  await page.locator('#in-instagram').fill('https://www.instagram.com/aztek')
  await page.getByRole('button', { name: 'Add a competitor' }).tap()
  await page.locator('#in-comp-0-name').fill('Rival')
  await page.locator('#in-comp-0-website').fill('https://rival.example/')
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Save intake' }).tap()
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  await page.locator('#in-file').setInputFiles({
    name: 'aztek-brochure-with-a-rather-long-file-name-for-a-narrow-screen.pdf',
    mimeType: 'application/pdf',
    buffer: tinyPdf(),
  })
  await expect(
    page.getByText('aztek-brochure-with-a-rather-long-file-name-for-a-narrow-screen.pdf'),
  ).toBeVisible()
  await expectNoHorizontalScroll(page)

  await page.getByRole('button', { name: 'Start research' }).tap()
  await expect(page).toHaveURL(new RegExp(`/b/${brandId}/onboarding/research$`))
  await expect(page.getByRole('heading', { name: 'Research progress', level: 1 })).toBeVisible()
  await expectNoHorizontalScroll(page)
  const seeProfile = page.getByRole('link', { name: 'See the draft profile' })
  await expect(seeProfile).toBeVisible({ timeout: 120_000 })
  await page.getByRole('button', { name: 'Show sources' }).first().tap()
  await expectNoHorizontalScroll(page)
  await seeProfile.tap()

  await expect(page.getByRole('heading', { name: 'Draft profile', level: 1 })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.locator('li[data-key="search_visibility"]').getByRole('button', { name: 'Show sources' }).tap()
  await expect(page.getByText('Flagged: asks the reader to follow an instruction')).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Accept all found items (4)' }).tap()
  await expect(page.getByRole('status').filter({ hasText: 'Accepted 4 items.' })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Edit Competitors' }).tap()
  await page.getByLabel('Your wording for Competitors').fill('Rival Coatings Pune')
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Save edit' }).tap()
  await expect(page.locator('li[data-key="competitors"]')).toContainText('Edited to: Rival Coatings Pune')
  await page.getByRole('button', { name: 'Reject Search visibility' }).tap()
  await expect(
    page.locator('li[data-key="search_visibility"]').getByText('Rejected', { exact: true }),
  ).toBeVisible()
  await expectNoHorizontalScroll(page)

  // The questionnaire, the agent's question and the facts and rules screen, by touch (test 53).
  await page.goto(`/b/${brandId}/onboarding/questionnaire`)
  await expect(page.getByRole('heading', { name: 'Questionnaire', level: 1 })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Prepare the questionnaire' }).tap()
  const goals = page.getByRole('listitem').filter({ hasText: 'What should the next three months bring?' })
  await expect(goals).toBeVisible({ timeout: 120_000 })
  await expectNoHorizontalScroll(page)
  await goals.getByText('More walk-ins', { exact: true }).tap()
  await expect(goals.getByRole('radio', { name: 'More walk-ins' })).toBeChecked()
  await expect(goals.getByText('Saved', { exact: true })).toBeVisible()
  const audience = page.getByRole('listitem').filter({ hasText: 'Who matters most to you?' })
  await audience.getByLabel('Your answer').fill('Bike owners in Pune')
  await expect(audience.getByText('Saved', { exact: true })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Finish questionnaire' }).tap()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Yes, finish' }).tap()
  await expect(page).toHaveURL(new RegExp(`/b/${brandId}/onboarding/facts-rules$`))
  await expect(page.getByRole('heading', { name: 'Facts and rules', level: 1 })).toBeVisible()
  await expectNoHorizontalScroll(page)

  await page.getByRole('button', { name: 'Find facts and rules' }).tap()
  const question = page.getByRole('region', { name: 'A question from the agent' })
  await expect(question.getByText(ASK_TEXT)).toBeVisible({ timeout: 120_000 })
  await expectNoHorizontalScroll(page)
  await question.getByText('Premium', { exact: true }).tap()
  await question.getByRole('button', { name: 'Send answer' }).tap()
  await expect(question.getByText('Sent. The job starts again with your answer.')).toBeVisible()
  // A suggestion waiting for a decision. Once decided it leaves these lists (an edited or dropped one is repeated
  // under "Your corrections", a confirmed one under the confirmed facts or rules).
  const card = (text: string) =>
    page
      .getByRole('region', { name: /^(Facts|Rules) to confirm$/ })
      .locator('li.dp-item')
      .filter({ has: page.locator('p.dp-value', { hasText: text }) })
  const fact = card(FACT_CONFIRMED)
  await expect(fact).toBeVisible({ timeout: 120_000 })
  await expectNoHorizontalScroll(page)
  await fact.getByRole('button', { name: 'Confirm' }).tap()
  await expect(
    page.getByRole('region', { name: 'Confirmed facts' }).locator('p.dp-value', { hasText: FACT_CONFIRMED }),
  ).toBeVisible()
  await card(FACT_EDITED).getByRole('button', { name: 'Edit' }).tap()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Add your own rule' }).tap()
  await page.getByLabel('The rule, in your words').fill('Never compare prices with a named rival.')
  await expectNoHorizontalScroll(page)
  await page.getByLabel('Why', { exact: true }).fill('The owner asked for it.')
  await page.getByRole('button', { name: 'Add rule' }).tap()
  await expect(
    page
      .getByRole('region', { name: 'Confirmed rules' })
      .getByText('Never compare prices with a named rival.'),
  ).toBeVisible()
  // Every fact and rule is decided before the brief choices start.
  await card(FACT_EDITED).getByLabel('Your wording').fill('Aztek coatings carry ISO 9001 certification.')
  await card(FACT_EDITED).getByRole('button', { name: 'Save edit' }).tap()
  await expect(card(FACT_EDITED)).toHaveCount(0)
  await card(FACT_DROPPED).getByRole('button', { name: 'Drop' }).tap()
  await card(FACT_DROPPED).getByRole('button', { name: 'Yes, drop' }).tap()
  await expect(card(FACT_DROPPED)).toHaveCount(0)
  await card(RULE_SUGGESTED).getByRole('button', { name: 'Confirm' }).tap()
  await expect(
    page.getByRole('region', { name: 'Confirmed rules' }).getByText(RULE_SUGGESTED, { exact: true }),
  ).toBeVisible()
  await expect(card(RULE_SUGGESTED)).toHaveCount(0)
  await expectNoHorizontalScroll(page)

  // Milestone 11, steps 12 to 16 of the desktop journey by touch (tests 42, 53).
  // 12. The brief choices: one pick in the owner's own words.
  await page.getByRole('link', { name: 'Continue to brief choices' }).tap()
  await expect(page.getByRole('heading', { name: 'Brief choices', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Find the open choices' }).tap()
  const audienceChoice = page.getByRole('region', { name: CHOICE_AUDIENCE })
  await expect(audienceChoice).toBeVisible({ timeout: 120_000 })
  await expectNoHorizontalScroll(page)
  await audienceChoice.getByText('Other', { exact: true }).tap()
  await expect(audienceChoice.getByRole('radio', { name: 'Other', exact: true })).toBeChecked()
  await audienceChoice.getByLabel('Your own words').fill('Bike owners in Pune who ride every day')
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Save my picks' }).tap()
  await expect(page.getByRole('status').filter({ hasText: 'Picks saved.' })).toBeVisible()
  await expectNoHorizontalScroll(page)

  // 13. Write the brief.
  await page.getByRole('button', { name: 'Write the strategy brief' }).tap()
  await expect(page.getByText('The brief is waiting for your approval.')).toBeVisible({ timeout: 120_000 })
  await expectNoHorizontalScroll(page)

  // 14. Open it from the inbox.
  const briefTitle = `Strategy brief: ${slug}`
  await page.goto(`/b/${brandId}/inbox`)
  await page.getByRole('link', { name: briefTitle }).tap()
  await expect(page.getByRole('heading', { name: briefTitle, level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Plan: posts per week', level: 3 })).toBeVisible()
  await expectNoHorizontalScroll(page)

  // 15. Ask for changes, and open the second version when it comes back.
  await page.getByRole('button', { name: 'Ask for changes' }).tap()
  await page.getByLabel('What should change?').fill('Post on Instagram three times a week.')
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Send the comment' }).tap()
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Your comment was sent. A new version will come back to your inbox.' }),
  ).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.goto(`/b/${brandId}/onboarding/brief-choices`)
  await expect(page.getByText('The brief is waiting for your approval.')).toBeVisible({ timeout: 120_000 })
  await page.getByRole('link', { name: 'Review the brief' }).tap()
  await expect(page.getByText('Strategy brief · version 2 of 2')).toBeVisible()
  await expect(page.getByText(CHANGED_CADENCE, { exact: true })).toBeVisible()
  await expectNoHorizontalScroll(page)

  // 16. Approve it.
  await page.getByRole('button', { name: 'Approve' }).tap()
  await expect(
    page.getByRole('status').filter({ hasText: 'Approved. Nothing is published in this phase.' }),
  ).toBeVisible()
  await expectNoHorizontalScroll(page)
})

// The phone checks (spec 15, app-flow 8) at 390 x 844 with touch: the approval work, the kill switch, alerts
// and the overdue pop-up all work, and none of those screens scrolls sideways.
test('inbox, item, approve, reject, stop button, alerts and the pop-up work on a phone', async ({ page }) => {
  const brandId = await makeBrand(unique('phone'))
  const admin = await makeUser({
    email: `${unique('admin')}@e2e.test`,
    role: 'brand_admin',
    brandId,
    enrolled: true,
  })
  const secret = admin.secret as string
  await makeItem(brandId, 'Phone offer one')
  await makeItem(brandId, 'Phone offer two')
  await makeItem(brandId, 'Phone offer three')
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 })

  // Sign in with the code, open the inbox.
  await signIn(page, admin)
  await page.goto(`/b/${brandId}/inbox`)
  await expect(page.getByRole('link', { name: 'Phone offer one' })).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Open an item and approve it.
  await page.getByRole('link', { name: 'Phone offer one' }).tap()
  await expect(page.getByRole('heading', { name: 'Phone offer one', level: 1 })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Approve' }).tap()
  await expect(page.getByRole('status')).toContainText('Approved.')
  await expectNoHorizontalScroll(page)

  // Open another and reject it with a reason.
  await page.goto(`/b/${brandId}/inbox`)
  await page.getByRole('link', { name: 'Phone offer two' }).tap()
  await expect(page.getByRole('heading', { name: 'Phone offer two', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Reject', exact: true }).tap()
  await page.getByLabel('Why is it rejected?').fill('Not for this season.')
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: /^Reject version/ }).tap()
  await expect(page.getByRole('status')).toContainText('Rejected.')

  // The stop button in the top bar leads to the kill switch; set it with a code, then release it.
  await page.getByRole('link', { name: 'Stop', exact: true }).tap()
  await expect(page).toHaveURL(new RegExp(`/b/${brandId}/settings/safety$`))
  await expectNoHorizontalScroll(page)
  await page.locator('#ks-code').fill(await codeFor(secret))
  await page.getByRole('button', { name: 'Stop', exact: true }).tap()
  await expect(page.getByRole('status').filter({ hasText: 'Stopped.' })).toBeVisible()
  await expect(page.locator('.banner.danger')).toContainText('Kill switch is on')
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Release', exact: true }).first().tap()
  await page.locator('#rel-code').fill(await codeFor(secret))
  await page.locator('form[aria-labelledby="rel-title"]').getByRole('button', { name: 'Release' }).tap()
  await expect(page.getByRole('status').filter({ hasText: 'Released.' })).toBeVisible()
  await expect(page.locator('.banner.danger')).toHaveCount(0)

  // Alerts.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Alerts and incidents' })
    .tap()
  await expect(page).toHaveURL(/\/alerts$/)
  await expect(page.getByRole('heading', { name: 'Open alerts', level: 2 })).toBeVisible()
  await expectNoHorizontalScroll(page)

  // The third item goes overdue: the pop-up fills the screen and does not widen the page.
  await advanceClock(96)
  await pollOverdueNow(page)
  const popup = page.locator('#overdue-popup')
  await expect(popup).toBeVisible()
  await expect(page.getByRole('heading', { name: '1 item overdue for approval', level: 2 })).toBeVisible()
  const box = await popup.locator('.modal').boundingBox()
  expect(box).not.toBeNull()
  expect(Math.round(box!.x)).toBe(0)
  expect(Math.round(box!.y)).toBe(0)
  expect(Math.round(box!.width)).toBe(390)
  expect(Math.round(box!.height)).toBe(844)
  await expectNoHorizontalScroll(page)
})
