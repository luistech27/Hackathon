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
