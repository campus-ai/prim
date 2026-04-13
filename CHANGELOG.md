# Changelog

## [0.1.0-alpha.4](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.3...v0.1.0-alpha.4) (2026-04-13)


### Bug Fixes

* **ci:** mint OIDC token explicitly for npm trusted publishers ([780f5e6](https://github.com/campus-ai/prim/commit/780f5e624458072b0ec339b360f3e296a1b1eb0f))

## [0.1.0-alpha.3](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.2...v0.1.0-alpha.3) (2026-04-13)


### Bug Fixes

* read version from package.json to prevent drift ([3479258](https://github.com/campus-ai/prim/commit/3479258d1d00274f4ccc7ac5bf5ba7c808d1ce7e))

## [0.1.0-alpha.2](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.1...v0.1.0-alpha.2) (2026-04-13)


### Features

* CLI entry point ([2e9b1e5](https://github.com/campus-ai/prim/commit/2e9b1e57277d69b9bdbb4027d1e72b0fe5d42c0f))
* pre-commit hook with Husky-aware installation ([f821971](https://github.com/campus-ai/prim/commit/f821971b19fd8925675a5854a60bc24977afcfc3))
* REST client with WorkOS OAuth and token management ([83e94e7](https://github.com/campus-ai/prim/commit/83e94e7f64c0b7ca90459b69c3ed383b1c14b2c1))
* spec, context, and task management commands ([42b7143](https://github.com/campus-ai/prim/commit/42b7143f5261b73a1c318f7508058371372edaa7))

## 0.1.0-alpha.1 (2026-04-13)

### Features

* Initial alpha release
* Auth: OAuth login via WorkOS, token management, proactive refresh
* Specs: list, get, update, sync, map/unmap file patterns, auto-map
* Contexts: full CRUD, link/unlink to tasks
* Tasks: create with optional spec linking
* Hooks: pre-commit hook with Husky-aware installation
