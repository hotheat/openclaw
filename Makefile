.PHONY: lint build test

lint:
	pnpm check

build:
	pnpm build
	pnpm smoke:build
	pnpm ui:build

test:
	pnpm test
