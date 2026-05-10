#!/usr/bin/env python3
"""Validate Codex init-project/team hard process contracts.

This validator is intentionally small and dependency-free so generated projects can
copy it into `.codex/scripts/` and wire it into QA/project-scope gates.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "2026-04-30.init-team-hard.v1"
CONTRACT_KIND = "init-project-team-hard-process"
REQUIRED_CONTRACT_IDS = {
    "init-project-profile",
    "project-scope-hooks",
    "qa-scenario-contract",
    "qa-cycle-hard-gate",
    "team-precontext-contract",
    "team-runtime-contract",
    "team-handoff-contract",
    "workflow-skill-chain",
    "self-improve-feedback-loop",
    "start-harness-bootstrap",
    "loopy-era-eval-gate",
}
REQUIRED_EDGE_IDS = {
    "init-project->hard-contract",
    "hard-contract->team-precontext",
    "hard-contract->qa-scenario-gen",
    "init-project->team-handoff",
    "team-handoff->team-runtime",
    "qa-scenarios->qa-cycle",
    "qa-cycle->team-verification-lane",
    "verify-project-scope->hard-contract",
    "init-project->workflow-skill-chain",
    "init-project->generated-project-skills",
    "qa-cycle->self-improve",
    "start-harness->init-project",
    "loopy-era-eval->start-harness",
}
USER_SCOPE_MARKERS = {
    "skills/init-project/SKILL.md": [
        "## Hard process contract gate [HARD]",
        "validate-hard-process-contract.py --project-root \"$(pwd)\" --require-project-contract --json",
    ],
    "skills/team-hue/SKILL.md": [
        "## Hard process contract gate [HARD]",
        "validate-hard-process-contract.py --project-root \"$(pwd)\" --require-project-contract --json",
    ],
    "scripts/init-project-runtime.py": [
        "HARD_PROCESS_CONTRACT_SCHEMA_VERSION",
        "build_hard_process_contract",
        "build_team_handoff",
        "CONNECTED_WORKFLOW_SKILLS",
        "INIT_WORKFLOW_SKILL_AUDIT_COMMAND",
        "workflow-skill-chain",
        ".codex/loopy-era/hard-process-contract.json",
        ".codex/loopy-era/team-handoff.json",
        "validate-hard-process-contract.py",
    ],
    "scripts/team-runtime.py": [
        "validate_hard_process_contract",
        "missing_hard_process_contract",
        "hard_contract_status",
    ],
    "scripts/qa-scenario-gen.py": [
        "blocker_count = len(missing)",
        '"status": "pass" if blocker_count == 0 else "fail"',
    ],
    "scripts/qa-cycle-runtime.py": [
        "hard:process-contract",
        "validate-hard-process-contract.py --project-root . --require-project-contract",
    ],
    "scripts/verify-project-scope-load.sh": [
        'validate-hard-process-contract.py --project-root "$PROJECT_ROOT" --require-project-contract --json',
    ],
    "scripts/validate-init-workflow-skills.py": [
        "CONNECTED_SKILLS",
        "PROJECT_REQUIRED_FILES",
        "workflow-skill-chain",
    ],
    "scripts/self-improve-smoke.sh": [
        "validate-init-workflow-skills.py",
        "workflow.get('passed')",
    ],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate Codex hard init/team process contracts")
    parser.add_argument("--project-root", default=os.getcwd())
    parser.add_argument("--require-project-contract", action="store_true")
    parser.add_argument("--user-scope", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def add(checks: list[dict[str, Any]], name: str, ok: bool, evidence: str = "", required: bool = True) -> None:
    checks.append({"name": name, "ok": bool(ok), "required": required, "evidence": evidence})


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except Exception as exc:  # noqa: BLE001 - validator reports parse failure as evidence
        return {"__parse_error__": str(exc)}


def walk_values(value: Any) -> list[Any]:
    values = [value]
    if isinstance(value, dict):
        for child in value.values():
            values.extend(walk_values(child))
    elif isinstance(value, list):
        for child in value:
            values.extend(walk_values(child))
    return values


def status_is_hard(item: dict[str, Any]) -> bool:
    for key in ("type", "edge_type", "gate_type", "contract_type", "strength"):
        if key in item and str(item.get(key)) != "hard":
            return False
    return True


def validate_team_handoff(root: Path, *, require: bool) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    path = root / ".codex" / "loopy-era" / "team-handoff.json"
    if not path.exists():
        add(checks, "team-handoff:exists", not require, str(path), required=require)
        return checks
    data = read_json(path)
    add(checks, "team-handoff:parse", isinstance(data, dict), str(path))
    if not isinstance(data, dict):
        return checks
    add(checks, "team-handoff:schema-version", data.get("schema_version") == SCHEMA_VERSION, str(data.get("schema_version")))
    add(checks, "team-handoff:type", data.get("contract_type") == "hard", str(data.get("contract_type")))
    add(checks, "team-handoff:handoff-type", data.get("handoff_type") == "init-project-to-team", str(data.get("handoff_type")))
    add(checks, "team-handoff:from-to", data.get("from") == "$init-project" and data.get("to") == "$team-hue", f"{data.get('from')}->{data.get('to')}")
    add(checks, "team-handoff:hard-contract-path", data.get("hard_contract_path") == ".codex/loopy-era/hard-process-contract.json", str(data.get("hard_contract_path")))
    add(checks, "team-handoff:validator-command", data.get("validator_command") == "python3 .codex/scripts/validate-hard-process-contract.py --project-root . --require-project-contract --json", str(data.get("validator_command")))
    add(checks, "team-handoff:team-runtime-plan-command", "team-runtime.py" in str(data.get("team_runtime_plan_command", "")) and "--json" in str(data.get("team_runtime_plan_command", "")), str(data.get("team_runtime_plan_command", "")))
    add(checks, "team-handoff:team-runtime-execute-command", "team-runtime.py" in str(data.get("team_runtime_execute_command", "")) and "--execute" in str(data.get("team_runtime_execute_command", "")), str(data.get("team_runtime_execute_command", "")))
    add(checks, "team-handoff:omx-team-launch-hint", str(data.get("omx_team_launch_hint", "")).startswith("omx team"), str(data.get("omx_team_launch_hint", "")))
    policy = data.get("auto_chain_policy") if isinstance(data.get("auto_chain_policy"), dict) else {}
    add(checks, "team-handoff:auto-chain-policy-hard", policy.get("type") == "hard" and policy.get("call_team_when_build_or_task_present") is True, str(policy))
    hard_gates = [item for item in data.get("required_prelaunch_gates", []) if isinstance(item, dict)]
    add(checks, "team-handoff:prelaunch-gates-hard", bool(hard_gates) and all(item.get("type") == "hard" for item in hard_gates), str(hard_gates[:3]))
    gate_ids = {str(item.get("id")) for item in hard_gates}
    add(checks, "team-handoff:init-workflow-audit-gate", "init-workflow-skill-audit" in gate_ids, str(sorted(gate_ids)))
    workflow_skills = data.get("connected_workflow_skills")
    required_skills = {"init-project", "team-hue", "qa-scenario-gen", "qa-cycle", "qa-strategy", "auto-issue", "start-harness", "loopy-era-eval", "self-improve", "backend-patterns", "frontend-patterns", "<project>-scaffold"}
    add(checks, "team-handoff:connected-workflow-skills", isinstance(workflow_skills, list) and required_skills.issubset(set(map(str, workflow_skills))), str(workflow_skills))
    return checks


def validate_contract(root: Path, *, require: bool) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    path = root / ".codex" / "loopy-era" / "hard-process-contract.json"
    if not path.exists():
        add(checks, "project-contract:exists", not require, str(path), required=require)
        return checks

    data = read_json(path)
    if isinstance(data, dict) and "__parse_error__" in data:
        add(checks, "project-contract:parse", False, data["__parse_error__"])
        return checks
    add(checks, "project-contract:parse", isinstance(data, dict), str(path))
    if not isinstance(data, dict):
        return checks

    add(checks, "project-contract:schema-version", data.get("schema_version") == SCHEMA_VERSION, str(data.get("schema_version")))
    add(checks, "project-contract:kind", data.get("contract_kind") == CONTRACT_KIND, str(data.get("contract_kind")))
    add(checks, "project-contract:type", data.get("contract_type") == "hard", str(data.get("contract_type")))

    contracts = data.get("contracts")
    edges = data.get("contract_edges")
    validators = data.get("validators")
    add(checks, "project-contract:contracts-list", isinstance(contracts, list) and bool(contracts), "contracts")
    add(checks, "project-contract:edges-list", isinstance(edges, list) and bool(edges), "contract_edges")
    add(checks, "project-contract:validators-list", isinstance(validators, list) and bool(validators), "validators")

    contract_ids = {str(item.get("id")) for item in contracts or [] if isinstance(item, dict)}
    edge_ids = {str(item.get("id")) for item in edges or [] if isinstance(item, dict)}
    add(checks, "project-contract:required-contract-ids", REQUIRED_CONTRACT_IDS.issubset(contract_ids), ",".join(sorted(REQUIRED_CONTRACT_IDS - contract_ids)))
    add(checks, "project-contract:required-edge-ids", REQUIRED_EDGE_IDS.issubset(edge_ids), ",".join(sorted(REQUIRED_EDGE_IDS - edge_ids)))

    typed_items = [item for item in (contracts or []) + (edges or []) + (validators or []) if isinstance(item, dict)]
    non_hard = [str(item.get("id") or item.get("command") or item) for item in typed_items if not status_is_hard(item)]
    add(checks, "project-contract:all-typed-items-hard", not non_hard, "; ".join(non_hard[:5]))

    soft_values = [value for value in walk_values(data) if isinstance(value, str) and value.strip().lower() == "soft"]
    add(checks, "project-contract:no-soft-values", not soft_values, str(soft_values[:5]))

    validator_commands = {str(item.get("command", "")) for item in validators or [] if isinstance(item, dict)}
    expected_command = "python3 .codex/scripts/validate-hard-process-contract.py --project-root . --require-project-contract --json"
    add(checks, "project-contract:self-validator-command", expected_command in validator_commands, expected_command)
    audit_command = "python3 ~/.codex/scripts/validate-init-workflow-skills.py --project-root . --require-project-artifacts --project-only --json"
    add(checks, "project-contract:init-workflow-audit-command", audit_command in validator_commands, audit_command)
    workflow_skills = data.get("connected_workflow_skills")
    required_skills = {"init-project", "team-hue", "qa-scenario-gen", "qa-cycle", "qa-strategy", "auto-issue", "start-harness", "loopy-era-eval", "self-improve", "backend-patterns", "frontend-patterns", "<project>-scaffold"}
    add(checks, "project-contract:connected-workflow-skills", isinstance(workflow_skills, list) and required_skills.issubset(set(map(str, workflow_skills))), str(workflow_skills))
    return checks


def validate_user_scope() -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    codex_home = Path.home() / ".codex"
    for rel, markers in USER_SCOPE_MARKERS.items():
        path = codex_home / rel
        add(checks, f"user-scope:{rel}:exists", path.exists(), str(path))
        text = path.read_text(errors="replace") if path.exists() else ""
        for marker in markers:
            add(checks, f"user-scope:{rel}:marker:{marker[:48]}", marker in text, marker)
    add(checks, "user-scope:validator-executable", os.access(codex_home / "scripts" / "validate-hard-process-contract.py", os.X_OK), "~/.codex/scripts/validate-hard-process-contract.py")
    return checks


def summarize(checks: list[dict[str, Any]]) -> dict[str, Any]:
    failures = [item for item in checks if item.get("required", True) and not item.get("ok")]
    return {
        "status": "pass" if not failures else "fail",
        "passed": not failures,
        "schema_version": SCHEMA_VERSION,
        "check_count": len(checks),
        "failure_count": len(failures),
        "failures": failures,
        "checks": checks,
    }


def main() -> int:
    args = parse_args()
    checks: list[dict[str, Any]] = []
    if args.user_scope:
        checks.extend(validate_user_scope())
    project_root = Path(args.project_root).resolve()
    checks.extend(validate_contract(project_root, require=args.require_project_contract))
    checks.extend(validate_team_handoff(project_root, require=args.require_project_contract))
    payload = summarize(checks)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
