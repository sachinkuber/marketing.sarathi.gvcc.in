import { expect, test } from '@playwright/test'
import { PASSWORD, expireSessions, makeBrand, makeItem, makeUser, signIn, unique } from './control.ts'

// Acceptance test 8, the screen half: who is held at the enrolment screen, who signs in with a password alone,
// and what happens when the session runs out.
test.describe('sign-in gate', () => {
  test('an approver who has not enrolled is held at /enrol on every address', async ({ page }) => {
    const brandId = await makeBrand(unique('gate'))
    const approver = await makeUser({
      email: `${unique('approver')}@e2e.test`,
      role: 'approver',
      brandId,
    })

    await signIn(page, approver)
    await expect(page).toHaveURL(/\/enrol$/)
    await expect(page.getByRole('heading', { name: 'Set up your second factor', level: 1 })).toBeVisible()

    // The inbox and the front page both send the person back.
    await page.goto(`/b/${brandId}/inbox`)
    await expect(page).toHaveURL(/\/enrol$/)
    await page.goto('/')
    await expect(page).toHaveURL(/\/enrol$/)
    await expect(page.getByRole('heading', { name: 'Set up your second factor', level: 1 })).toBeVisible()
  })

  test('a viewer signs in with email and password only and sees the inbox read-only', async ({ page }) => {
    const brandId = await makeBrand(unique('viewer'))
    const viewer = await makeUser({ email: `${unique('viewer')}@e2e.test`, role: 'viewer', brandId })
    await makeItem(brandId, 'Autumn offer')

    await page.goto('/sign-in')
    await page.getByLabel('Email').fill(viewer.email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    // No code is asked for: the next screen is not the code screen.
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'))
    await expect(page).not.toHaveURL(/\/enrol$/)

    await page.goto(`/b/${brandId}/inbox`)
    await expect(page.getByRole('link', { name: 'Autumn offer' })).toBeVisible()
    await page.getByRole('link', { name: 'Autumn offer' }).click()
    await expect(page.getByRole('heading', { name: 'Autumn offer', level: 1 })).toBeVisible()
    // Read-only: nothing to decide with.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0)
  })

  test('after the idle timeout a click returns to sign-in and, after signing in, to the same page', async ({
    page,
  }) => {
    const brandId = await makeBrand(unique('idle'))
    const viewer = await makeUser({ email: `${unique('idle')}@e2e.test`, role: 'viewer', brandId })
    const { itemId } = await makeItem(brandId, 'Winter offer')

    await signIn(page, viewer)
    await page.goto(`/b/${brandId}/inbox`)
    await expect(page.getByRole('link', { name: 'Winter offer' })).toBeVisible()

    // The server ends the session, as thirty idle minutes do. The page does not know yet.
    await expireSessions(viewer.email)
    await page.getByRole('link', { name: 'Winter offer' }).click()
    await expect(page).toHaveURL(/\/sign-in\?next=/)

    await page.getByLabel('Email').fill(viewer.email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(new RegExp(`/b/${brandId}/inbox/${itemId}$`))
    await expect(page.getByRole('heading', { name: 'Winter offer', level: 1 })).toBeVisible()
  })
})
