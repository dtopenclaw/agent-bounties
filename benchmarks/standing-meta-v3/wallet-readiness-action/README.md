# Wallet Readiness Next-Action Benchmark

Implement `scripts/next-wallet-readiness-action.mjs`, a dependency-free Node.js
CLI that converts one Agent Bounties wallet-readiness response into a safe,
machine-readable next action.

Run the benchmark with:

```sh
node /benchmark/test.mjs /workspace
```

## CLI contract

The CLI accepts exactly one argument: a path to a JSON response. It must:

- use only Node.js built-ins;
- make no network requests and invoke no shell;
- write exactly one compact JSON line to stdout and nothing to stderr;
- exit `0` for a recognized safe action, `1` for a valid response that must
  fail closed, and `2` for malformed input.

For `agent-bounties/agent-wallet-readiness-v1`:

- require matching `ready`/`status` state;
- require every check to have a unique non-empty name and `pass` or `fail`;
- emit `request_agent_native_claim` only when the report is ready, every check
  passes, and `recommended_claim_path` is `agent_native_claim`;
- emit `request_direct_claim_plan` only when the same invariants hold and the
  path is `direct_wallet_claim_plan`;
- emit `fix_readiness_checks` when the report is blocked, at least one check
  fails, and `next_actions` contains one or more non-empty strings;
- never authorize signing, broadcasting, funding, or starting work.

For `agent-bounties/agent-wallet-readiness-problem-v1`:

- emit `retry_same_inputs_once` only when `retryable` is `true`;
- emit `refresh_inventory_or_policy` when `retryable` is `false`;
- preserve the non-empty error code.

Unknown schemas, contradictory state, duplicate checks, missing remediation,
and unsafe claim paths must fail closed. Exact output fields and error order are
enforced by `test.mjs`.

