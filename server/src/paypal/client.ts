import { randomUUID } from 'node:crypto'
import { z } from 'zod'

// The few PayPal REST calls the app needs: save the company's PayPal account once (Vault, without a
// purchase), then charge it for each approved order with nobody present.

export interface PayPalSettings {
  baseUrl: string // https://api-m.sandbox.paypal.com or https://api-m.paypal.com
  clientId: string
  clientSecret: string
  fetch?: typeof globalThis.fetch // tests pass a fake
  timeoutMs?: number
}

export interface SetupToken {
  id: string
  approveUrl: string // where the manager logs in to PayPal and approves
}

export interface SavedAccount {
  vaultId: string // PayPal's payment token: charges this account, but only with this app's credentials
  customerId: string | null
  payerEmail: string | null
}

export interface ChargeRequest {
  requestId: string // PayPal-Request-Id: send the same one again and PayPal returns the first result
  amountCents: number
  currency: string
  description: string
  customId: string // our own reference, shown in PayPal's records
  vaultId: string
}

export interface PayPalPayment {
  orderId: string
  orderStatus: string
  captureId: string | null
  captureStatus: string | null // COMPLETED means the money moved
}

export interface PayPal {
  createSetupToken(urls: { returnUrl: string; cancelUrl: string }): Promise<SetupToken>
  saveAccount(setupTokenId: string): Promise<SavedAccount>
  charge(request: ChargeRequest): Promise<PayPalPayment>
  getPayment(orderId: string): Promise<PayPalPayment>
}

// definite: PayPal answered and did not do it. Otherwise it may have, so retry with the same request id.
// sent false: the request never got past this app's own credentials (no access token, or PayPal refused
// the app), so nothing happened and the same request can simply wait and go again later.
export class PayPalError extends Error {
  readonly status: number | null // null: no answer
  readonly issue: string // PayPal's error code (INSTRUMENT_DECLINED...), never its free text
  readonly definite: boolean
  readonly sent: boolean

  constructor(status: number | null, issue: string, definite: boolean, sent = true) {
    super(`PayPal ${status ?? 'did not answer'}: ${issue}`)
    this.name = 'PayPalError'
    this.status = status
    this.issue = issue
    this.definite = definite
    this.sent = sent
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const TOKEN_MARGIN_MS = 5 * 60_000 // ask for a new access token this long before the old one expires
const MAX_DESCRIPTION_LENGTH = 127 // PayPal's limit for purchase_units.description
const ZERO_DECIMAL_CURRENCIES = new Set(['HUF', 'JPY', 'TWD']) // PayPal takes no cents for these

const tokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() })
const setupTokenResponse = z.object({
  id: z.string().min(1),
  links: z.array(z.object({ rel: z.string(), href: z.string() }))
})
const paymentTokenResponse = z.object({
  id: z.string().min(1),
  customer: z.object({ id: z.string().optional() }).optional(),
  payment_source: z.object({ paypal: z.object({ email_address: z.string().optional() }).optional() }).optional()
})
const orderResponse = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  purchase_units: z
    .array(
      z.object({
        payments: z.object({ captures: z.array(z.object({ id: z.string(), status: z.string() })).optional() }).optional()
      })
    )
    .optional()
})
const errorResponse = z.object({
  name: z.string().optional(),
  error: z.string().optional(), // the token endpoint uses OAuth's shape
  details: z.array(z.object({ issue: z.string().optional() })).optional()
})

const PAYPAL_ORDER_ID = /^[A-Z0-9]{1,36}$/
const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/

export function createPayPal(settings: PayPalSettings): PayPal {
  const fetch = settings.fetch ?? globalThis.fetch
  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let token: { value: string; expiresAt: number } | null = null

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value
    const basic = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64')
    try {
      const body = await send(`${settings.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
      })
      const parsed = parse(tokenResponse, body)
      token = { value: parsed.access_token, expiresAt: Date.now() + parsed.expires_in * 1000 - TOKEN_MARGIN_MS }
      return token.value
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error
      throw new PayPalError(error.status, error.issue, true, false) // the real request was never sent
    }
  }

  // One API call, with a fresh token once if PayPal says the cached one is no longer valid. PayPal
  // refusing the app itself (401 even then, or 403) means the request was not acted on.
  async function call(path: string, init: { method: string; body?: unknown; requestId?: string }): Promise<unknown> {
    const request = async () =>
      send(`${settings.baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          'content-type': 'application/json',
          prefer: 'return=representation',
          ...(init.method === 'POST' ? { 'paypal-request-id': init.requestId ?? randomUUID() } : {})
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      })
    try {
      return await request()
    } catch (error) {
      if (!(error instanceof PayPalError) || error.status !== 401) throw refusedApp(error)
      token = null
      return request().catch((retryError: unknown) => {
        throw refusedApp(retryError)
      })
    }
  }

  async function send(url: string, init: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw new PayPalError(null, 'NO_RESPONSE', false)
    }
    const body: unknown = await response.json().catch(() => null)
    if (response.ok) return body
    throw new PayPalError(response.status, errorCode(body, response.status), isDefinite(response.status))
  }

  return {
    async createSetupToken({ returnUrl, cancelUrl }) {
      const body = await call('/v3/vault/setup-tokens', {
        method: 'POST',
        body: {
          payment_source: {
            paypal: {
              description: 'Pays the supplier orders your purchasing rules approve',
              usage_pattern: 'IMMEDIATE',
              usage_type: 'MERCHANT',
              customer_type: 'CONSUMER',
              experience_context: { brand_name: 'Autonomous Greenhouse', return_url: returnUrl, cancel_url: cancelUrl }
            }
          }
        }
      })
      const setup = parse(setupTokenResponse, body)
      const approveUrl = setup.links.find((link) => link.rel === 'approve')?.href
      // The manager's browser is sent there: never anywhere but PayPal.
      if (!approveUrl || !isPayPalUrl(approveUrl)) throw new PayPalError(null, 'UNEXPECTED_RESPONSE', true)
      return { id: setup.id, approveUrl }
    },

    async saveAccount(setupTokenId) {
      const body = await call('/v3/vault/payment-tokens', {
        method: 'POST',
        body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } }
      })
      const saved = parse(paymentTokenResponse, body)
      return {
        vaultId: saved.id,
        customerId: saved.customer?.id ?? null,
        payerEmail: saved.payment_source?.paypal?.email_address ?? null
      }
    },

    async charge(request) {
      const value = formatAmount(request.amountCents, request.currency)
      const body = await call('/v2/checkout/orders', {
        method: 'POST',
        requestId: request.requestId,
        body: {
          intent: 'CAPTURE',
          purchase_units: [
            {
              custom_id: request.customId,
              description: request.description.slice(0, MAX_DESCRIPTION_LENGTH),
              amount: { currency_code: request.currency, value }
            }
          ],
          payment_source: { paypal: { vault_id: request.vaultId } }
        }
      })
      return toPayment(parse(orderResponse, body))
    },

    async getPayment(orderId) {
      if (!PAYPAL_ORDER_ID.test(orderId)) throw new RangeError('Not a PayPal order id')
      return toPayment(parse(orderResponse, await call(`/v2/checkout/orders/${orderId}`, { method: 'GET' })))
    }
  }
}

// PayPal wants "64.00", not 6400 cents.
export function formatAmount(amountCents: number, currency: string): string {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new RangeError('Amount must be whole cents above 0')
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) throw new RangeError(`${currency} has no cents; it is not supported yet`)
  const units = Math.floor(amountCents / 100)
  return `${units}.${String(amountCents % 100).padStart(2, '0')}`
}

function toPayment(order: z.infer<typeof orderResponse>): PayPalPayment {
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
  return { orderId: order.id, orderStatus: order.status, captureId: capture?.id ?? null, captureStatus: capture?.status ?? null }
}

// A success we cannot read may still have moved money, so it is not a definite failure.
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new PayPalError(null, 'UNEXPECTED_RESPONSE', false)
  return parsed.data
}

function errorCode(body: unknown, status: number): string {
  const parsed = errorResponse.safeParse(body)
  const code = parsed.success ? (parsed.data.details?.[0]?.issue ?? parsed.data.name ?? parsed.data.error) : undefined
  return code && ERROR_CODE.test(code) ? code : `HTTP_${status}`
}

function refusedApp(error: unknown): unknown {
  if (!(error instanceof PayPalError) || (error.status !== 401 && error.status !== 403)) return error
  return new PayPalError(error.status, error.issue, true, false)
}

// 409: a request with the same id is still being processed. 408/429/5xx: try again later.
function isDefinite(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 429].includes(status)
}

function isPayPalUrl(href: string): boolean {
  try {
    const url = new URL(href)
    return url.protocol === 'https:' && (url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com'))
  } catch {
    return false
  }
}
