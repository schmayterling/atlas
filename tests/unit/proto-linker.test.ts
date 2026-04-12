import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProtoSymbols } from '../../src/core/queries/proto-linker.js'

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'atlas-proto-'))
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe('findProtoSymbols', () => {
	test('extracts message, service, and rpc definitions', () => {
		mkdirSync(join(root, 'proto'), { recursive: true })
		writeFileSync(
			join(root, 'proto/user.proto'),
			[
				'syntax = "proto3";',
				'',
				'package user;',
				'',
				'message User {',
				'  string id = 1;',
				'  string name = 2;',
				'}',
				'',
				'message UserProfile {',
				'  User user = 1;',
				'}',
				'',
				'service UserService {',
				'  rpc GetUser (GetUserRequest) returns (User);',
				'  rpc CreateUser (CreateUserRequest) returns (User);',
				'}',
				'',
				'message GetUserRequest {}',
				'message CreateUserRequest {}',
				'',
			].join('\n'),
		)

		const syms = findProtoSymbols(root)
		const messages = syms.filter((s) => s.kind === 'message').map((s) => s.name)
		const services = syms.filter((s) => s.kind === 'service').map((s) => s.name)
		const rpcs = syms.filter((s) => s.kind === 'rpc').map((s) => s.name)

		expect(messages).toContain('User')
		expect(messages).toContain('UserProfile')
		expect(messages).toContain('GetUserRequest')
		expect(services).toContain('UserService')
		expect(rpcs).toContain('GetUser')
		expect(rpcs).toContain('CreateUser')
	})

	test('skips node_modules and other skip dirs', () => {
		mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })
		writeFileSync(join(root, 'node_modules/pkg/ignored.proto'), 'message Ignored {}')
		mkdirSync(join(root, 'api'), { recursive: true })
		writeFileSync(join(root, 'api/real.proto'), 'message Real {}')

		const syms = findProtoSymbols(root)
		expect(syms.some((s) => s.name === 'Ignored')).toBe(false)
		expect(syms.some((s) => s.name === 'Real')).toBe(true)
	})

	test('returns empty array when no proto files exist', () => {
		expect(findProtoSymbols(root)).toEqual([])
	})
})
