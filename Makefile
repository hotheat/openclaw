.PHONY: lint build test

lint:
	pnpm check

build:
	pnpm install --frozen-lockfile
	pnpm build
	pnpm smoke:build
	pnpm ui:build

test:
	pnpm test
