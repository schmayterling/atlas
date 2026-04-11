#!/usr/bin/env bun

// must be first: configure SQLite extensions before any Database creation
import { initSqliteExtensions } from './core/storage/sqlite-ext.js'
initSqliteExtensions()

import { program } from './cli/index.js'
program.parse()
