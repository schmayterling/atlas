// theme: 'light' | 'dark' | 'system'. persisted in localStorage.
// applied by setting data-theme on <html> (light is the default, no attr).

import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'atlas-theme'

function systemPrefersDark(): boolean {
	return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

function applyTheme(theme: Theme) {
	const root = document.documentElement
	const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark())
	if (dark) root.setAttribute('data-theme', 'dark')
	else root.removeAttribute('data-theme')
}

export function getTheme(): Theme {
	const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
	if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
	return 'light'
}

export function setTheme(theme: Theme) {
	localStorage.setItem(STORAGE_KEY, theme)
	applyTheme(theme)
	window.dispatchEvent(new CustomEvent('atlas-theme', { detail: theme }))
}

// call once before react mounts to avoid a fouc.
export function initTheme() {
	applyTheme(getTheme())
}

export function useTheme(): [Theme, (t: Theme) => void] {
	const [theme, setLocal] = useState<Theme>(() => getTheme())

	useEffect(() => {
		const handler = (e: Event) => setLocal((e as CustomEvent).detail as Theme)
		window.addEventListener('atlas-theme', handler)
		// react to system changes when in 'system' mode
		const mq = window.matchMedia('(prefers-color-scheme: dark)')
		const onSystem = () => { if (getTheme() === 'system') applyTheme('system') }
		mq.addEventListener('change', onSystem)
		return () => {
			window.removeEventListener('atlas-theme', handler)
			mq.removeEventListener('change', onSystem)
		}
	}, [])

	return [theme, setTheme]
}
