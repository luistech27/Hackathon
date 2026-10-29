import { expect, type Locator, type Page } from '@playwright/test'
import { TEST_DEVICE_KEY, TEST_PASSWORD } from '../src/testing.ts'

export const USERS = {
  operator: 'operador@agroandes.test',
  greenhouseManager: 'encargado@agroandes.test',
  purchasing: 'compras@agroandes.test',
  manager: 'gerente@agroandes.test'
}

// Logs in through the form, after ending any session the page already had.
export async function logIn(page: Page, email: string): Promise<void> {
  await page.request.post('/api/auth/logout')
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Greenhouses' })).toBeVisible()
}

// Each spec starts from the demo as seeded, as the manager.
export async function restartDemo(page: Page): Promise<void> {
  await logIn(page, USERS.manager)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Restart demo' }).click()
  await expect(page.getByText('The demo started over.')).toBeVisible()
}

// A range input cannot be typed into: set it and fire the events a drag would.
export async function setSlider(slider: Locator, value: number): Promise<void> {
  await slider.evaluate((input: HTMLInputElement, level: string) => {
    input.value = level
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, String(value))
}

// What the real ESP32 of greenhouse 1 would post. The server takes one post every 5 seconds per device,
// so a refused one is sent again.
export async function postReading(page: Page, supplyId: 'fertilizer' | 'water', level: number): Promise<void> {
  await expect(async () => {
    const res = await page.request.post('/api/readings', {
      headers: { 'x-device-key': TEST_DEVICE_KEY },
      data: { readings: [{ supplyId, level }] }
    })
    expect(res.status()).toBe(201)
  }).toPass({ intervals: [1_000], timeout: 10_000 })
}
