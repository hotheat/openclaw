.PHONY: lint build test

lint:
	pnpm check

build:
	pnpm install --frozen-lockfile
	pnpm build
	pnpm smoke:build
	pnpm smoke:npm-pack
	pnpm smoke:runtime-guard-extensions
	pnpm ui:build

test:
	pnpm test
