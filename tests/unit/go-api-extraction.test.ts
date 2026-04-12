import { describe, expect, test } from 'bun:test'
import { extractGoSource } from '../helpers/parse.js'

describe('extractGo api endpoints', () => {
	test('net/http HandleFunc', () => {
		const src = `package api

import "net/http"

func init() {
	http.HandleFunc("/api/users", myHandler)
}

func myHandler(w http.ResponseWriter, r *http.Request) {}
`
		const result = extractGoSource(src, 'pkg/api/routes.go')
		expect(result.apiEndpoints).toBeDefined()
		const ep = result.apiEndpoints!.find((e) => e.pathPattern === '/api/users')
		expect(ep).toBeDefined()
		expect(ep!.role).toBe('server')
		expect(ep!.framework).toBe('net/http')
		expect(ep!.symbolQualifiedName).toBe('pkg/api/routes.go::myHandler')
	})

	test('chi router Get / Post', () => {
		const src = `package api

func setup(r Router) {
	r.Get("/api/users", listUsers)
	r.Post("/api/users", createUser)
}

func listUsers(w http.ResponseWriter, r *http.Request) {}
func createUser(w http.ResponseWriter, r *http.Request) {}
`
		const result = extractGoSource(src, 'pkg/api/chi.go')
		const eps = result.apiEndpoints!
		expect(eps.length).toBeGreaterThanOrEqual(2)

		const get = eps.find((e) => e.httpMethod === 'GET')
		const post = eps.find((e) => e.httpMethod === 'POST')
		expect(get).toBeDefined()
		expect(post).toBeDefined()
		expect(get!.framework).toBe('chi')
		expect(get!.symbolQualifiedName).toBe('pkg/api/chi.go::listUsers')
		expect(post!.symbolQualifiedName).toBe('pkg/api/chi.go::createUser')
	})

	test('gin router GET / POST', () => {
		const src = `package api

func setup(r *gin.Engine) {
	r.GET("/api/items", listItems)
	r.POST("/api/items", createItem)
}

func listItems(c *gin.Context) {}
func createItem(c *gin.Context) {}
`
		const result = extractGoSource(src, 'pkg/api/gin.go')
		const eps = result.apiEndpoints!
		const get = eps.find((e) => e.httpMethod === 'GET')
		expect(get).toBeDefined()
		expect(get!.framework).toBe('gin')
		expect(get!.symbolQualifiedName).toBe('pkg/api/gin.go::listItems')
	})

	test('raw string literal path', () => {
		const src =
			'package api\n' +
			'\n' +
			'func setup(r Router) {\n' +
			'	r.Get(`/api/raw`, handler)\n' +
			'}\n' +
			'\n' +
			'func handler() {}\n'
		const result = extractGoSource(src, 'pkg/api/raw.go')
		const ep = result.apiEndpoints!.find((e) => e.pathPattern === '/api/raw')
		expect(ep).toBeDefined()
	})

	test('ignores non-route method calls with the same name', () => {
		// a method called "Get" on a non-router type must not emit an endpoint.
		// the current implementation uses the method name as the discriminator,
		// so this test documents the known limitation: we DO still emit an
		// endpoint, but only when the first argument is a path-looking string
		// and the second argument exists. this keeps the false-positive rate
		// manageable without needing type inference.
		const src = `package api

func broken() {
	cache.Get("user-123")
}
`
		const result = extractGoSource(src, 'pkg/api/cache.go')
		// "user-123" doesn't start with "/" so path filter drops it
		expect(result.apiEndpoints!.length).toBe(0)
	})
})
