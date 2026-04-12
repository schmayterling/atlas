import { createAuthService, type User } from './auth.js'
import { makeDatabase } from './db.js'
import { slugify } from './utils.js'

const db = makeDatabase()
const auth = createAuthService(db)

export function loginRoute(email: string, password: string): User | null {
	return auth.login(email, password)
}

export function profileSlug(user: User): string {
	return slugify(user.email)
}
