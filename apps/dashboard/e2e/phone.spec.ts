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
  unique,
} from './control.ts'

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
