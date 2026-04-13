import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../shared/logger.js'

// parses a git .mailmap file into a lookup table keyed by lowercased wrong
// email. the canonical record carries the replacement name and email. see
// git-shortlog(1) for the format spec.
//
// supported lines:
//   Proper Name <commit@email.xx>
//   <proper@email.xx> <commit@email.xx>
//   Proper Name <proper@email.xx> <commit@email.xx>
//   Proper Name <proper@email.xx> Commit Name <commit@email.xx>
//   # comment
//
// the first two forms canonicalise the author by email alone. the last two
// map a specific (name, email) pair to the canonical identity.
//
// lookup order when applying: (name,email) pair first, email-only fallback.
// never falls through to name-only because the same name can belong to
// different contributors across repos.

export interface MailmapEntry {
	canonicalName: string
	canonicalEmail: string
}

export interface Mailmap {
	byPair: Map<string, MailmapEntry>
	byEmail: Map<string, MailmapEntry>
}

const EMAIL_RE = /<([^>]+)>/g

export function parseMailmap(content: string): Mailmap {
	const byPair = new Map<string, MailmapEntry>()
	const byEmail = new Map<string, MailmapEntry>()

	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue

		const emails: string[] = []
		for (const m of line.matchAll(EMAIL_RE)) {
			emails.push(m[1])
		}
		if (emails.length === 0 || emails.length > 2) continue

		// split into segments by the angle brackets so we can pull the
		// optional name parts. the segment before each <email> is the name
		// associated with that email (trimmed, may be empty).
		const firstOpen = line.indexOf('<')
		const firstClose = line.indexOf('>')
		const beforeFirst = line.slice(0, firstOpen).trim()

		if (emails.length === 1) {
			// form A: "Proper Name <commit@email>"
			const canonicalEmail = emails[0].toLowerCase()
			const canonicalName = beforeFirst || canonicalEmail
			const entry: MailmapEntry = { canonicalName, canonicalEmail }
			byEmail.set(canonicalEmail, entry)
			continue
		}

		// emails.length === 2
		const properEmail = emails[0].toLowerCase()
		const commitEmail = emails[1].toLowerCase()
		const afterFirstClose = line.slice(firstClose + 1)
		const secondOpen = afterFirstClose.indexOf('<')
		const betweenSegment = afterFirstClose.slice(0, secondOpen).trim()

		const canonicalEmail = properEmail
		const canonicalName = beforeFirst || properEmail

		const entry: MailmapEntry = { canonicalName, canonicalEmail }
		byEmail.set(commitEmail, entry)
		if (betweenSegment) {
			// form: "Proper Name <proper@email> Commit Name <commit@email>"
			const pairKey = mailmapPairKey(betweenSegment, commitEmail)
			byPair.set(pairKey, entry)
		}
	}

	return { byPair, byEmail }
}

function mailmapPairKey(name: string, email: string): string {
	return `${name.toLowerCase()}|${email.toLowerCase()}`
}

// returns the canonical (name, email) for a commit author. never throws;
// returns the original on any mismatch.
export function applyMailmap(
	mailmap: Mailmap | null,
	name: string,
	email: string,
): { name: string; email: string } {
	if (!mailmap) return { name, email }

	const pairHit = mailmap.byPair.get(mailmapPairKey(name, email))
	if (pairHit) return { name: pairHit.canonicalName, email: pairHit.canonicalEmail }

	const emailHit = mailmap.byEmail.get(email.toLowerCase())
	if (emailHit) return { name: emailHit.canonicalName, email: emailHit.canonicalEmail }

	return { name, email }
}

// loads .mailmap from the given project root. returns null when absent
// (quiet, expected) or unreadable (warn — operator should fix). missing
// file = skip canonicalisation; present-but-broken file = warn so the
// user knows why contributor dedup suddenly stopped working.
export function loadMailmap(projectRoot: string): Mailmap | null {
	const path = join(projectRoot, '.mailmap')
	if (!existsSync(path)) return null
	try {
		return parseMailmap(readFileSync(path, 'utf-8'))
	} catch (e) {
		log.warn(`failed to read .mailmap at ${path}: ${e}`)
		return null
	}
}
