import { expect, test } from '@playwright/test'
import { advanceClock, makeBrand, makeItem, makeUser, signIn, unique } from './control.ts'

// Acceptance test 22: an item nobody answers for 96 hours opens the pop-up over whatever screen the approver
// is on; only "Later" and "Review now" close it; the banner stays until someone decides.
test('the overdue pop-up opens over the current screen, cannot be dismissed, and ends with a decision', async ({
  browser,
  page,
}) => {
  const brandId = await makeBrand(unique('overdue'))
  const approver = await makeUser({
    email: `${unique('approver')}@e2e.test`,
    role: 'approver',
    brandId,
    enrolled: true,
  })
  const viewer = await makeUser({ email: `${unique('viewer')}@e2e.test`, role: 'viewer', brandId })
  const { itemId } = await makeItem(brandId, 'Spring offer')
  const popup = page.locator('#overdue-popup')
  const banner = page.locator('.banner', { hasText: '1 item overdue for approval' })

  await signIn(page, approver)
  await page.goto(`/b/${brandId}/inbox`)
  await expect(page.getByRole('link', { name: 'Spring offer' })).toBeVisible()
  await expect(popup).toHaveCount(0)
  await expect(banner).toHaveCount(0)

  // Four days pass with no answer. The page is left alone: the watcher's own poll (every 60 seconds) finds it.
  await advanceClock(96)
  await expect(popup).toBeVisible({ timeout: 75_000 })
  await expect(page.getByRole('heading', { name: '1 item overdue for approval', level: 2 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Spring offer' })).toBeInViewport()

  // Escape, a click outside and the back button leave it open.
  await page.keyboard.press('Escape')
  await expect(popup).toBeVisible()
  await popup.click({ position: { x: 4, y: 4 } })
  await expect(popup).toBeVisible()
  const here = page.url()
  await page.goBack()
  await expect(popup).toBeVisible()
  expect(page.url()).toBe(here)

  // A viewer of the same brand is not asked and sees no banner.
  const other = await browser.newContext()
  const viewerPage = await other.newPage()
  await signIn(viewerPage, viewer)
  await viewerPage.goto(`/b/${brandId}/inbox`)
  await expect(viewerPage.getByRole('link', { name: 'Spring offer' })).toBeVisible()
  await expect(viewerPage.locator('#overdue-popup')).toHaveCount(0)
  await expect(viewerPage.locator('.banner')).toHaveCount(0)
  await other.close()

  // "Later" closes it; the banner still says one item is overdue.
  await page.getByRole('button', { name: 'Later' }).click()
  await expect(popup).toHaveCount(0)
  await expect(banner).toBeVisible()

  // A new sign-in shows it again.
  const again = await browser.newContext()
  const second = await again.newPage()
  await signIn(second, approver)
  await second.goto(`/b/${brandId}/inbox`)
  await expect(second.locator('#overdue-popup')).toBeVisible()

  // "Review now" opens the item; approving it removes the banner, and the pop-up does not come back.
  await second.getByRole('button', { name: 'Review now' }).click()
  await expect(second).toHaveURL(new RegExp(`/b/${brandId}/inbox/${itemId}$`))
  await expect(second.getByRole('heading', { name: 'Spring offer', level: 1 })).toBeVisible()
  await expect(second.locator('#overdue-popup')).toHaveCount(0)
  await second.getByRole('button', { name: 'Approve' }).click()
  await expect(second.getByRole('status')).toContainText('Approved.')
  await expect(second.locator('.banner', { hasText: 'overdue for approval' })).toHaveCount(0)
  await again.close()

  const last = await browser.newContext()
  const third = await last.newPage()
  await signIn(third, approver)
  await third.goto(`/b/${brandId}/inbox`)
  await expect(third.getByText('Nothing is waiting for approval')).toBeVisible()
  await expect(third.locator('#overdue-popup')).toHaveCount(0)
  await expect(third.locator('.banner', { hasText: 'overdue for approval' })).toHaveCount(0)
  await last.close()
})
