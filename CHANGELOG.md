# Changelog

## [0.1.0-alpha.22](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.21...v0.1.0-alpha.22) (2026-06-24)


### ⚠ BREAKING CHANGES

* **cli:** `claude install` / `codex install` and their `uninstall` counterparts now default to project scope (`<repo>/.claude/settings.json`, `<repo>/.codex/hooks.json`) instead of machine-global user scope. Pass `--scope user` to restore the previous behavior.

### Features

* **cli:** default the session integration to project scope ([#85](https://github.com/campus-ai/prim/issues/85)) ([2d04fb2](https://github.com/campus-ai/prim/commit/2d04fb2ad805e22202ab4fe322c532a6e377be38))
* **welcome:** seed an empty org and surface recent decisions ([#88](https://github.com/campus-ai/prim/issues/88)) ([4210f58](https://github.com/campus-ai/prim/commit/4210f58555662cd7b285dc5772fac48e6db873e3))


### Bug Fixes

* **onboarding:** always deliver the welcome message on a successful setup ([#87](https://github.com/campus-ai/prim/issues/87)) ([02c46d2](https://github.com/campus-ai/prim/commit/02c46d25be735806088fe8f9570e48386095ceaa))

## [0.1.0-alpha.21](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.20...v0.1.0-alpha.21) (2026-06-23)


### Features

* **cli:** add `prim decisions create` ([#81](https://github.com/campus-ai/prim/issues/81)) ([c74c0f2](https://github.com/campus-ai/prim/commit/c74c0f22f348d8c20b5dffd1039b8094f6723132))
* **cli:** add `prim welcome` post-setup orientation ([#83](https://github.com/campus-ai/prim/issues/83)) ([6757a86](https://github.com/campus-ai/prim/commit/6757a8663cc12c45b8b3ce3ce006ba9a6fcd4cd8))
* **cli:** show online teammate names in presence ([#84](https://github.com/campus-ai/prim/issues/84)) ([d6ccc87](https://github.com/campus-ai/prim/commit/d6ccc874c52c600ccc7d449685fcfa37c529b3b2))

## [0.1.0-alpha.20](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.19...v0.1.0-alpha.20) (2026-06-22)


### ⚠ BREAKING CHANGES

* **cli:** scope prim to the decision graph (drop spec/projects surface)

### Features

* **cli:** scope prim to the decision graph (drop spec/projects surface) ([7e215e8](https://github.com/campus-ai/prim/commit/7e215e80e27b3f79f966ebad973b513132396f19))


### Bug Fixes

* **cli:** always drive the auth flow during onboarding ([#80](https://github.com/campus-ai/prim/issues/80)) ([336404b](https://github.com/campus-ai/prim/commit/336404b8f1b890734ee968b7aa67266e6b99b127))

## [0.1.0-alpha.19](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.18...v0.1.0-alpha.19) (2026-06-19)


### Features

* agent-driven setup — resilient hook resolution, daemon readiness, drivable auth ([#71](https://github.com/campus-ai/prim/issues/71)) ([fc465c9](https://github.com/campus-ai/prim/commit/fc465c9c7bd052994af20ab52ac55dc6ded9671b))

## [0.1.0-alpha.18](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.17...v0.1.0-alpha.18) (2026-06-18)


### Features

* **cli:** prim-post-commit hook emits git.commit moves ([#70](https://github.com/campus-ai/prim/issues/70)) ([b86b714](https://github.com/campus-ai/prim/commit/b86b71471e7230e25be4dc2ee4954b9441fa4bb6))

## [0.1.0-alpha.17](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.16...v0.1.0-alpha.17) (2026-06-17)


### Features

* **codex:** attribute captured moves to their producing agent ([262fbaa](https://github.com/campus-ai/prim/commit/262fbaa4ac3c422863bf54d7cc6704332090a48a))
* **codex:** hook installer, conflict gate, and presence analog ([5a7ca74](https://github.com/campus-ai/prim/commit/5a7ca74392aa35941abc16e82c6e195ec8f00cdd))
* **daemon:** route decision reads through the daemon proxy ([89e7dac](https://github.com/campus-ai/prim/commit/89e7dac11eca24804075ad05b8c2f51fdfa2cd03))


### Bug Fixes

* **codex:** split apply_patch patches on either line ending ([192c9a2](https://github.com/campus-ai/prim/commit/192c9a2aa12825c951b5bec0b3dc945b5741ce19))

## [0.1.0-alpha.16](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.15...v0.1.0-alpha.16) (2026-06-16)


### Features

* **daemon:** render an honest unknown team count and test the statusline ([1424306](https://github.com/campus-ai/prim/commit/1424306ac5639018ae4465f4665048b4fb6c8b5f))
* **decisions:** color and soft-wrap the decision read renderers ([bd3e2f9](https://github.com/campus-ai/prim/commit/bd3e2f9df9242774c2f2032346aa3e9f5dbd2a15))
* **decisions:** gate Claude Code edits through the prim PreToolUse hook ([f83f564](https://github.com/campus-ai/prim/commit/f83f564780e1501f6cdaacd6614efd796fda71a3))
* **decisions:** post-tool-use ingest, statusline, and the full claude install surface ([09ba82f](https://github.com/campus-ai/prim/commit/09ba82f13cd9bbb0fece539a6e826ef6bff7f413))
* **decisions:** prim daemon to accelerate hooks and heartbeat presence ([ad29ff7](https://github.com/campus-ai/prim/commit/ad29ff7eb38d22c99232214c2f0a01ace727ae5b))
* **decisions:** prim decisions check against the live decision graph ([e262ca9](https://github.com/campus-ai/prim/commit/e262ca96051d66988fb1095b87414a799d7da9ad))
* **decisions:** prim reconcile to mint a single-use decision bypass ([9e0def0](https://github.com/campus-ai/prim/commit/9e0def0eeaf5f47cfcfa5826a1f621946293b9c7))
* **decisions:** recent / show / cascade / confirm against the live graph ([bf1e535](https://github.com/campus-ai/prim/commit/bf1e535addc828028f6c3220aec3bec730658c9e))
* **decisions:** render the verdict footer and refresh the presence statusline ([74dbd0c](https://github.com/campus-ai/prim/commit/74dbd0c1d2a89c222d9bc90ded7c65159fea3e94))
* **events:** bind captured moves to an org and journal them per-bucket ([a8ede9e](https://github.com/campus-ai/prim/commit/a8ede9ee0991dd27d0c7228bb31c614475cdea3e))
* **events:** passive capture of Claude Code hooks into a draining journal ([ce23a37](https://github.com/campus-ai/prim/commit/ce23a3716fba619526d4015386091cd7b20e6a21))
* **events:** scrub PII and secrets from captured events before they journal ([4e70586](https://github.com/campus-ai/prim/commit/4e705864cb0ebcec177ef16505e2a89b46568122))


### Bug Fixes

* **daemon:** report stale presence honestly and surface broker refresh errors ([d706662](https://github.com/campus-ai/prim/commit/d706662a5dce39488e276f9a4787b2ad48a9e36a))

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
