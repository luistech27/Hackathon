import { describe, expect, it } from 'vitest'
import { createPayPal, formatAmount, PayPalError, type ChargeRequest } from './client.ts'

const BASE = 'https://api-m.sandbox.paypal.com'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

type Answer = { status: number; body: unknown } | Error

// A fake PayPal: the token endpoint always works; every other request gets the next scripted answer.
function fakePayPal(answers: Answer[], { tokenSeconds = 3600 } = {}) {
  const calls: Call[] = []
  let tokens = 0
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? init.body : ''
    }
    calls.push(call)
    if (call.url.endsWith('/v1/oauth2/token')) {
      tokens += 1
      return Response.json({ access_token: `token-${tokens}`, token_type: 'Bearer', expires_in: tokenSeconds })
    }
    const answer = answers.shift()
    if (!answer) throw new Error(`Unexpected request to ${call.url}`)
    if (answer instanceof Error) throw answer
    return Response.json(answer.body, { status: answer.status })
  }
  const paypal = createPayPal({ baseUrl: BASE, clientId: 'client-id', clientSecret: 'client-secret', fetch })
  const apiCalls = () => calls.filter((call) => !call.url.endsWith('/v1/oauth2/token'))
  return { paypal, calls, apiCalls, tokensIssued: () => tokens }
}

const charge: ChargeRequest = {
  requestId: '6f1c2a54-2f4e-4c1e-9c43-1d2f3a4b5c6d',
  amountCents: 6400,
  currency: 'USD',
  description: 'Order 7: AgroInsumos Andinos',
  customId: 'order-7',
  vaultId: 'vault-123'
}

const completedOrder = (captureStatus = 'COMPLETED') => ({
  id: '5O190127TN364715T',
  status: 'COMPLETED',
  purchase_units: [{ payments: { captures: [{ id: '3B017991HX624902V', status: captureStatus }] } }]
})

const paypalError = (status: number, name: string, issue?: string) => ({
  status,
  body: { name, message: 'Raw text that must never be stored', debug_id: 'dbg-1', details: issue ? [{ issue }] : [] }
})

describe('createPayPal', () => {
  describe('createSetupToken', () => {
    it('asks PayPal to save a PayPal account for later payments and returns where the manager approves it', async () => {
      const { paypal, apiCalls } = fakePayPal([
        {
          status: 200,
          body: {
            id: '5C991763VB2781612',
            status: 'PAYER_ACTION_REQUIRED',
            links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=x' }]
          }
        }
      ])

      const token = await paypal.createSetupToken({
        returnUrl: 'https://app.example/?paypal=approved',
        cancelUrl: 'https://app.example/?paypal=cancelled'
      })

      expect(token).toEqual({
        id: '5C991763VB2781612',
        approveUrl: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=x'
      })
      const [call] = apiCalls()
      expect(call?.url).toBe(`${BASE}/v3/vault/setup-tokens`)
      expect(call?.headers.authorization).toBe('Bearer token-1')
      expect(call?.headers['paypal-request-id']).toMatch(/^[0-9a-f-]{36}$/)
      expect(JSON.parse(call?.body ?? '')).toMatchObject({
        payment_source: {
          paypal: {
            usage_type: 'MERCHANT',
            experience_context: {
              return_url: 'https://app.example/?paypal=approved',
              cancel_url: 'https://app.example/?paypal=cancelled'
            }
          }
        }
      })
    })

    it('refuses an approval link that does not point at PayPal', async () => {
      const { paypal } = fakePayPal([
        { status: 200, body: { id: 'ABC', links: [{ rel: 'approve', href: 'https://evil.example/approve' }] } }
      ])

      await expect(paypal.createSetupToken({ returnUrl: 'https://a.example', cancelUrl: 'https://a.example' })).rejects.toThrow(
        PayPalError
      )
    })
  })

  describe('saveAccount', () => {
    it('turns the approved setup token into a saved account', async () => {
      const { paypal, apiCalls } = fakePayPal([
        {
          status: 201,
          body: {
            id: 'jwgvx42',
            customer: { id: 'customer_4029352051' },
            payment_source: { paypal: { email_address: 'buyer@example.com' } }
          }
        }
      ])

      expect(await paypal.saveAccount('5C991763VB2781612')).toEqual({
        vaultId: 'jwgvx42',
        customerId: 'customer_4029352051',
        payerEmail: 'buyer@example.com'
      })
      expect(JSON.parse(apiCalls()[0]?.body ?? '')).toEqual({
        payment_source: { token: { id: '5C991763VB2781612', type: 'SETUP_TOKEN' } }
      })
    })

    it('tells a manager who did not approve at PayPal apart from a PayPal outage', async () => {
      const { paypal } = fakePayPal([paypalError(422, 'UNPROCESSABLE_ENTITY', 'SETUP_TOKEN_NOT_APPROVED')])

      const error = await paypal.saveAccount('5C991763VB2781612').catch((e: unknown) => e)

      expect(error).toBeInstanceOf(PayPalError)
      expect(error).toMatchObject({ status: 422, issue: 'SETUP_TOKEN_NOT_APPROVED', definite: true })
    })
  })

  describe('charge', () => {
    it('charges the saved account with the request id, so a retry never charges twice', async () => {
      const { paypal, apiCalls } = fakePayPal([{ status: 201, body: completedOrder() }])

      const payment = await paypal.charge(charge)

      expect(payment).toEqual({
        orderId: '5O190127TN364715T',
        orderStatus: 'COMPLETED',
        captureId: '3B017991HX624902V',
        captureStatus: 'COMPLETED'
      })
      const [call] = apiCalls()
      expect(call?.url).toBe(`${BASE}/v2/checkout/orders`)
      expect(call?.headers['paypal-request-id']).toBe(charge.requestId)
      expect(call?.headers.prefer).toBe('return=representation')
      expect(JSON.parse(call?.body ?? '')).toEqual({
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'order-7',
            description: 'Order 7: AgroInsumos Andinos',
            amount: { currency_code: 'USD', value: '64.00' }
          }
        ],
        payment_source: { paypal: { vault_id: 'vault-123' } }
      })
    })

    it('reports an order PayPal did not capture', async () => {
      const { paypal } = fakePayPal([{ status: 201, body: { id: '5O1', status: 'PAYER_ACTION_REQUIRED' } }])

      expect(await paypal.charge(charge)).toEqual({
        orderId: '5O1',
        orderStatus: 'PAYER_ACTION_REQUIRED',
        captureId: null,
        captureStatus: null
      })
    })

    it('keeps only the error code PayPal gives, never its message', async () => {
      const { paypal } = fakePayPal([paypalError(422, 'UNPROCESSABLE_ENTITY', 'INSTRUMENT_DECLINED')])

      const error = await paypal.charge(charge).catch((e: unknown) => e)

      expect(error).toMatchObject({ status: 422, issue: 'INSTRUMENT_DECLINED', definite: true })
      expect(String((error as Error).message)).not.toContain('Raw text')
    })

    it.each([
      ['a server error', paypalError(500, 'INTERNAL_SERVER_ERROR')],
      ['too many requests', paypalError(429, 'RATE_LIMIT_REACHED')],
      ['a request still in progress', paypalError(409, 'REQUEST_IN_PROGRESS')],
      ['no answer at all', new TypeError('fetch failed')]
    ])('treats %s as an unknown outcome, to retry with the same request id', async (_, answer) => {
      const { paypal } = fakePayPal([answer])

      const error = await paypal.charge(charge).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(PayPalError)
      expect((error as PayPalError).definite).toBe(false)
    })

    it('treats a success it cannot read as an unknown outcome: PayPal may have charged', async () => {
      const { paypal } = fakePayPal([{ status: 201, body: { unexpected: true } }])

      await expect(paypal.charge(charge)).rejects.toMatchObject({ issue: 'UNEXPECTED_RESPONSE', definite: false })
    })

    it('refuses an amount that is not a positive whole number of cents before calling PayPal', async () => {
      const { paypal, apiCalls } = fakePayPal([])

      await expect(paypal.charge({ ...charge, amountCents: 0 })).rejects.toThrow(RangeError)
      await expect(paypal.charge({ ...charge, amountCents: 12.5 })).rejects.toThrow(RangeError)
      expect(apiCalls()).toHaveLength(0)
    })
  })

  describe('getPayment', () => {
    it('looks up an order PayPal already has', async () => {
      const { paypal, apiCalls } = fakePayPal([{ status: 200, body: completedOrder('PENDING') }])

      expect(await paypal.getPayment('5O190127TN364715T')).toMatchObject({ captureStatus: 'PENDING' })
      expect(apiCalls()[0]).toMatchObject({ method: 'GET', url: `${BASE}/v2/checkout/orders/5O190127TN364715T` })
    })

    it('refuses an order id that could change the URL', async () => {
      const { paypal, apiCalls } = fakePayPal([])

      await expect(paypal.getPayment('../v1/oauth2/token')).rejects.toThrow(RangeError)
      expect(apiCalls()).toHaveLength(0)
    })
  })

  describe('access token', () => {
    it('reuses the access token until it is about to expire', async () => {
      const { paypal, tokensIssued } = fakePayPal([
        { status: 201, body: completedOrder() },
        { status: 201, body: completedOrder() }
      ])

      await paypal.charge(charge)
      await paypal.charge(charge)

      expect(tokensIssued()).toBe(1)
    })

    it('asks for a new token once when PayPal says the old one is no longer valid', async () => {
      const { paypal, apiCalls, tokensIssued } = fakePayPal([
        paypalError(401, 'invalid_token'),
        { status: 201, body: completedOrder() }
      ])

      expect(await paypal.charge(charge)).toMatchObject({ captureStatus: 'COMPLETED' })
      expect(tokensIssued()).toBe(2)
      expect(apiCalls()[1]?.headers.authorization).toBe('Bearer token-2')
    })

    it('says nothing was sent when PayPal keeps refusing the app', async () => {
      const { paypal } = fakePayPal([paypalError(401, 'invalid_token'), paypalError(401, 'invalid_token')])

      await expect(paypal.charge(charge)).rejects.toMatchObject({ status: 401, definite: true, sent: false })
    })

    it('says nothing was sent when the app is not allowed to do it', async () => {
      const { paypal } = fakePayPal([paypalError(403, 'PERMISSION_DENIED')])

      await expect(paypal.charge(charge)).rejects.toMatchObject({ status: 403, sent: false })
    })

    it('says nothing was sent when no access token could be had', async () => {
      const fetch = async () => {
        throw new TypeError('fetch failed')
      }
      const paypal = createPayPal({ baseUrl: BASE, clientId: 'id', clientSecret: 'secret', fetch })

      await expect(paypal.charge(charge)).rejects.toMatchObject({ issue: 'NO_RESPONSE', sent: false })
    })

    it('sends the app credentials only to the token endpoint, with basic auth', async () => {
      const { paypal, calls } = fakePayPal([{ status: 201, body: completedOrder() }])

      await paypal.charge(charge)

      const tokenCall = calls.find((call) => call.url.endsWith('/v1/oauth2/token'))
      expect(tokenCall?.headers.authorization).toBe(`Basic ${btoa('client-id:client-secret')}`)
      expect(tokenCall?.body).toBe('grant_type=client_credentials')
      expect(calls.filter((call) => call.headers.authorization?.startsWith('Basic'))).toHaveLength(1)
    })
  })
})

describe('formatAmount', () => {
  it('writes cents the way PayPal expects', () => {
    expect(formatAmount(6400, 'USD')).toBe('64.00')
    expect(formatAmount(5, 'USD')).toBe('0.05')
    expect(formatAmount(123_456_789, 'EUR')).toBe('1234567.89')
  })

  it('refuses currencies without cents, rather than charging 100 times too much', () => {
    expect(() => formatAmount(6400, 'JPY')).toThrow(RangeError)
  })
})
