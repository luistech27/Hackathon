import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { restartDemo, setSlider } from './helpers.ts'

// Supply 3 is the simulated NPK tank of greenhouse 2: 50 kg, its fastest supplier AgroInsumos Andinos
// (25 kg bags at $32, 2 days). The scripted Claude orders the fastest offer, enough to fill the tank.
test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await restartDemo(page)
  // Greenhouse 1's real sensor readings survive a restart: the agent must find nothing to buy there.
  await expect(page.locator('[data-supply="1"]')).not.toHaveAttribute('data-state', 'reorder')
})

test.afterAll(async () => {
  await page.close()
})

test('a tank set below its line is flagged for the agent', async () => {
  const npk = page.locator('[data-supply="3"]')

  await setSlider(npk.getByRole('slider'), 5_000)

  await expect(npk).toHaveAttribute('data-state', 'reorder')
  await expect(npk.getByText('Below the line: the agent orders it')).toBeVisible()
})

test('running the agent orders it, and PayPal pays it right away', async () => {
  await page.getByRole('button', { name: 'Run the agent now' }).click()

  await expect(page.getByText('Claude looked at 1 greenhouse and placed 1 order.')).toBeVisible()
  await expect(page.locator('.run').first()).toContainText('Ordered in Invernadero 2 · Pimiento')
  const order = page.locator('#orders .order').first()
  await expect(order).toContainText('AgroInsumos Andinos')
  await expect(order).toContainText('2 × 25 kg Fertilizante NPK 15-15-15')
  await expect(order).toContainText('Paid with PayPal')
  await expect(order.locator('.order-number')).toHaveText(/^PO-\d{4}-\d{4,}$/)
  await expect(page.locator('[data-supply="3"]')).toHaveAttribute('data-state', 'ordered')
})

test('confirming the delivery refills the simulated tank', async () => {
  const delivery = page.locator('#inbox .order').first()

  await delivery.getByRole('button', { name: 'Confirm delivery' }).click()
  await delivery.getByRole('button', { name: 'Confirm delivery' }).click() // the form's, with every pack

  await expect(page.getByText(/delivered in full/)).toBeVisible()
  await expect(page.locator('#inbox-section')).toBeHidden()
  await expect(page.locator('[data-supply="3"] .tank-amount')).toHaveText('50 kg of 50 kg')
})

test('a budget too small for any order stops the agent from buying', async () => {
  const greenhouse = page.locator('.greenhouse', { hasText: 'Invernadero 3 · Rosas' })
  await greenhouse.getByRole('button', { name: 'Change budget' }).click()
  await greenhouse.getByLabel('Monthly budget in USD').fill('10')
  await greenhouse.getByRole('button', { name: 'Save budget' }).click()
  await expect(page.getByText('Invernadero 3 · Rosas: budget set to $10.00 a month.')).toBeVisible()
  await setSlider(page.locator('[data-supply="6"]').getByRole('slider'), 5_000)

  await page.getByRole('button', { name: 'Run the agent now' }).click()

  await expect(page.getByText('Not enough budget left this month for any order of what needs restocking')).toBeVisible()
})

test("the month's CSV lists the purchase order with its payment and delivery", async () => {
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: /^Download .* purchase orders \(CSV\)$/ }).click()

  const file = await download
  const csv = await readFile(await file.path(), 'utf8')
  expect(file.suggestedFilename()).toMatch(/^purchase-orders-\d{4}-\d{2}\.csv$/)
  const poNumber = await page.locator('#orders .order .order-number').first().textContent()
  const row = csv.split('\r\n').find((line) => line.startsWith(`${poNumber},`))
  expect(row).toContain(',AgroInsumos Andinos,')
  expect(row).toContain(',64.00,USD,')
  expect(row).toContain(',paid,')
  expect(row).toContain(',Complete,')
})
