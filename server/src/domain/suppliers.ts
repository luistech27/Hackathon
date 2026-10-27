export interface SupplierOffer {
  supplierId: string
  supplyId: string
  packSize: number // grams or liters per pack
  packPriceCents: number
  minPacks: number
  leadTimeDays: number
}

export interface OfferRequest {
  supplyId: string
  neededAmount: number
  daysLeft: number
  allowedSupplierIds: readonly string[]
}

export interface Quote {
  offer: SupplierOffer
  packs: number
  totalCents: number
  arrivesInTime: boolean
}

// Cheapest delivery that arrives before the supply runs out; if none can, the fastest one.
export function chooseOffer(offers: readonly SupplierOffer[], request: OfferRequest): Quote | null {
  if (!Number.isFinite(request.neededAmount) || request.neededAmount <= 0) {
    throw new RangeError(`neededAmount must be positive, got ${request.neededAmount}`)
  }

  const quotes = offers
    .filter((o) => o.supplyId === request.supplyId && request.allowedSupplierIds.includes(o.supplierId))
    .filter(isValidOffer)
    .map((o) => toQuote(o, request))
  const onTime = quotes.filter((q) => q.arrivesInTime)
  const ranked = onTime.length > 0 ? onTime.toSorted(byPriceThenSpeed) : quotes.toSorted(bySpeedThenPrice)

  return ranked[0] ?? null
}

function toQuote(offer: SupplierOffer, request: OfferRequest): Quote {
  const packs = Math.max(offer.minPacks, Math.ceil(request.neededAmount / offer.packSize))
  return {
    offer,
    packs,
    totalCents: packs * offer.packPriceCents,
    // Arriving the same day it runs out is too late: the forecast is never exact.
    arrivesInTime: offer.leadTimeDays < request.daysLeft
  }
}

// One bad catalog row must not win the ranking or make the budget gate throw.
function isValidOffer(offer: SupplierOffer): boolean {
  return (
    offer.packSize > 0 &&
    Number.isSafeInteger(offer.packPriceCents) &&
    offer.packPriceCents > 0 &&
    Number.isInteger(offer.minPacks) &&
    offer.minPacks >= 1 &&
    offer.leadTimeDays >= 0
  )
}

const byPriceThenSpeed = (a: Quote, b: Quote): number =>
  a.totalCents - b.totalCents || a.offer.leadTimeDays - b.offer.leadTimeDays

const bySpeedThenPrice = (a: Quote, b: Quote): number =>
  a.offer.leadTimeDays - b.offer.leadTimeDays || a.totalCents - b.totalCents
