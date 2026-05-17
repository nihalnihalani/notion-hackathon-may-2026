/**
 * Type-level tests for the AuditEventInput discriminated union.
 *
 * These tests don't exercise runtime behavior — they fail at *compile* time
 * (and vitest's `expectTypeOf` surfaces the failure as a test error) if:
 *   - the union loses exhaustiveness
 *   - a variant's metadata shape silently widens to allow PII
 *   - a new action is added without updating the `action` literal union
 */

import { describe, expectTypeOf, it } from "vitest";

import type { AuditEvent, AuditEventInput } from "../src/types.js";

// The complete set of `action` literals we currently support. Adding a new
// audit event requires extending this list AND the union in `types.ts` —
// `assertNever` in the switch below will catch any mismatch at compile time.
type AuditAction = AuditEventInput["action"];

describe("AuditEventInput", () => {
  it("union of `action` literals matches the documented events", () => {
    expectTypeOf<AuditAction>().toEqualTypeOf<
      | "agent.deployed"
      | "agent.paused"
      | "agent.resumed"
      | "agent.deleted"
      | "oauth.granted"
      | "oauth.revoked"
      | "agent.invoked"
      | "workspace.installed"
      | "generation.cancelled"
      | "generation.failed"
      | "webhook.signature_failure"
    >();
  });

  it("exhaustive switch over `action` compiles (proves the union is closed)", () => {
    function handle(ev: AuditEventInput): string {
      switch (ev.action) {
        case "agent.deployed":
          return ev.metadata.ntnWorkerName;
        case "agent.paused":
          return ev.metadata.workerName;
        case "agent.resumed":
          return ev.metadata.workerName;
        case "agent.deleted":
          return ev.metadata.workerName ?? ev.metadata.ntnWorkerName ?? "";
        case "oauth.granted":
          return ev.metadata.provider;
        case "oauth.revoked":
          return ev.metadata.provider;
        case "agent.invoked":
          return String(ev.metadata.success);
        case "workspace.installed":
          return ev.metadata.forgePageId;
        case "generation.cancelled":
          return ev.metadata.reason;
        case "generation.failed":
          return "errorCode" in ev.metadata
            ? ev.metadata.errorCode
            : ev.metadata.errorMessage;
        case "webhook.signature_failure":
          return ev.metadata.endpoint;
        default:
          // If this line fails to compile, a new `action` literal was added
          // to the union without a matching switch case. Update both.
          return assertNever(ev);
      }
    }
    // Smoke-call to keep the function from being tree-shaken in the type
    // pass — the test value passes the type checker, which is the assertion.
    const result = handle({
      action: "agent.deployed",
      metadata: {
        ntnWorkerName: "linear-bug-triager",
        pattern: "external_api_call",
        generationId: "gen_abc",
      },
    });
    expectTypeOf(result).toEqualTypeOf<string>();
  });

  it("metadata shape is constrained per variant (no free-form Record)", () => {
    // The variant-narrowed metadata must not be assignable to a free-form
    // shape that would let PII slip through. This will fail to compile if
    // someone widens any variant's metadata to `Record<string, unknown>`.
    expectTypeOf<
      Extract<AuditEventInput, { action: "agent.invoked" }>["metadata"]
    >().toEqualTypeOf<{
      ntnWorkerName: string;
      latencyMs: number;
      success: boolean;
    }>();
  });

  it("AuditEvent intersects base + variant — base fields are required", () => {
    type DeployedEvent = Extract<AuditEvent, { action: "agent.deployed" }>;
    expectTypeOf<DeployedEvent["workspaceId"]>().toEqualTypeOf<string>();
    expectTypeOf<DeployedEvent["userId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<DeployedEvent["resourceType"]>().toEqualTypeOf<string>();
    expectTypeOf<DeployedEvent["resourceId"]>().toEqualTypeOf<string>();
  });
});

function assertNever(x: never): never {
  throw new Error(`Unhandled audit action: ${JSON.stringify(x)}`);
}
