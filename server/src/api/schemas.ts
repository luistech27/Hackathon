import { z } from 'zod'

const MAX_ID = 2_147_483_647 // Postgres INTEGER
export const MAX_AMOUNT_CENTS = 100_000_000 // $1,000,000: far above any greenhouse budget, well inside INTEGER

// Path ids arrive as text; only plain positive integers that fit the column get through.
export const idParams = z.object({
  id: z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/)
    .transform(Number)
    .refine((id) => id <= MAX_ID)
})

export const cents = z.number().int().min(0).max(MAX_AMOUNT_CENTS)

// An id inside a JSON body.
export const dbId = z.number().int().min(1).max(MAX_ID)

// Names people type and other people read: trimmed and short, with no invisible or text-reversing
// characters that could make one supplier look like another.
export const displayName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u)
  .transform((name) => name.normalize('NFC'))

// For PATCH bodies where every field is optional: at least one must be there.
export const hasAnyField = (body: object): boolean => Object.values(body).some((value) => value !== undefined)
