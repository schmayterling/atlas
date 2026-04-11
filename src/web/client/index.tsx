import { createRoot } from 'react-dom/client'
import { Route, Switch } from 'wouter'
import { Layout } from './components/layout.js'
import { DashboardPage } from './pages/dashboard.js'

function PlaceholderPage({ name }: { name: string }) {
	return (
		<div className="text-text-muted text-sm">
			<h1 className="text-lg font-bold text-text mb-2">{name}</h1>
			<p>coming soon</p>
		</div>
	)
}

function App() {
	return (
		<Layout>
			<Switch>
				<Route path="/" component={DashboardPage} />
				<Route path="/search">
					<PlaceholderPage name="search" />
				</Route>
				<Route path="/graph">
					<PlaceholderPage name="graph" />
				</Route>
				<Route path="/trace">
					<PlaceholderPage name="trace" />
				</Route>
				<Route path="/dead-code">
					<PlaceholderPage name="dead code" />
				</Route>
				<Route path="/wiki">
					<PlaceholderPage name="wiki" />
				</Route>
				<Route>
					<PlaceholderPage name="not found" />
				</Route>
			</Switch>
		</Layout>
	)
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
