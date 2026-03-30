# `prim holler` Command

## Overview

Top-level command that tests connectivity to the Primitive backend and
reports round-trip latency. Useful for verifying configuration and
diagnosing connection issues.

## Behavior

```
$ prim holler
Pinging https://ceaseless-lemur-432.convex.site...
Connected in 1117ms
```

If unreachable:
```
$ prim holler
Pinging https://ceaseless-lemur-432.convex.site...
Connection failed (3012ms): fetch failed
```

## Implementation

- Registered via `registerPingCommand` in `src/commands/ping.ts`
- Command name is `holler` (renamed from `ping`)
- Exported `getSiteUrl()` from `src/client.ts` to display the target URL
- Measures round-trip via `performance.now()` against `GET /api/cli/specs`
- Reports latency on both success and failure paths

## Files

| File | Purpose |
|------|---------|
| `src/commands/ping.ts` | Command implementation |
| `src/commands/ping.spec.ts` | Registration test |
| `src/client.ts` | Exported `getSiteUrl` |
| `src/index.ts` | Wiring |

## Status

Complete. Verified live against staging.
