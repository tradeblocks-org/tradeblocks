#!/usr/bin/env python3
"""Mechanical Tier 3 PR-open protocol gate.

The semantic Worf review still happens in Picard's session. This script only
checks the two machine-visible signals that make the Tier 3 protocol auditable:
the `worf-cleared` label and the non-author Admiral review request.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
import sys
from typing import Iterable


LANE_TO_LOGIN = {
    "romeo": "davidromeo",
    "smith": "longpshorn",
}
LOGIN_TO_LANE = {login: lane for lane, login in LANE_TO_LOGIN.items()}
WORF_CLEARED_LABEL = "worf-cleared"


@dataclass(frozen=True)
class GateResult:
    ok: bool
    message: str


def _names(values: Iterable[object], key: str) -> list[str]:
    names: list[str] = []
    for value in values:
        if isinstance(value, str):
            names.append(value)
        elif isinstance(value, dict) and isinstance(value.get(key), str):
            names.append(value[key])
    return names


def _loads_json_list(raw: str | None) -> list[object]:
    if not raw:
        return []
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError("expected a JSON list")
    return parsed


def author_lane(head_ref: str, author_login: str) -> str | None:
    match = re.match(r"^(romeo|smith)/", head_ref)
    if match:
        return match.group(1)
    return LOGIN_TO_LANE.get(author_login)


def required_reviewer_for_lane(lane: str) -> str:
    for candidate_lane, login in LANE_TO_LOGIN.items():
        if candidate_lane != lane:
            return login
    raise ValueError(f"unknown lane: {lane}")


def evaluate(
    *,
    tier: str,
    head_ref: str,
    author_login: str,
    labels: Iterable[str],
    requested_reviewers: Iterable[str],
    pr_number: str = "<PR>",
    required_label: str = WORF_CLEARED_LABEL,
) -> GateResult:
    tier = tier.strip()
    if tier != "3":
        return GateResult(True, f"PR is not Tier 3 (Tier: {tier or 'missing'}); tier3-protocol gate skipped.")

    lane = author_lane(head_ref, author_login)
    if lane is None:
        return GateResult(
            False,
            "Unable to determine author lane from branch prefix or PR author. "
            "Use a romeo/ or smith/ branch, or update the gate's login mapping.",
        )

    label_set = set(labels)
    reviewer_set = set(requested_reviewers)
    required_reviewer = required_reviewer_for_lane(lane)
    errors: list[str] = []

    if required_label not in label_set:
        errors.append(
            f"Missing `{required_label}` label. Dispatch Worf, address any HOLD findings, "
            f"then apply the label with: gh pr edit {pr_number} --add-label {required_label}"
        )

    if required_reviewer not in reviewer_set:
        errors.append(
            f"Missing cross-Admiral review request for `{required_reviewer}`. "
            f"PR body prose is not notification; request review with: "
            f"gh pr edit {pr_number} --add-reviewer {required_reviewer}"
        )

    if errors:
        return GateResult(False, "\n".join(errors))

    return GateResult(
        True,
        f"Tier 3 protocol signals present: `{required_label}` label and `{required_reviewer}` review request.",
    )


def evaluate_from_env() -> GateResult:
    labels = _names(_loads_json_list(os.environ.get("PR_LABELS_JSON")), "name")
    reviewers = _names(_loads_json_list(os.environ.get("PR_REVIEWERS_JSON")), "login")
    return evaluate(
        tier=os.environ.get("PR_TIER", ""),
        head_ref=os.environ.get("PR_HEAD_REF", ""),
        author_login=os.environ.get("PR_AUTHOR_LOGIN", ""),
        labels=labels,
        requested_reviewers=reviewers,
        pr_number=os.environ.get("PR_NUMBER", "<PR>"),
        required_label=os.environ.get("WORF_CLEARED_LABEL", WORF_CLEARED_LABEL),
    )


def main() -> int:
    try:
        result = evaluate_from_env()
    except Exception as exc:
        print(f"::error::tier3-protocol gate crashed: {exc}", file=sys.stderr)
        return 1

    if result.ok:
        print(result.message)
        return 0

    for line in result.message.splitlines():
        print(f"::error::{line}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
