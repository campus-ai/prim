# Changelog

## [0.1.0-alpha.15](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.14...v0.1.0-alpha.15) (2026-05-14)


### Features

* **cli:** opt CLI into spec ↔ PR linking via branch context ([#29](https://github.com/campus-ai/prim/issues/29)) ([f19a8a9](https://github.com/campus-ai/prim/commit/f19a8a9e36cb7e7a0eb5e25d2655945745112596))

## [0.1.0-alpha.14](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.13...v0.1.0-alpha.14) (2026-05-13)


### ⚠ BREAKING CHANGES

* **cli:** Mutating commands previously wrote `Created context: <id>` (and similar prefix lines) to stdout. They now write the bare _id to stdout and the human prefix to stderr. Scripts that parsed prefix-formatted stdout lines must either read stdout as the bare ID or switch to `--json | jq ._id`.

### Features

* add uniform --json flag across data-returning commands ([#36](https://github.com/campus-ai/prim/issues/36)) ([4800be2](https://github.com/campus-ai/prim/commit/4800be2423692baddb0b00279b5153da080df196))
* **cli:** emit bare IDs on stdout; route human prefixes to stderr ([#42](https://github.com/campus-ai/prim/issues/42)) ([d0d6bd8](https://github.com/campus-ai/prim/commit/d0d6bd8bc7184ce4eb56c866e97e1933e3f0710c))
* **cli:** non-interactive globals and hooks install --target ([#39](https://github.com/campus-ai/prim/issues/39)) ([b1bc0ed](https://github.com/campus-ai/prim/commit/b1bc0ed188a7dc6ef14f5b303e0643c8e1fef13f))

## [0.1.0-alpha.13](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.12...v0.1.0-alpha.13) (2026-05-12)


### Bug Fixes

* pin [@latest](https://github.com/latest) in setup.md procedure (force-update v1) ([#33](https://github.com/campus-ai/prim/issues/33)) ([b5a12df](https://github.com/campus-ai/prim/commit/b5a12dfd021eeee2e662d959a3d51b979c547380))

## [0.1.0-alpha.12](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.11...v0.1.0-alpha.12) (2026-05-12)


### Features

* prim skill install + pinned setup.md (v1) ([#27](https://github.com/campus-ai/prim/issues/27)) ([ff2f132](https://github.com/campus-ai/prim/commit/ff2f132918dfa19a1513a216bd483c3893f9bd72))
* surface stale-version warnings via update-notifier ([#31](https://github.com/campus-ai/prim/issues/31)) ([1e845eb](https://github.com/campus-ai/prim/commit/1e845ebba3058f0d4013c7a6b3fc1d11d5e5ac11))

## [0.1.0-alpha.11](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.10...v0.1.0-alpha.11) (2026-04-22)


### Features

* **hooks:** warn when the server truncates a large sync-diff ([#23](https://github.com/campus-ai/prim/issues/23)) ([7877966](https://github.com/campus-ai/prim/commit/787796619d1a23adcd611a76221c143cdd9df8b8))

## [0.1.0-alpha.10](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.9...v0.1.0-alpha.10) (2026-04-14)


### Bug Fixes

* **hooks:** replace import.meta.url execution guard with VITEST check ([0e2a6d7](https://github.com/campus-ai/prim/commit/0e2a6d7b189bbcdf3fc5920cdabd4630e03ae6bc))

## [0.1.0-alpha.9](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.8...v0.1.0-alpha.9) (2026-04-14)


### Bug Fixes

* **hooks:** send staged diff to sync-diff endpoint ([#18](https://github.com/campus-ai/prim/issues/18)) ([d2a4873](https://github.com/campus-ai/prim/commit/d2a487334946b3cf2b340c0e1a89f13abaea9473))

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
