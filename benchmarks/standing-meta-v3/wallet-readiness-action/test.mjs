import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sourceRoot = resolve(process.argv[2] ?? "/workspace");
const implementation = join(sourceRoot, "scripts", "next-wallet-readiness-action.mjs");
const temporary = mkdtempSync(join(tmpdir(), "wallet-readiness-action-"));

function fixture(name, value, raw = false) {
  const path = join(temporary, name);
  writeFileSync(path, raw ? value : `${JSON.stringify(value)}\n`);
  return path;
}

function invoke(args) {
  return spawnSync(process.execPath, [implementation, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
}

function expectRun(name, args, status, output) {
  const result = invoke(args);
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  if (result.status !== status) {
    throw new Error(
      `${name}: expected exit ${status}, received ${result.status}; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  if (result.stderr !== "") {
    throw new Error(`${name}: stderr must be empty: ${JSON.stringify(result.stderr)}`);
  }
  const expected = `${JSON.stringify(output)}\n`;
  if (result.stdout !== expected) {
    throw new Error(
      `${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(result.stdout)}`,
    );
  }
}

const ready = {
  schema_version: "agent-bounties/agent-wallet-readiness-v1",
  ready: true,
  status: "ready",
  recommended_claim_path: "agent_native_claim",
  checks: [
    { name: "canonical_bounty", status: "pass" },
    { name: "claim_bond_balance", status: "pass" },
  ],
  next_actions: [],
};

try {
  if (!existsSync(implementation)) {
    throw new Error(`missing implementation: ${implementation}`);
  }

  expectRun("missing argument", [], 2, {
    ok: false,
    errors: ["response_path_required"],
  });
  expectRun("extra argument", ["one", "two"], 2, {
    ok: false,
    errors: ["exactly_one_response_path_required"],
  });
  expectRun("missing file", [join(temporary, "absent.json")], 2, {
    ok: false,
    errors: ["response_unreadable"],
  });
  expectRun("invalid json", [fixture("invalid.json", "{", true)], 2, {
    ok: false,
    errors: ["response_invalid_json"],
  });
  expectRun("root array", [fixture("array.json", [])], 2, {
    ok: false,
    errors: ["response_object_required"],
  });
  expectRun("agent native ready", [fixture("ready.json", ready)], 0, {
    ok: true,
    state: "ready",
    action: "request_agent_native_claim",
    may_sign: false,
    may_broadcast: false,
    may_start_work: false,
  });
  expectRun(
    "direct ready",
    [fixture("direct.json", { ...ready, recommended_claim_path: "direct_wallet_claim_plan" })],
    0,
    {
      ok: true,
      state: "ready",
      action: "request_direct_claim_plan",
      may_sign: false,
      may_broadcast: false,
      may_start_work: false,
    },
  );
  expectRun(
    "blocked",
    [
      fixture("blocked.json", {
        ...ready,
        ready: false,
        status: "blocked",
        recommended_claim_path: null,
        checks: [
          { name: "canonical_bounty", status: "pass" },
          { name: "claim_bond_balance", status: "fail" },
        ],
        next_actions: ["Fund the exact bond shortfall."],
      }),
    ],
    0,
    {
      ok: true,
      state: "blocked",
      action: "fix_readiness_checks",
      failed_checks: ["claim_bond_balance"],
      next_actions: ["Fund the exact bond shortfall."],
      may_sign: false,
      may_broadcast: false,
      may_start_work: false,
    },
  );
  expectRun(
    "retryable problem",
    [
      fixture("retryable.json", {
        schema_version: "agent-bounties/agent-wallet-readiness-problem-v1",
        error_code: "rpc_unavailable",
        retryable: true,
      }),
    ],
    0,
    {
      ok: true,
      state: "problem",
      action: "retry_same_inputs_once",
      error_code: "rpc_unavailable",
      may_sign: false,
      may_broadcast: false,
      may_start_work: false,
    },
  );
  expectRun(
    "terminal problem",
    [
      fixture("terminal.json", {
        schema_version: "agent-bounties/agent-wallet-readiness-problem-v1",
        error_code: "policy_invalid",
        retryable: false,
      }),
    ],
    0,
    {
      ok: true,
      state: "problem",
      action: "refresh_inventory_or_policy",
      error_code: "policy_invalid",
      may_sign: false,
      may_broadcast: false,
      may_start_work: false,
    },
  );

  const unsafeCases = [
    ["unknown schema", { ...ready, schema_version: "unknown" }, ["schema_unsupported:unknown"]],
    ["contradictory state", { ...ready, ready: false }, ["readiness_state_invalid"]],
    [
      "failed ready check",
      { ...ready, checks: [{ name: "canonical_bounty", status: "fail" }] },
      ["readiness_state_invalid"],
    ],
    [
      "duplicate check",
      {
        ...ready,
        checks: [
          { name: "canonical_bounty", status: "pass" },
          { name: "canonical_bounty", status: "pass" },
        ],
      },
      ["checks_invalid"],
    ],
    ["unsafe path", { ...ready, recommended_claim_path: "sign_and_broadcast" }, ["claim_path_unsupported"]],
    [
      "blocked without remediation",
      {
        ...ready,
        ready: false,
        status: "blocked",
        recommended_claim_path: null,
        checks: [{ name: "claim_bond_balance", status: "fail" }],
        next_actions: [],
      },
      ["blocked_remediation_required"],
    ],
    [
      "problem missing code",
      {
        schema_version: "agent-bounties/agent-wallet-readiness-problem-v1",
        error_code: "",
        retryable: false,
      },
      ["problem_invalid"],
    ],
  ];
  for (const [name, value, errors] of unsafeCases) {
    expectRun(name, [fixture(`${name.replaceAll(" ", "-")}.json`, value)], 1, {
      ok: false,
      errors,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, benchmark: "wallet-readiness-action" })}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
