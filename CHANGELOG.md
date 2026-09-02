# Changelog

## [0.1.0-alpha.84](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.83...v0.1.0-alpha.84) (2026-09-02)


### Bug Fixes

* **codex:** close nested apply_patch hook gap ([b1381a9](https://github.com/campus-ai/prim/commit/b1381a9007d345debc345f76f37c06817ad6d3ba))
* **codex:** cover nested apply_patch hooks ([e78be5d](https://github.com/campus-ai/prim/commit/e78be5df06bf29768bce5bcf6e68a52d92222fc5))

## [0.1.0-alpha.83](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.82...v0.1.0-alpha.83) (2026-09-01)


### Bug Fixes

* **hooks:** bundle YAML ESM in staged runtime ([e74ed2a](https://github.com/campus-ai/prim/commit/e74ed2a2ec48f84a90f1e79131c222654fba0353))
* **hooks:** prevent SessionStart YAML ESM crash ([ed15948](https://github.com/campus-ai/prim/commit/ed15948bdce90880278f1effecc14229d662e285))

## [0.1.0-alpha.82](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.81...v0.1.0-alpha.82) (2026-09-01)


### Bug Fixes

* **cascade:** tolerate server projection that omits upstream.contexts ([107e8d8](https://github.com/campus-ai/prim/commit/107e8d8f4a15f314a28172175e20207baa243aeb))
* **cascade:** tolerate server projection that omits upstream.contexts ([ce3753e](https://github.com/campus-ai/prim/commit/ce3753e8533448d32693954329c9eccbfda6acb2))

## [0.1.0-alpha.81](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.80...v0.1.0-alpha.81) (2026-09-01)


### Features

* **github:** require repo connection for Primitive ([889d3d4](https://github.com/campus-ai/prim/commit/889d3d4e281406f3710723b09ddd9711e2f10c5b))

## [0.1.0-alpha.80](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.79...v0.1.0-alpha.80) (2026-09-01)


### Features

* **claude:** guide GitHub binding onboarding ([5f73e1e](https://github.com/campus-ai/prim/commit/5f73e1e1919f7398de099da9af1cc14afd74c885))


### Bug Fixes

* **doctor:** remove feedback id health noise ([6dcf9a1](https://github.com/campus-ai/prim/commit/6dcf9a16eb183482101e3ee568eb6a388faa452e))
* **doctor:** remove feedback-id health noise ([cc48a62](https://github.com/campus-ai/prim/commit/cc48a6275ff156db27f2aa63529bd22645fd2985))

## [0.1.0-alpha.79](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.78...v0.1.0-alpha.79) (2026-09-01)


### Bug Fixes

* avoid duplicate markers in global hooks ([aeeaaa4](https://github.com/campus-ai/prim/commit/aeeaaa468b9efe7a26d7ad487acbf5ec00821dfc))
* remove duplicate markers from global hooks ([f3c0ced](https://github.com/campus-ai/prim/commit/f3c0cedcefb9da9027f6d578eccabf5eaf3a3560))

## [0.1.0-alpha.78](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.77...v0.1.0-alpha.78) (2026-09-01)


### Bug Fixes

* **doctor:** remove classifier session health noise ([5a4415e](https://github.com/campus-ai/prim/commit/5a4415e3c6f5599058b7c66374db4189505c79a3))
* **doctor:** remove classifier session health noise ([b1c8442](https://github.com/campus-ai/prim/commit/b1c84429820eee1888690f77eac8662c12305bda))
* self-heal malformed global hooks on enable ([adf4fa6](https://github.com/campus-ai/prim/commit/adf4fa6c065c2ecb3bc08d2f61269a5b03dbee0a))
* self-heal malformed global hooks on enable ([dd3fb20](https://github.com/campus-ai/prim/commit/dd3fb20a2612d7fa03e1c240eb8de78e0acbd99d))

## [0.1.0-alpha.77](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.76...v0.1.0-alpha.77) (2026-09-01)


### Bug Fixes

* **contract:** expose complete CLI validator registry ([963fd0d](https://github.com/campus-ai/prim/commit/963fd0d2dbed0a0bfef5169036a41bb6602ddea6))
* **github:** explain connect retry states ([decd7f4](https://github.com/campus-ai/prim/commit/decd7f4cddb9688af2b2899c81989345753f4b75))
* **github:** explain connect retry states ([8863d1c](https://github.com/campus-ai/prim/commit/8863d1ca4c3c6d11d018729a5b5ba7b00f1f5db0))

## [0.1.0-alpha.76](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.75...v0.1.0-alpha.76) (2026-09-01)


### Bug Fixes

* tolerate clock skew in GitHub install intents ([fa448cd](https://github.com/campus-ai/prim/commit/fa448cd72bf782a90b77f1340bf2e0cec83c62b4))
* tolerate clock skew in GitHub install intents ([#291](https://github.com/campus-ai/prim/issues/291)) ([e84f64d](https://github.com/campus-ai/prim/commit/e84f64d729cf67af837022776b227cf66f01133a))

## [0.1.0-alpha.75](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.74...v0.1.0-alpha.75) (2026-08-31)


### Features

* **onboarding:** prompt to connect an unbound repository during enable/setup ([#289](https://github.com/campus-ai/prim/issues/289)) ([adc046a](https://github.com/campus-ai/prim/commit/adc046a227c95c7b7f949119493fd3444446e495))


### Bug Fixes

* **hooks:** overwrite global post-commit hook instead of block-merging ([#288](https://github.com/campus-ai/prim/issues/288)) ([338b305](https://github.com/campus-ai/prim/commit/338b3051eb933d6e0ca851e71acca6979e6aa673))

## [0.1.0-alpha.74](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.73...v0.1.0-alpha.74) (2026-08-31)


### Bug Fixes

* **github:** accept identity migration terminal status ([#285](https://github.com/campus-ai/prim/issues/285)) ([17dbaa3](https://github.com/campus-ai/prim/commit/17dbaa34e8d56163caf306584bbad704c8470534))

## [0.1.0-alpha.73](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.72...v0.1.0-alpha.73) (2026-08-30)


### Bug Fixes

* **decisions:** tolerate omitted empty contexts ([a657a58](https://github.com/campus-ai/prim/commit/a657a58b7a23fc0bdfa366a7c962baf808e20988))
* **decisions:** tolerate omitted empty contexts ([072b334](https://github.com/campus-ai/prim/commit/072b334c20df821e51d17a33ccaf441a44664d5b))

## [0.1.0-alpha.72](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.71...v0.1.0-alpha.72) (2026-08-30)


### Features

* **decisions:** expose full authored lifecycle ([b09f78a](https://github.com/campus-ai/prim/commit/b09f78a751ac07341360a849df3cc55fdbbff500))
* **decisions:** expose full authored lifecycle ([6df40b8](https://github.com/campus-ai/prim/commit/6df40b8788de5973a319d4660234812612825320))

## [0.1.0-alpha.71](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.70...v0.1.0-alpha.71) (2026-08-30)


### Bug Fixes

* **auth:** accept safe Unicode API key displays ([b0f4a45](https://github.com/campus-ai/prim/commit/b0f4a456ce513c5b122de11355c6ea1b486e8a4c))

## [0.1.0-alpha.70](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.69...v0.1.0-alpha.70) (2026-08-30)


### Bug Fixes

* **github:** validate install intent TTL at response time ([8ca0667](https://github.com/campus-ai/prim/commit/8ca066703648b38bb5d17e08ca7dd9e041b3c584))

## [0.1.0-alpha.69](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.68...v0.1.0-alpha.69) (2026-08-29)


### Features

* add decision lifecycle commands ([#243](https://github.com/campus-ai/prim/issues/243)) ([8e96d9f](https://github.com/campus-ai/prim/commit/8e96d9fcef44d3040f55a6bce54ff2ccc992fa40))
* add fail-closed top-level uninstall ([#268](https://github.com/campus-ai/prim/issues/268)) ([777103f](https://github.com/campus-ai/prim/commit/777103f4f381ccbf14ecb74d0d99dee579163760))
* adopt CLI critical-path contract v2 ([#240](https://github.com/campus-ai/prim/issues/240)) ([35ee9c6](https://github.com/campus-ai/prim/commit/35ee9c681fc330616d6c58be757d51e69f4b272b))
* **auth:** add WorkOS Connect device flow ([#251](https://github.com/campus-ai/prim/issues/251)) ([9557af2](https://github.com/campus-ai/prim/commit/9557af2ce6e5ef56df5bf7b31b3175972d3ffbc1))
* **auth:** manage WorkOS user API keys ([#253](https://github.com/campus-ai/prim/issues/253)) ([5182373](https://github.com/campus-ai/prim/commit/51823739c43b12b6f69a9730f5d8a78e8e3e8600))
* **capture:** recover organization-bound journal envelopes ([#272](https://github.com/campus-ai/prim/issues/272)) ([1497ba4](https://github.com/campus-ai/prim/commit/1497ba409c028b80f7a4917f11582d08703c48e6))
* **codex:** recover private draft delivery ([#271](https://github.com/campus-ai/prim/issues/271)) ([cb79e7b](https://github.com/campus-ai/prim/commit/cb79e7bb5fa3e95d92dba4e8e9843f7996788c53))
* **daemon:** compose stable instance heartbeat prerequisites ([#242](https://github.com/campus-ai/prim/issues/242)) ([0adb85d](https://github.com/campus-ai/prim/commit/0adb85de22e169359b62b68065751dcbe7946408))
* **decisions:** add restore command ([#266](https://github.com/campus-ai/prim/issues/266)) ([eb04a1b](https://github.com/campus-ai/prim/commit/eb04a1bc4139f485e0a2a81f9846d4e3ef3687c7))
* **decisions:** recover feedback v2 publish prompts ([#270](https://github.com/campus-ai/prim/issues/270)) ([e2c743f](https://github.com/campus-ai/prim/commit/e2c743f5406812083b1d02627f842a19109e6155))
* **doctor:** verify persistent hook runtimes ([#269](https://github.com/campus-ai/prim/issues/269)) ([ded9ed3](https://github.com/campus-ai/prim/commit/ded9ed3678121620271113dfda56d25ffe14c75f))
* generate CLI request-core bindings ([#239](https://github.com/campus-ai/prim/issues/239)) ([94cc91b](https://github.com/campus-ai/prim/commit/94cc91b7d94628044f1af9f7611e6248c487d92d))
* **github:** recover explicit repository connect ([#274](https://github.com/campus-ai/prim/issues/274)) ([8f75371](https://github.com/campus-ai/prim/commit/8f7537189c627a5a8f52cca7f7c7e783b0227513))
* **github:** recover install-intent connect flow ([#277](https://github.com/campus-ai/prim/issues/277)) ([98aa0ab](https://github.com/campus-ai/prim/commit/98aa0ab1473ff9c0cddd765bcb36cf169ea2010c))
* **hooks:** recover version-stable runtime staging ([#267](https://github.com/campus-ai/prim/issues/267)) ([451e3f8](https://github.com/campus-ai/prim/commit/451e3f8851432276c3147408a4f0e8a4388b1f93))
* **preflight:** disclose hidden Decision participation ([#273](https://github.com/campus-ai/prim/issues/273)) ([4d7fb90](https://github.com/campus-ai/prim/commit/4d7fb90861ccc089cf8177c3dba1e3b9615b11cb))
* re-land verified CLI foundation stack ([#265](https://github.com/campus-ai/prim/issues/265)) ([e1b02a5](https://github.com/campus-ai/prim/commit/e1b02a5b65c72aa49a51e342cfe16cd73a454c5f))


### Bug Fixes

* **auth:** sanitize broker refresh diagnostics ([0dd1dc8](https://github.com/campus-ai/prim/commit/0dd1dc84545533a42cd5b227bcb8d2e56b6c91e0))
* **capture:** harden secret redaction ([18638ca](https://github.com/campus-ai/prim/commit/18638cab1cebe2c356c64d49ba9ee3ff3f10ec39))
* **capture:** harden secret redaction ([822b5b9](https://github.com/campus-ai/prim/commit/822b5b967b3e15d8474d9f8c880e3d9d35073e6f))
* **capture:** quarantine poison move deliveries ([4be9075](https://github.com/campus-ai/prim/commit/4be90758a2669e8f633a8ad7932df32483fb1029))
* **capture:** quarantine poison move deliveries ([38dadb8](https://github.com/campus-ai/prim/commit/38dadb83b3f162ca4704443e387faaa767fba34f))
* **capture:** quarantine tenant authority mismatches ([d0abd9a](https://github.com/campus-ai/prim/commit/d0abd9a370b524c9c1526fa1ee2aac66e9541489))
* **capture:** redact secret-bearing object keys ([79f7c80](https://github.com/campus-ai/prim/commit/79f7c806efadc1723df02bece08f1b50adf50ae4))
* **capture:** retain unversioned ingest failures ([e98f41e](https://github.com/campus-ai/prim/commit/e98f41ec1f560930e387c31de46a6607f48e9c0b))
* **codex:** preserve final output on Stop digest ([9a3f4cc](https://github.com/campus-ai/prim/commit/9a3f4ccfaeb70c10b0281333e95eb84b8d147ad6))
* **codex:** preserve final output on Stop digest ([3867eb6](https://github.com/campus-ai/prim/commit/3867eb63520271f7253f80f1dffa5eee54cdac58))
* **daemon:** bind socket reads to caller principal ([#233](https://github.com/campus-ai/prim/issues/233)) ([916387b](https://github.com/campus-ai/prim/commit/916387bcbc315107a2def71eef596fb89ef603ba))
* **decisions:** bind affecting checks to repository ([#275](https://github.com/campus-ai/prim/issues/275)) ([573f5a8](https://github.com/campus-ai/prim/commit/573f5a88da0ff6126a84db209191d0fa9c41c517))
* durably sync atomic write directories ([3ef2791](https://github.com/campus-ai/prim/commit/3ef2791cbba18acd18c4f14d311b90644e0f8ffb))
* harden atomic host config writes ([2428881](https://github.com/campus-ai/prim/commit/24288818fbb5863d6e463d99e56890d503cf7be5))
* harden atomic host config writes ([915663a](https://github.com/campus-ai/prim/commit/915663ab8781a19ac04de1161a31d25d37db51df))
* harden config and credential resolution ([12c9c12](https://github.com/campus-ai/prim/commit/12c9c12c23c3f372b5df49015c53dcc4a7cb9ea1))
* harden config and credential resolution ([dc5e7e5](https://github.com/campus-ai/prim/commit/dc5e7e59fcc9c59aa0ed4da7c9292bb09baf8c30))
* **hooks:** sanitize debug error output ([#262](https://github.com/campus-ai/prim/issues/262)) ([766e168](https://github.com/campus-ai/prim/commit/766e1687fe2c19b0563f8b1230a11de1e0fec15b))
* pin unattended hook runtimes ([3699b35](https://github.com/campus-ai/prim/commit/3699b351d4e6c0e67f7b68606158b1f29d1c14a4))
* pin unattended hook runtimes ([02b573a](https://github.com/campus-ai/prim/commit/02b573a55b114a220b9efdb03d83946adefa3155))
* preserve Hermes YAML configuration ([bb530ea](https://github.com/campus-ai/prim/commit/bb530eae33c580cd1d60b7ba99b34142e1f43694))
* preserve Hermes YAML configuration ([ea33ca2](https://github.com/campus-ai/prim/commit/ea33ca20b298a1afb801253111ebe38fb1f71ba0))
* quarantine tenant-mismatched captures ([db68588](https://github.com/campus-ai/prim/commit/db685885aa70db03a2544b7c4fd6a64bc4fe0b82))
* reject unsafe config directory overrides ([db8523d](https://github.com/campus-ai/prim/commit/db8523d6fde8e4aaf24178a03a673b66a837dee4))
* remove local Git hook runtime fallback ([39eea68](https://github.com/campus-ai/prim/commit/39eea68992dd22262c4604c3f4881315949cd7a4))
* **rendering:** sanitize terminal output ([1f4e16c](https://github.com/campus-ai/prim/commit/1f4e16cc3ae49cf30efc3681888bc4b054f91068))
* retain repository bindings across outages ([#235](https://github.com/campus-ai/prim/issues/235)) ([2f52658](https://github.com/campus-ai/prim/commit/2f526581fa99d86434bc16de64bd661f78399cbb))
* sync recursive atomic parent chain ([a2a48e5](https://github.com/campus-ai/prim/commit/a2a48e571a0767f5594b0e80e728347a69e8891c))


### Reverts

* **decisions:** remove repository-bound affecting query ([#276](https://github.com/campus-ai/prim/issues/276)) ([6dd5551](https://github.com/campus-ai/prim/commit/6dd55514d4ab638e9553deb96238ee26f7f3d397))
* undo unverified CLI merge train ([#264](https://github.com/campus-ai/prim/issues/264)) ([d7aa3f2](https://github.com/campus-ai/prim/commit/d7aa3f28d3ffa5a1b5a4269744d892af025c008e))

## [0.1.0-alpha.68](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.67...v0.1.0-alpha.68) (2026-08-11)


### Features

* surface Primitive status and Decision digests in Codex ([#225](https://github.com/campus-ai/prim/issues/225)) ([e897cdf](https://github.com/campus-ai/prim/commit/e897cdf02b1511e6bb533ede576bc4d7db3c39c7))

## [0.1.0-alpha.67](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.66...v0.1.0-alpha.67) (2026-08-10)


### Features

* add decisions repair commands ([#217](https://github.com/campus-ai/prim/issues/217)) ([6ad3611](https://github.com/campus-ai/prim/commit/6ad3611bb2980d54b25d30b45e32433923453145))

## [0.1.0-alpha.66](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.65...v0.1.0-alpha.66) (2026-08-10)


### Features

* capture git rewrite lineage ([b759998](https://github.com/campus-ai/prim/commit/b759998e7fbd598b60d5e19989595bdfcca67a95))

## [0.1.0-alpha.65](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.64...v0.1.0-alpha.65) (2026-08-05)


### Bug Fixes

* allow local activation before repository connection ([9f23e5b](https://github.com/campus-ai/prim/commit/9f23e5b610be2229535758a9370d35cd82c4acb9))

## [0.1.0-alpha.64](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.63...v0.1.0-alpha.64) (2026-08-02)


### Features

* report enforcement conflict outcomes from agent hooks ([#211](https://github.com/campus-ai/prim/issues/211)) ([08dfae8](https://github.com/campus-ai/prim/commit/08dfae88e94170e52706ed7360f7411270000be3))


### Bug Fixes

* preserve complete passive lifecycle evidence ([#210](https://github.com/campus-ai/prim/issues/210)) ([25184bb](https://github.com/campus-ai/prim/commit/25184bb1c77eb580f52fe60b99dce2e7fdf794de))

## [0.1.0-alpha.63](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.62...v0.1.0-alpha.63) (2026-07-29)


### Bug Fixes

* eliminate macOS statusline Node cold starts ([a4d57b4](https://github.com/campus-ai/prim/commit/a4d57b42b167611c8db7db40b24f8723af0e3da0))

## [0.1.0-alpha.62](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.61...v0.1.0-alpha.62) (2026-07-29)


### Bug Fixes

* make passive commit capture reliable ([#206](https://github.com/campus-ai/prim/issues/206)) ([1702f20](https://github.com/campus-ai/prim/commit/1702f2086a5b0a673bf2d5e6c00d1620fb6f7e34))

## [0.1.0-alpha.61](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.60...v0.1.0-alpha.61) (2026-07-28)


### Bug Fixes

* make launchd daemon upgrades converge ([ed30ed2](https://github.com/campus-ai/prim/commit/ed30ed27e503d11587ce5b379554c807ddb484b1)), closes [#191](https://github.com/campus-ai/prim/issues/191)

## [0.1.0-alpha.60](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.59...v0.1.0-alpha.60) (2026-07-28)


### Features

* bind active repositories at session start ([4b48c3a](https://github.com/campus-ai/prim/commit/4b48c3ad393daf062ca8b44b243da12fa970b55c))
* bind active repositories at session start ([#200](https://github.com/campus-ai/prim/issues/200)) ([046e88b](https://github.com/campus-ai/prim/commit/046e88bb8d98add4148496e985a3384b9cb4b2eb))
* **skill:** sharpen fork-in-the-road and rationale guidance ([#204](https://github.com/campus-ai/prim/issues/204)) ([1c6e36f](https://github.com/campus-ai/prim/commit/1c6e36f30a634e2e0ff137171f21f29c67742950))

## [0.1.0-alpha.59](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.58...v0.1.0-alpha.59) (2026-07-22)


### Bug Fixes

* extend the preflight client deadline ([f1b8b08](https://github.com/campus-ai/prim/commit/f1b8b08a07790dd04c7421daaa80eb76a7958e9e))
* extend the preflight client deadline ([#195](https://github.com/campus-ai/prim/issues/195)) ([36e7bd3](https://github.com/campus-ai/prim/commit/36e7bd32b89ad215602beac899082ac23748a763))


### Reverts

* restore the preflight client deadline ([#193](https://github.com/campus-ai/prim/issues/193)) ([3245aff](https://github.com/campus-ai/prim/commit/3245aff1f9f001bd63937f87db4b0683b47d1ddd))

## [0.1.0-alpha.58](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.57...v0.1.0-alpha.58) (2026-07-22)


### Features

* replace the onboarding goals question with one-at-a-time memory proposals ([#187](https://github.com/campus-ai/prim/issues/187)) ([d1fcccd](https://github.com/campus-ai/prim/commit/d1fcccde6c0dcac7d130820baefd4c5bd0ec4882))


### Bug Fixes

* **cli:** make --decided and --alternatives repeatable, never comma-split ([#189](https://github.com/campus-ai/prim/issues/189)) ([724fca8](https://github.com/campus-ai/prim/commit/724fca85847cd0d9d6a7bff1c23e606fedae9407))
* make enforcement hooks reliable across agents ([#190](https://github.com/campus-ai/prim/issues/190)) ([30c99f9](https://github.com/campus-ai/prim/commit/30c99f926a4da1336a07f1728f49dfd486ecfa0e))

## [0.1.0-alpha.57](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.56...v0.1.0-alpha.57) (2026-07-22)


### Features

* add decision enforcement v3 CLI ([#186](https://github.com/campus-ai/prim/issues/186)) ([34a1e43](https://github.com/campus-ai/prim/commit/34a1e43f1dfaf099b173802fee905e4ccade216e))

## [0.1.0-alpha.56](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.55...v0.1.0-alpha.56) (2026-07-21)


### Bug Fixes

* **skill:** exclude personal-environment decisions from the team graph ([#183](https://github.com/campus-ai/prim/issues/183)) ([5453f27](https://github.com/campus-ai/prim/commit/5453f27a50ade987613a0f5779782a0239c7a9b9))
* **skill:** match create formatting to classifier contract and require rationale ([#182](https://github.com/campus-ai/prim/issues/182)) ([5e2f388](https://github.com/campus-ai/prim/commit/5e2f388bbad068c9da6b15172d125f38c5b62beb))

## [0.1.0-alpha.55](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.54...v0.1.0-alpha.55) (2026-07-20)


### Bug Fixes

* **skill:** release normative-intent admission policy ([#178](https://github.com/campus-ai/prim/issues/178)) ([59f4dee](https://github.com/campus-ai/prim/commit/59f4deee0ed15cf18b925a0da556bb964810824a))

### Documentation

* **skill:** require normative, self-contained intents for deliberate creates ([#177](https://github.com/campus-ai/prim/issues/177)) ([f41e0ba](https://github.com/campus-ai/prim/commit/f41e0bac145cd677218d8deb27c559618d1d9292))

## [0.1.0-alpha.54](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.53...v0.1.0-alpha.54) (2026-07-19)


### Features

* require decision origin attribution ([#175](https://github.com/campus-ai/prim/issues/175)) ([8ddc412](https://github.com/campus-ai/prim/commit/8ddc412637a76ed01e8af35503c82068b3362a02))

## [0.1.0-alpha.53](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.52...v0.1.0-alpha.53) (2026-07-18)


### Bug Fixes

* **skill:** tighten recording policy based on invocation eval results ([#173](https://github.com/campus-ai/prim/issues/173)) ([cd3e35e](https://github.com/campus-ai/prim/commit/cd3e35e24791442e9c2f3b302e54ace3b921ad4d))

## [0.1.0-alpha.52](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.51...v0.1.0-alpha.52) (2026-07-18)


### Features

* **hooks:** prompt proactive Prim use in Codex sessions ([#171](https://github.com/campus-ai/prim/issues/171)) ([33c3e79](https://github.com/campus-ai/prim/commit/33c3e7990391374ca1bbcf454668128ca9006445))

## [0.1.0-alpha.51](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.50...v0.1.0-alpha.51) (2026-07-18)


### Features

* **hooks:** refresh Claude skill installs and prompt prim invocation at SessionStart ([#169](https://github.com/campus-ai/prim/issues/169)) ([ad31def](https://github.com/campus-ai/prim/commit/ad31def0c77f249c35e159976efc16f1708ba644))

## [0.1.0-alpha.50](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.49...v0.1.0-alpha.50) (2026-07-17)


### Features

* **client:** surface terminal-auth so stranded users know to re-auth ([#166](https://github.com/campus-ai/prim/issues/166)) ([df22876](https://github.com/campus-ai/prim/commit/df22876c3709a0fcb42cb4d1b3bf284646ae3784))


### Bug Fixes

* **client:** stop naked 401s and cross-process replay at the source ([#164](https://github.com/campus-ai/prim/issues/164)) ([9f0db08](https://github.com/campus-ai/prim/commit/9f0db08f5b76eb282bef4fe6259af19fb00f3851))

## [0.1.0-alpha.49](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.48...v0.1.0-alpha.49) (2026-07-16)


### Features

* enforce ingestion opt-in for captures and creates ([#163](https://github.com/campus-ai/prim/issues/163)) ([fdfee5b](https://github.com/campus-ai/prim/commit/fdfee5befc974bc23800fc534dbd7ac2141b0db7))
* show location-aware decision ingestion status ([#161](https://github.com/campus-ai/prim/issues/161)) ([2aaa722](https://github.com/campus-ai/prim/commit/2aaa72203fe47f651152a53b7fb69323d2ae2726))

## [0.1.0-alpha.48](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.47...v0.1.0-alpha.48) (2026-07-16)


### Features

* **skill:** direct agents to gather rationale from real sources ([#159](https://github.com/campus-ai/prim/issues/159)) ([21c536f](https://github.com/campus-ai/prim/commit/21c536fe95f4f60b22d3f4c643268d172db190f2))
* **skill:** tailor decision presentation to the requester ([#158](https://github.com/campus-ai/prim/issues/158)) ([a913d23](https://github.com/campus-ai/prim/commit/a913d23c19e2a9b39f212d7d594d389ea6b6bc8a))

## [0.1.0-alpha.47](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.46...v0.1.0-alpha.47) (2026-07-15)


### Bug Fixes

* **auth:** accept an unchanged refresh token on rotation ([#156](https://github.com/campus-ai/prim/issues/156)) ([04a34ff](https://github.com/campus-ai/prim/commit/04a34ff9e65dd9da666400e45818bdb1e50e6cde))

## [0.1.0-alpha.46](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.45...v0.1.0-alpha.46) (2026-07-15)


### Features

* **skill:** seed decisions from repository memory ([#154](https://github.com/campus-ai/prim/issues/154)) ([bf97b5e](https://github.com/campus-ai/prim/commit/bf97b5ed3b5fad7d44ee67e523aab2b5f8c69441))

## [0.1.0-alpha.45](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.44...v0.1.0-alpha.45) (2026-07-13)


### Bug Fixes

* **daemon:** halt heartbeat + ingestion on terminal auth death ([#150](https://github.com/campus-ai/prim/issues/150)) ([58a98b2](https://github.com/campus-ai/prim/commit/58a98b20c9923ccea39067e2671a7a11b5739339))

## [0.1.0-alpha.44](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.43...v0.1.0-alpha.44) (2026-07-13)


### Features

* **statusline:** style teammate Decision links web-hyperlink blue ([6e0f1b8](https://github.com/campus-ai/prim/commit/6e0f1b80b13d9f3c45e149ff47808b0dde76435b))


### Bug Fixes

* **statusline:** strip control bytes from teammate name/area ([de2fb62](https://github.com/campus-ai/prim/commit/de2fb629e3a73431b0d92d5fe691d8ecfd8fbbd8))

## [0.1.0-alpha.43](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.42...v0.1.0-alpha.43) (2026-07-13)


### Features

* add Decision URLs to hook feedback ([#144](https://github.com/campus-ai/prim/issues/144)) ([b393d79](https://github.com/campus-ai/prim/commit/b393d7970d974208408f68ef2ceecbac1e11fd14))
* **statusline:** link teammates to latest decisions ([#145](https://github.com/campus-ai/prim/issues/145)) ([ebea278](https://github.com/campus-ai/prim/commit/ebea2782ffeac32158583661f5b7bf0b58f4253e))

## [0.1.0-alpha.42](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.41...v0.1.0-alpha.42) (2026-07-12)


### Features

* **hooks:** deliver Claude decision feedback ([#143](https://github.com/campus-ai/prim/issues/143)) ([acf9a18](https://github.com/campus-ai/prim/commit/acf9a18a42336f8d6b35c80b90efd85b1649d3a5))

### Bug Fixes

* daemon supervision and durable ingestion ([#141](https://github.com/campus-ai/prim/issues/141)) ([9525480](https://github.com/campus-ai/prim/commit/952548035e59db4087b9df0bf2d7289d51360d5e))

## [0.1.0-alpha.41](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.40...v0.1.0-alpha.41) (2026-07-09)


### Bug Fixes

* **recent:** tell the reader how many author decisions the page hides ([#138](https://github.com/campus-ai/prim/issues/138)) ([e4b8d20](https://github.com/campus-ai/prim/commit/e4b8d205728690109942b38748c6edafd7733848))

## [0.1.0-alpha.40](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.39...v0.1.0-alpha.40) (2026-07-09)


### Bug Fixes

* **ci:** pin npm to 11.18.0 so provenance publish stops breaking ([#136](https://github.com/campus-ai/prim/issues/136)) ([ac1943f](https://github.com/campus-ai/prim/commit/ac1943f791a632e6c7f0f5e988eb0cef78424b1c))

## [0.1.0-alpha.39](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.38...v0.1.0-alpha.39) (2026-07-09)


### Bug Fixes

* **recent:** drop the dead --limit hint from an empty author page ([#134](https://github.com/campus-ai/prim/issues/134)) ([7c99d93](https://github.com/campus-ai/prim/commit/7c99d930eb6619cc68b6ecf42b0f9a05697aa913))

## [0.1.0-alpha.38](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.37...v0.1.0-alpha.38) (2026-07-07)


### Features

* **statusline:** show each teammate's working area ([#131](https://github.com/campus-ai/prim/issues/131)) ([864c3a0](https://github.com/campus-ai/prim/commit/864c3a047b4cea6a6f6d001fcebaf8226d38f4c8))

## [0.1.0-alpha.37](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.36...v0.1.0-alpha.37) (2026-07-06)


### Bug Fixes

* **hooks:** cache resolved bin paths so session hooks skip per-fire npx ([#129](https://github.com/campus-ai/prim/issues/129)) ([414017a](https://github.com/campus-ai/prim/commit/414017a42d48f617b61d8c4014be10271d926805))

## [0.1.0-alpha.36](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.35...v0.1.0-alpha.36) (2026-07-06)


### Features

* **cli:** mark Conflict Gates & Enforcement as not currently enabled ([#127](https://github.com/campus-ai/prim/issues/127)) ([bf86510](https://github.com/campus-ai/prim/commit/bf86510b40118ce2c2c37c7520473297c39aea68))

## [0.1.0-alpha.35](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.34...v0.1.0-alpha.35) (2026-07-05)


### Features

* **auth:** brand the OAuth callback pages ([#124](https://github.com/campus-ai/prim/issues/124)) ([a704d31](https://github.com/campus-ai/prim/commit/a704d3114ef0dedfcec0de2955c1cbc538554f5f))
* **auth:** model the OAuth callback outcome and exit once ([#123](https://github.com/campus-ai/prim/issues/123)) ([ca1c538](https://github.com/campus-ai/prim/commit/ca1c538063f42c3661ecaf41e3cfb184d96a724d))
* default prim to user scope with per-repo opt-in activation ([#116](https://github.com/campus-ai/prim/issues/116)) ([93765ce](https://github.com/campus-ai/prim/commit/93765ce5ebfb1c6f780d8d3eab63aee4064c5e57))
* **setup:** agent mines its memory to draft seeding goals during onboarding ([#118](https://github.com/campus-ai/prim/issues/118)) ([5ff7b90](https://github.com/campus-ai/prim/commit/5ff7b907ab9f5b0ca3ede7a6057930253a473e62))
* **skill:** deliver the Claude guide as a skills-directory plugin ([#126](https://github.com/campus-ai/prim/issues/126)) ([115e700](https://github.com/campus-ai/prim/commit/115e7001e1936cdf35a739be68632bd747ca64bb))

## [0.1.0-alpha.34](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.33...v0.1.0-alpha.34) (2026-07-03)


### Features

* **decisions:** add --author to `decisions recent` so agents can answer "what has X decided?" ([#119](https://github.com/campus-ai/prim/issues/119)) ([0fbd2ef](https://github.com/campus-ai/prim/commit/0fbd2ef287dfeae5aef5e0e15c051d22687fb339))

## [0.1.0-alpha.33](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.32...v0.1.0-alpha.33) (2026-07-03)


### Features

* **setup:** route the skill file by agent so only Claude Code gets CLAUDE.md ([#114](https://github.com/campus-ai/prim/issues/114)) ([3d22cc0](https://github.com/campus-ai/prim/commit/3d22cc09363b1169e0c82afdd68bfc335cf78962))


### Bug Fixes

* **claude:** detach SessionEnd hooks so session teardown never cancels them ([#117](https://github.com/campus-ai/prim/issues/117)) ([4e93fc6](https://github.com/campus-ai/prim/commit/4e93fc650ebbc62e1cbbe1411af7228c878a5176))

## [0.1.0-alpha.32](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.31...v0.1.0-alpha.32) (2026-06-30)


### Features

* add Hermes Agent support ([#111](https://github.com/campus-ai/prim/issues/111)) ([6080445](https://github.com/campus-ai/prim/commit/60804451f3a2e5cdc5b592b76a53962133fee152))
* **setup:** auto-detect the calling agent so a bare `prim setup` wires the right integration ([#113](https://github.com/campus-ai/prim/issues/113)) ([727c242](https://github.com/campus-ai/prim/commit/727c24296a9815b2627fe477b594d651df44509d))

## [0.1.0-alpha.31](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.30...v0.1.0-alpha.31) (2026-06-29)


### Bug Fixes

* **journal:** reject dot-only env slugs that escape the moves tree ([#109](https://github.com/campus-ai/prim/issues/109)) ([288a5c5](https://github.com/campus-ai/prim/commit/288a5c5c96e7e01e2d6824c739ab19cde9fec3b7))

## [0.1.0-alpha.30](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.29...v0.1.0-alpha.30) (2026-06-29)


### Features

* **doctor:** add `prim doctor` end-to-end capture health check ([#79](https://github.com/campus-ai/prim/issues/79)) ([7f6090e](https://github.com/campus-ai/prim/commit/7f6090e50ab2b345f61de8d92203dfe37b74f91a))
* **flusher:** recover orphaned .flushing files on drain ([#78](https://github.com/campus-ai/prim/issues/78)) ([b5348af](https://github.com/campus-ai/prim/commit/b5348af082307dae646a5930f650a27040f0e80c))
* **moves:** surface stranded .flushing files in `moves status` ([#76](https://github.com/campus-ai/prim/issues/76)) ([24c784a](https://github.com/campus-ai/prim/commit/24c784a973b16dc2ef44a77245ebcf35a327b4f2))


### Bug Fixes

* **journal:** partition the move journal by environment ([#108](https://github.com/campus-ai/prim/issues/108)) ([9d42683](https://github.com/campus-ai/prim/commit/9d42683fe34bd35aba7d55ed736e2444f5c9068e))

## [0.1.0-alpha.29](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.28...v0.1.0-alpha.29) (2026-06-29)


### Bug Fixes

* **daemon:** persist the daemon log instead of discarding it ([#75](https://github.com/campus-ai/prim/issues/75)) ([0af2eb1](https://github.com/campus-ai/prim/commit/0af2eb1e1287cc5a2c8b5e3561c789dda546642b))
* **daemon:** refuse cross-environment proxied reads and withhold cross-env presence ([#101](https://github.com/campus-ai/prim/issues/101)) ([372b26a](https://github.com/campus-ai/prim/commit/372b26a4e935edcbbf7f1a1ef29f411315ee4638))

## [0.1.0-alpha.28](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.27...v0.1.0-alpha.28) (2026-06-28)


### Features

* pass auto-mode classifier with zero approvals (command-first onboarding + autoMode trust) ([#104](https://github.com/campus-ai/prim/issues/104)) ([8950792](https://github.com/campus-ai/prim/commit/8950792ad9f3a50a9d4446de9846aea96a0ea354))

## [0.1.0-alpha.27](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.26...v0.1.0-alpha.27) (2026-06-28)


### Features

* frictionless agent-driven prim onboarding (one approval, not eleven) ([#102](https://github.com/campus-ai/prim/issues/102)) ([8b7e257](https://github.com/campus-ai/prim/commit/8b7e257f1e9d789495ce89ffdec2fb42c71c0a8d))

## [0.1.0-alpha.26](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.25...v0.1.0-alpha.26) (2026-06-26)


### Bug Fixes

* **cli:** tidy pre-auth idempotency and two over-claiming comments ([#99](https://github.com/campus-ai/prim/issues/99)) ([2370d54](https://github.com/campus-ai/prim/commit/2370d54e7b9ec36f07c6409b56e8521877622ea4))

## [0.1.0-alpha.25](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.24...v0.1.0-alpha.25) (2026-06-26)


### Bug Fixes

* **cli:** broaden the prim pre-auth rule to cover day-to-day calls ([#97](https://github.com/campus-ai/prim/issues/97)) ([32013c8](https://github.com/campus-ai/prim/commit/32013c8bba0ad0b43ae0c9259be1583e77eae32c))

## [0.1.0-alpha.24](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.23...v0.1.0-alpha.24) (2026-06-26)


### Features

* **cli:** one-shot `prim setup` + pre-authorize prim in claude install ([#95](https://github.com/campus-ai/prim/issues/95)) ([c28dcfa](https://github.com/campus-ai/prim/commit/c28dcfa93e3efcd3f56692230f5637a027f6e961))

## [0.1.0-alpha.23](https://github.com/campus-ai/prim/compare/v0.1.0-alpha.22...v0.1.0-alpha.23) (2026-06-25)


### Features

* **decisions:** link/unlink commands to relate decisions ([#89](https://github.com/campus-ai/prim/issues/89)) ([2c9f55d](https://github.com/campus-ai/prim/commit/2c9f55da91ac0f0c5961f45381d70de138797217))


### Bug Fixes

* **cli:** make the seeding question the terminal call-to-action ([#93](https://github.com/campus-ai/prim/issues/93)) ([95666fb](https://github.com/campus-ai/prim/commit/95666fb27911b0cd1436437bc6be943604eeeb2c))
* **cli:** seed the welcome flow by viewer, not org ([#92](https://github.com/campus-ai/prim/issues/92)) ([4353fab](https://github.com/campus-ai/prim/commit/4353fabade2d5d077012b5e80e8fbe287b4955b6))

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
