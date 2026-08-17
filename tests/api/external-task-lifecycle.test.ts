import { describe, expect, it } from "vitest";

import {
  EXTERNAL_STATE_TRANSITIONS,
  EXTERNAL_STATES,
  canExternalTransition,
  isExternalTerminalState,
  type ExternalStateActor,
  type ExternalStateName,
} from "../../api/lib/external-task-lifecycle";

const ACTORS = ["service_principal", "approver", "worker", "sweeper"] as const satisfies readonly ExternalStateActor[];

describe("external task lifecycle table", () => {
  it("enumerates a decision for every state pair and actor", () => {
    for (const actor of ACTORS) {
      for (const from of Object.keys(EXTERNAL_STATES) as ExternalStateName[]) {
        for (const to of Object.keys(EXTERNAL_STATES) as ExternalStateName[]) {
          expect(typeof canExternalTransition(from, to, actor)).toBe("boolean");
        }
      }
    }
  });

  it("contains no transition to a publication action or state", () => {
    expect(JSON.stringify({ states: EXTERNAL_STATES, transitions: EXTERNAL_STATE_TRANSITIONS })).not.toMatch(/publish/i);
  });

  it("makes every terminal tuple immutable for every actor", () => {
    for (const from of Object.keys(EXTERNAL_STATES) as ExternalStateName[]) {
      if (!isExternalTerminalState(from)) continue;
      for (const actor of ACTORS) {
        for (const to of Object.keys(EXTERNAL_STATES) as ExternalStateName[]) {
          expect(canExternalTransition(from, to, actor)).toBe(false);
        }
      }
    }
  });

  it.each([
    ["created", "queued", ["worker"]],
    ["queued", "approval_pending", ["worker"]],
    ["approval_pending", "queued", ["approver"]],
    ["queued", "running", ["worker"]],
    ["running", "submitted", ["worker"]],
    ["submitted", "completed", ["worker"]],
    ["running", "cancel_requested", ["service_principal"]],
    ["cancel_requested", "cancelled", ["worker", "sweeper"]],
    ["queued", "cancelled", ["service_principal"]],
    ["running", "queued", ["sweeper"]],
    ["running", "failed", ["worker", "sweeper"]],
  ] as const)("allows %s -> %s only for its bound actors", (from, to, allowedActors) => {
    for (const other of ACTORS) {
      expect(canExternalTransition(from, to, other)).toBe(allowedActors.includes(other as never));
    }
  });

  it.each([
    ["created", "running", "worker"],
    ["approval_pending", "running", "worker"],
    ["running", "completed", "worker"],
    ["cancel_requested", "completed", "worker"],
    ["completed", "running", "worker"],
    ["cancelled", "queued", "sweeper"],
    ["failed", "queued", "sweeper"],
    ["queued", "completed", "service_principal"],
  ] as const)("forbids %s -> %s by %s", (from, to, actor) => {
    expect(canExternalTransition(from, to, actor)).toBe(false);
  });
});
