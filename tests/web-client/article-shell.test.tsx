import './setup.js'
import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { ArticleShell, ArticleHeader, FactList } from '../../src/web/client/components/article-shell.js'
import { Section } from '../../src/web/client/ui/section.js'

describe('ArticleShell', () => {
	test('renders header, sections, and aside', () => {
		const { hook } = memoryLocation({ path: '/' })
		render(
			<Router hook={hook}>
				<ArticleShell
					header={<ArticleHeader title="example symbol" subtitle="a test fixture" />}
					aside={<FactList items={[{ label: 'kind', value: 'function' }]} />}
				>
					<Section id="overview" title="overview">overview body</Section>
					<Section id="source" title="source">source body</Section>
				</ArticleShell>
			</Router>,
		)
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('example symbol')
		expect(screen.getByText('overview body')).toBeDefined()
		expect(screen.getByText('source body')).toBeDefined()
		// outline rail registers two entries
		const overview = document.getElementById('overview')
		const source = document.getElementById('source')
		expect(overview).not.toBeNull()
		expect(source).not.toBeNull()
		// fact list label is rendered
		expect(screen.getByText('kind')).toBeDefined()
	})
})
