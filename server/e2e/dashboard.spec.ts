import { expect, test } from '@playwright/test'
import { logIn, USERS } from './helpers.ts'

test('refuses a wrong password', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Email').fill(USERS.manager)
  await page.getByLabel('Password').fill('not-the-password')
  await page.getByRole('button', { name: 'Log in' }).click()

  await expect(page.getByText('That email and password do not match a user.')).toBeVisible()
})

test('shows the manager every greenhouse, PayPal and the demo controls', async ({ page }) => {
  await logIn(page, USERS.manager)

  await expect(page.locator('.greenhouse')).toHaveCount(3)
  await expect(page.locator('.tank')).toHaveCount(8)
  await expect(page.getByText('Approved orders are paid from pagos@agroandes.test')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Skip 1 day' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run the agent now' })).toBeVisible()
  await expect(page.getByRole('slider')).toHaveCount(6) // the simulated tanks only
})

test('shows the operator only their greenhouse, with no demo or money controls', async ({ page }) => {
  await logIn(page, USERS.operator)

  await expect(page.locator('.greenhouse')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Invernadero 1 · Tomate' })).toBeVisible()
  for (const name of ['Skip 1 day', 'Run the agent now', 'Change budget', 'Connect PayPal']) {
    await expect(page.getByRole('button', { name })).toHaveCount(0)
  }
  await expect(page.getByRole('slider')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Approval rules' })).toBeHidden()
})

test('lets the manager change what the agent pays on its own', async ({ page }) => {
  await logIn(page, USERS.manager)
  const rules = page.getByRole('region', { name: 'Approval rules' })

  await rules.getByRole('button', { name: 'Change rules' }).click()
  await rules.getByLabel('Pay on its own up to (USD)').fill('50')
  await rules.getByRole('button', { name: 'Save rules' }).click()
  await expect(rules).toContainText('The agent pays orders up to $50.00 on its own.')

  await rules.getByRole('button', { name: 'Change rules' }).click()
  await rules.getByLabel('Pay on its own up to (USD)').fill('100')
  await rules.getByRole('button', { name: 'Save rules' }).click()
  await expect(rules).toContainText('The agent pays orders up to $100.00 on its own.')
})

test('logging out leaves nothing of the last user on screen', async ({ page }) => {
  await logIn(page, USERS.manager)

  await page.getByRole('button', { name: 'Log out' }).click()

  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
  await expect(page.locator('.greenhouse')).toHaveCount(0)
  await expect(page.locator('.order')).toHaveCount(0)
  expect((await page.request.get('/api/me')).status()).toBe(401) // the session ended on the server too
})
