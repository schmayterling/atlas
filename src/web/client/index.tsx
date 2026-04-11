import { createRoot } from 'react-dom/client'
import { Route, Switch } from 'wouter'
import { Layout } from './components/layout.js'
import { DashboardPage } from './pages/dashboard.js'
import { SearchPage } from './pages/search.js'
import { GraphPage } from './pages/graph.js'
import { TracePage } from './pages/trace.js'
import { DeadCodePage } from './pages/dead-code.js'

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
				<Route path="/search" component={SearchPage} />
				<Route path="/graph" component={GraphPage} />
				<Route path="/trace" component={TracePage} />
				<Route path="/dead-code" component={DeadCodePage} />
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
