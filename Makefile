.PHONY: dev build install test dogfood lint format

dev:
	bun run src/bin.ts

build:
	bun build --compile src/bin.ts --outfile dist/atlas

install:
	./scripts/install.sh

test:
	bun test

dogfood:
	bun run scripts/dogfood.ts

lint:
	bunx @biomejs/biome check .

format:
	bunx @biomejs/biome format --write .
