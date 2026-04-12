import React from 'react'
import { createRoot } from 'react-dom/client'
import { Route, Switch } from 'wouter'
import { Layout } from './components/layout.js'
import { DashboardPage } from './pages/dashboard.js'
import { SearchPage } from './pages/search.js'
import { GraphPage } from './pages/graph.js'
import { TracePage } from './pages/trace.js'
import { DeadCodePage } from './pages/dead-code.js'
import { WikiPage } from './pages/wiki.js'
import { ProjectsPage } from './pages/projects.js'
import { FlowsPage } from './pages/flows.js'
import { DuplicatesPage } from './pages/duplicates.js'
import { HistoryPage } from './pages/history.js'

class ErrorBoundary extends React.Component<
	{ children: React.ReactNode },
	{ error: Error | null }
> {
	state: { error: Error | null } = { error: null }
	static getDerivedStateFromError(error: Error) {
		return { error }
	}
	render() {
		if (this.state.error) {
			return <div className="p-6 text-error text-sm">render error: {this.state.error.message}</div>
		}
		return this.props.children
	}
}

function App() {
	return (
		<Layout>
			<ErrorBoundary>
				<Switch>
					<Route path="/" component={DashboardPage} />
					<Route path="/search" component={SearchPage} />
					<Route path="/graph" component={GraphPage} />
					<Route path="/trace" component={TracePage} />
					<Route path="/dead-code" component={DeadCodePage} />
					<Route path="/wiki" component={WikiPage} />
					<Route path="/flows" component={FlowsPage} />
					<Route path="/duplicates" component={DuplicatesPage} />
					<Route path="/history" component={HistoryPage} />
					<Route path="/projects" component={ProjectsPage} />
					<Route>
						<div className="text-text-muted text-sm">
							<h1 className="text-lg font-bold text-text mb-2">not found</h1>
						</div>
					</Route>
				</Switch>
			</ErrorBoundary>
		</Layout>
	)
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
