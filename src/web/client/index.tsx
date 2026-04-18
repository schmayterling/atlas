import React from 'react'
import { createRoot } from 'react-dom/client'
import { Route, Switch } from 'wouter'
import { initTheme } from './lib/theme.js'
import { Layout } from './components/layout.js'
import { HomePage } from './pages/home.js'
import { BrowsePage } from './pages/browse.js'
import { SymbolArticle } from './pages/symbol-article.js'
import { FileArticle } from './pages/file-article.js'
import { SubsystemArticle } from './pages/subsystem-article.js'
import { InsightsPage } from './pages/insights.js'
import { GraphPage } from './pages/graph.js'
import { EmptyState } from './ui/index.js'

initTheme()

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
			return (
				<div className="py-8">
					<EmptyState title="render error" description={this.state.error.message} />
				</div>
			)
		}
		return this.props.children
	}
}

function App() {
	return (
		<Layout>
			<ErrorBoundary>
				<Switch>
					<Route path="/" component={HomePage} />
					<Route path="/browse" component={BrowsePage} />
					<Route path="/insights" component={InsightsPage} />
					<Route path="/graph" component={GraphPage} />
					<Route path="/sub" component={SubsystemArticle} />
					<Route path="/sub/:id" component={SubsystemArticle} />
					<Route path="/s/:rest*" component={SymbolArticle} />
					<Route path="/f/:rest*" component={FileArticle} />
					<Route>
						<EmptyState title="not found" description={`no page at ${window.location.pathname}`} />
					</Route>
				</Switch>
			</ErrorBoundary>
		</Layout>
	)
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
