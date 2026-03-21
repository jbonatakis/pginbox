export const UserRole = { Member: 'member', Admin: 'admin' } as const
export type UserRole = (typeof UserRole)[keyof typeof UserRole]
