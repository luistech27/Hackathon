// Every response uses the same envelope: { success, data } or { success, error }.

export type ApiResponse<T> = { success: true; data: T } | { success: false; error: string }

export const ok = <T>(data: T): ApiResponse<T> => ({ success: true, data })

export const fail = (error: string): ApiResponse<never> => ({ success: false, error })
