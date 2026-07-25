import { readFileSync } from "node:fs";

const READINESS_SCHEMA = "agent-bounties/agent-wallet-readiness-v1";
const PROBLEM_SCHEMA = "agent-bounties/agent-wallet-readiness-problem-v1";

function finish(status, value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = status;
}

function refusal(error) {
  finish(1, { ok: false, errors: [error] });
}

function malformed(error) {
  finish(2, { ok: false, errors: [error] });
}

function safeAction(state, action, fields = {}) {
  finish(0, {
    ok: true,
    state,
    action,
    ...fields,
    may_sign: false,
    may_broadcast: false,
    may_start_work: false,
  });
}

function validChecks(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const names = new Set();
  for (const check of value) {
    if (
      check === null ||
      typeof check !== "object" ||
      Array.isArray(check) ||
      typeof check.name !== "string" ||
      check.name.trim() === "" ||
      (check.status !== "pass" && check.status !== "fail") ||
      names.has(check.name)
    ) {
      return false;
    }
    names.add(check.name);
  }
  return true;
}

function handleReadiness(response) {
  if (!validChecks(response.checks)) {
    refusal("checks_invalid");
    return;
  }

  const failedChecks = response.checks
    .filter((check) => check.status === "fail")
    .map((check) => check.name);
  const readyState = response.ready === true && response.status === "ready";
  const blockedState = response.ready === false && response.status === "blocked";

  if ((!readyState && !blockedState) || (readyState && failedChecks.length > 0)) {
    refusal("readiness_state_invalid");
    return;
  }

  if (readyState) {
    if (response.recommended_claim_path === "agent_native_claim") {
      safeAction("ready", "request_agent_native_claim");
      return;
    }
    if (response.recommended_claim_path === "direct_wallet_claim_plan") {
      safeAction("ready", "request_direct_claim_plan");
      return;
    }
    refusal("claim_path_unsupported");
    return;
  }

  if (failedChecks.length === 0) {
    refusal("readiness_state_invalid");
    return;
  }
  if (
    !Array.isArray(response.next_actions) ||
    response.next_actions.length === 0 ||
    response.next_actions.some(
      (action) => typeof action !== "string" || action.trim() === "",
    )
  ) {
    refusal("blocked_remediation_required");
    return;
  }

  safeAction("blocked", "fix_readiness_checks", {
    failed_checks: failedChecks,
    next_actions: response.next_actions,
  });
}

function handleProblem(response) {
  if (
    typeof response.error_code !== "string" ||
    response.error_code.trim() === "" ||
    typeof response.retryable !== "boolean"
  ) {
    refusal("problem_invalid");
    return;
  }
  safeAction(
    "problem",
    response.retryable ? "retry_same_inputs_once" : "refresh_inventory_or_policy",
    { error_code: response.error_code },
  );
}

if (process.argv.length < 3) {
  malformed("response_path_required");
} else if (process.argv.length !== 3) {
  malformed("exactly_one_response_path_required");
} else {
  let raw;
  try {
    raw = readFileSync(process.argv[2], "utf8");
  } catch {
    malformed("response_unreadable");
  }

  if (raw !== undefined) {
    let response;
    try {
      response = JSON.parse(raw);
    } catch {
      malformed("response_invalid_json");
    }

    if (response !== undefined) {
      if (response === null || typeof response !== "object" || Array.isArray(response)) {
        malformed("response_object_required");
      } else if (response.schema_version === READINESS_SCHEMA) {
        handleReadiness(response);
      } else if (response.schema_version === PROBLEM_SCHEMA) {
        handleProblem(response);
      } else {
        refusal(`schema_unsupported:${String(response.schema_version)}`);
      }
    }
  }
}
