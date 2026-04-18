import './setup.js'
import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { SymbolLink } from '../../src/web/client/ui/symbol-link.js'
import { FileLink } from '../../src/web/client/ui/file-link.js'

describe('SymbolLink', () => {
	test('renders a link to /s/<encoded-qn> with kind badge', () => {
		const { hook } = memoryLocation({ path: '/' })
		render(
			<Router hook={hook}>
				<SymbolLink name="createApp" qualifiedName="src/web/server.ts::createApp" kind="function" />
			</Router>,
		)
		const link = screen.getByRole('link') as HTMLAnchorElement
		expect(link.getAttribute('href')).toBe('/s/' + encodeURIComponent('src/web/server.ts::createApp'))
		expect(link.textContent).toContain('createApp')
		expect(link.textContent).toContain('function')
	})
})

describe('FileLink', () => {
	test('renders a link to /f/<path> with line suffix', () => {
		const { hook } = memoryLocation({ path: '/' })
		render(
			<Router hook={hook}>
				<FileLink path="src/web/server.ts" line={42} />
			</Router>,
		)
		const link = screen.getByRole('link') as HTMLAnchorElement
		expect(link.getAttribute('href')).toBe('/f/src/web/server.ts')
		expect(link.textContent).toContain('src/web/server.ts:42')
	})

	test('basename mode shows just the file name', () => {
		const { hook } = memoryLocation({ path: '/' })
		render(
			<Router hook={hook}>
				<FileLink path="src/web/server.ts" basename />
			</Router>,
		)
		const link = screen.getByRole('link') as HTMLAnchorElement
		expect(link.textContent).toBe('server.ts')
	})
})
