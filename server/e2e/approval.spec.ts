import { expect, test, type Page } from '@playwright/test'
import { logIn, postReading, restartDemo, USERS } from './helpers.ts'

// Greenhouse 1 has the real ESP32: its scale reports 4 kg of the 50 kg NPK container. With the agent in
// approval mode, the scripted Claude's order (2 bags, $64) waits for the greenhouse manager.
test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await restartDemo(page)
  await postReading(page, 'fertilizer', 4_000)
})

test.afterAll(async () => {
  // The ESP32's readings outlive a demo restart: leave the container full for the other specs.
  await postReading(page, 'fertilizer', 50_000)
  await postReading(page, 'fertilizer', 50_000)
  await restartDemo(page)
  await page.close()
})

test('the manager turns on approval mode from the dashboard', async () => {
  const rules = page.getByRole('region', { name: 'Approval rules' })
  await expect(rules).toContainText('The agent pays orders up to $100.00 on its own.')

  await rules.getByRole('button', { name: 'Change rules' }).click()
  await rules.getByLabel('Approval mode: ask a person before every order').check()
  await expect(rules.getByLabel('Pay on its own up to (USD)')).toBeDisabled()
  await rules.getByRole('button', { name: 'Save rules' }).click()

  await expect(page.getByText(/^Approval rules saved\. Approval mode:/)).toBeVisible()
  await expect(rules).toContainText('every order the agent places waits for a person')
})

test('in approval mode the order the agent places waits for a person', async () => {
  await page.reload()
  await page.getByRole('button', { name: 'Run the agent now' }).click()

  await expect(page.getByText('Claude looked at 1 greenhouse and placed 1 order.')).toBeVisible()
  await expect(page.locator('#orders .order').first()).toContainText('Waiting for the greenhouse manager')
})

test('purchasing sees the request in the history but has nothing to approve or receive', async () => {
  await logIn(page, USERS.purchasing)

  // The history and the inbox are drawn together: once the order shows, the inbox is final.
  await expect(page.locator('#orders .order').first()).toContainText('Waiting for the greenhouse manager')
  await expect(page.locator('#inbox-section')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
})

test('the greenhouse manager approves it from their inbox, and PayPal pays it', async () => {
  await logIn(page, USERS.greenhouseManager)
  const request = page.locator('#inbox .order').first()
  await expect(request).toContainText('Waiting for the greenhouse manager')

  await request.getByRole('button', { name: 'Approve' }).click()

  await expect(page.getByText(/^PO-\d{4}-\d{4,} approved and paid with PayPal\.$/)).toBeVisible()
})

test('the operator reports a short delivery, which stays marked for review', async () => {
  await logIn(page, USERS.operator)
  const delivery = page.locator('#inbox .order').first()

  await delivery.getByRole('button', { name: 'Confirm delivery' }).click()
  await delivery.getByRole('spinbutton').fill('1')
  await delivery.getByLabel('Note for the manager (optional)').fill('One bag arrived torn.')
  await delivery.getByRole('button', { name: 'Confirm delivery' }).click()

  await expect(page.getByText(/short delivery saved and marked for the manager to review/)).toBeVisible()
  const order = page.locator('#orders .order').first()
  await expect(order).toContainText('Short delivery: only 1 of 2 × 25 kg Fertilizante NPK 15-15-15 arrived')
  await expect(order).toContainText('One bag arrived torn.')
})
