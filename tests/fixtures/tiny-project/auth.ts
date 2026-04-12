import { Database } from './db.js'

export interface User {
	id: string
	email: string
}

export class AuthService {
	constructor(private db: Database) {}

	login(email: string, _password: string): User | null {
		const rows = this.db.query<User>(`SELECT * FROM users WHERE email = '${email}'`)
		return rows[0] ?? null
	}

	logout(_user: User): void {
		// no-op for fixture
	}
}

export function createAuthService(db: Database): AuthService {
	return new AuthService(db)
}
