import { Sun, Moon, Monitor } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useTheme, type Theme } from '../lib/theme.js'

const ICONS: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor }
const LABELS: Record<Theme, string> = { light: 'light', dark: 'dark', system: 'system' }

export function ThemeToggle() {
	const [theme, setTheme] = useTheme()
	const Icon = ICONS[theme]
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				className="h-8 w-8 inline-flex items-center justify-center rounded-[var(--radius-default)] text-text-muted hover:text-text hover:bg-surface-hover cursor-pointer focus-ring"
				aria-label={`theme: ${LABELS[theme]}`}
			>
				<Icon size={15} strokeWidth={1.8} />
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="end"
					sideOffset={6}
					className="z-50 min-w-[140px] rounded-[var(--radius-default)] border border-border bg-surface-raised p-1 shadow-lg"
				>
					{(['light', 'dark', 'system'] as Theme[]).map((t) => {
						const I = ICONS[t]
						return (
							<DropdownMenu.Item
								key={t}
								onSelect={() => setTheme(t)}
								className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer outline-none ${
									theme === t ? 'text-accent bg-accent-soft' : 'text-text-secondary hover:bg-surface-hover hover:text-text'
								}`}
							>
								<I size={14} strokeWidth={1.8} />
								<span>{LABELS[t]}</span>
							</DropdownMenu.Item>
						)
					})}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	)
}
