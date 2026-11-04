# Pre-seed metadata compatibility baseline

These files are immutable copies from `campus-ai/prim` commit
`2438a817a4da09eaaa991ece0cf70b67e90cba73`, before additive seed metadata.
`provenance.json` records the original paths, SHA-256 digests, and that CLI's
canonical server revision. `validators.mjs` preserves the generated validator
module byte for byte; only its filename changes for direct ESM loading.

`pnpm check:seed-metadata-golden` always runs this baseline, including in CI:

- Current server response fixtures must pass the captured old validators.
- Captured old response fixtures must pass the current server schema and CLI
  validators.
- Baseline hashes must match their recorded provenance.

The optional `--server-dir` uses a candidate backend checkout instead of the
current vendored server contract. It does not change the older baseline.
`contracts:update` must never refresh these files. They are test artifacts and
are not included in the published CLI package.
