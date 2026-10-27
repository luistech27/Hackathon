import { describe, expect, it } from 'vitest'
import { chooseOffer, type OfferRequest, type SupplierOffer } from './suppliers.js'

const tiendaPapas: SupplierOffer = {
  supplierId: 'tienda-papas',
  supplyId: 'fertilizer',
  packSize: 1000,
  packPriceCents: 800,
  minPacks: 1,
  leadTimeDays: 1
}
const agroCentro: SupplierOffer = {
  supplierId: 'agro-centro',
  supplyId: 'fertilizer',
  packSize: 5000,
  packPriceCents: 3000,
  minPacks: 1,
  leadTimeDays: 4
}
const aguaYa: SupplierOffer = {
  supplierId: 'agua-ya',
  supplyId: 'water',
  packSize: 20,
  packPriceCents: 150,
  minPacks: 5,
  leadTimeDays: 1
}
const catalog = [tiendaPapas, agroCentro, aguaYa]

const request = (overrides: Partial<OfferRequest> = {}): OfferRequest => ({
  supplyId: 'fertilizer',
  neededAmount: 4500,
  daysLeft: 10,
  allowedSupplierIds: ['tienda-papas', 'agro-centro', 'agua-ya', 'twin'],
  ...overrides
})

describe('chooseOffer', () => {
  it('buys enough whole packs to cover the needed amount', () => {
    const quote = chooseOffer([tiendaPapas], request({ neededAmount: 2500 }))

    expect(quote).toMatchObject({ packs: 3, totalCents: 2400 })
  })

  it('respects the supplier minimum order', () => {
    const quote = chooseOffer(catalog, request({ supplyId: 'water', neededAmount: 30 }))

    expect(quote).toMatchObject({ offer: aguaYa, packs: 5, totalCents: 750 })
  })

  it('picks the cheapest offer that arrives in time', () => {
    // 4500 g: one 5 kg bag at 30.00 beats five 1 kg bags at 40.00
    const quote = chooseOffer(catalog, request({ daysLeft: 10 }))

    expect(quote?.offer).toBe(agroCentro)
  })

  it('skips offers that arrive after the supply runs out', () => {
    const quote = chooseOffer(catalog, request({ daysLeft: 2 }))

    expect(quote).toMatchObject({ offer: tiendaPapas, arrivesInTime: true })
  })

  it('counts a delivery on the day the supply runs out as late', () => {
    const quote = chooseOffer(catalog, request({ daysLeft: 4 }))

    expect(quote?.offer).toBe(tiendaPapas)
  })

  it.each([{ packSize: 0 }, { packSize: -1 }, { packPriceCents: 0 }, { packPriceCents: 10.5 }, { minPacks: 0 }, { leadTimeDays: -1 }])(
    'skips a broken catalog row %o',
    (broken) => {
      const brokenCheap = { ...agroCentro, supplierId: 'twin', ...broken }

      expect(chooseOffer([brokenCheap, tiendaPapas], request())?.offer).toBe(tiendaPapas)
    }
  )

  it('falls back to the fastest offer when none arrives in time', () => {
    const quote = chooseOffer(catalog, request({ daysLeft: 0.5 }))

    expect(quote).toMatchObject({ offer: tiendaPapas, arrivesInTime: false })
  })

  it('breaks price ties with the faster delivery', () => {
    const slowTwin = { ...tiendaPapas, supplierId: 'twin', leadTimeDays: 3 }

    expect(chooseOffer([slowTwin, tiendaPapas], request())?.offer).toBe(tiendaPapas)
  })

  it('breaks speed ties among late offers with the lower price', () => {
    const pricierTwin = { ...tiendaPapas, supplierId: 'twin', packPriceCents: 900 }

    expect(chooseOffer([pricierTwin, tiendaPapas], request({ daysLeft: 0.5 }))?.offer).toBe(tiendaPapas)
  })

  it('ignores suppliers the owner has not allowed', () => {
    const quote = chooseOffer(catalog, request({ allowedSupplierIds: ['tienda-papas'] }))

    expect(quote?.offer).toBe(tiendaPapas)
  })

  it('returns null when no allowed supplier sells the supply', () => {
    expect(chooseOffer(catalog, request({ allowedSupplierIds: [] }))).toBeNull()
  })

  it.each([0, -1, NaN])('rejects a needed amount of %s', (neededAmount) => {
    expect(() => chooseOffer(catalog, request({ neededAmount }))).toThrow(RangeError)
  })
})
