# Changelog

## [0.1.0-alpha.8](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.7...v0.1.0-alpha.8) (2026-04-13)


### ⚠ BREAKING CHANGES

* `prim task create` is now `prim project create`

### Features

* rename tasks to projects in CLI ([#15](https://github.com/campus-ai/prim/issues/15)) ([d28680a](https://github.com/campus-ai/prim/commit/d28680aa15fe9ff3a2eb78d6d495d6919140ca01))

## [0.1.0-alpha.7](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.6...v0.1.0-alpha.7) (2026-04-13)


### Bug Fixes

* normalize bin paths for npm publish compatibility ([5fc74e2](https://github.com/campus-ai/prim/commit/5fc74e26d0221f4b37ce961533cfefac93572b30))

## [0.1.0-alpha.6](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.5...v0.1.0-alpha.6) (2026-04-13)


### Bug Fixes

* normalize repository URL to git+https format ([7a0d30d](https://github.com/campus-ai/prim/commit/7a0d30d004ff3afd91e9b18eaa7ecf13b27ef6e9))

## [0.1.0-alpha.5](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.4...v0.1.0-alpha.5) (2026-04-13)


### Bug Fixes

* **ci:** upgrade npm for OIDC trusted publisher support ([092c621](https://github.com/campus-ai/prim/commit/092c621cc95edb4b891d052d39c484eaf81f7233))
* **ci:** use npm granular token with trusted publisher provenance ([01fcce6](https://github.com/campus-ai/prim/commit/01fcce6ac0db17179f7f5e863389534e9c79d3f2))

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
* spec, context, and project management commands ([42b7143](https://github.com/campus-ai/prim/commit/42b7143f5261b73a1c318f7508058371372edaa7))

## 0.1.0-alpha.1 (2026-04-13)

### Features

* Initial alpha release
* Auth: OAuth login via WorkOS, token management, proactive refresh
* Specs: list, get, update, sync, map/unmap file patterns, auto-map
* Contexts: full CRUD, link/unlink to projects
* Projects: create with optional spec linking
* Hooks: pre-commit hook with Husky-aware installation
