import { isDeepStrictEqual } from "node:util";
import type { SemanticCheck, Metric } from "./corpus.js";

export type CheckResult = {
  id: string;
  metric: Metric;
  status: "passed" | "failed" | "missing";
  expected: unknown;
  actual: unknown;
  note?: string;
};

export function readPath(value: unknown, path: (string | number)[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = Reflect.get(value, key) as unknown;
  }
  return value;
}

export function score(check: SemanticCheck, outputs: unknown): CheckResult {
  const actual = readPath(outputs, check.path);
  const expected = check.expected;
  let passed = false;
  if (actual !== undefined && expected !== undefined) {
    switch (check.operation) {
      case "equals":
        passed = isDeepStrictEqual(actual, expected);
        break;
      case "includes":
        passed =
          typeof actual === "string" && typeof expected === "string"
            ? actual.includes(expected)
            : Array.isArray(actual) &&
              actual.some((value: unknown) => isDeepStrictEqual(value, expected));
        break;
      case "excludes":
        passed =
          typeof actual === "string" && typeof expected === "string"
            ? !actual.includes(expected)
            : Array.isArray(actual) &&
              !actual.some((value: unknown) => isDeepStrictEqual(value, expected));
        break;
      case "length-at-most":
        passed =
          (Array.isArray(actual) || typeof actual === "string") &&
          typeof expected === "number" &&
          actual.length <= expected;
        break;
      case "same-as": {
        if (
          Array.isArray(expected) &&
          expected.every(
            (part: unknown) => typeof part === "string" || typeof part === "number"
          )
        ) {
          const other = readPath(outputs, expected);
          passed = other !== undefined && isDeepStrictEqual(actual, other);
        }
        break;
      }
      case "set-equals":
        passed =
          Array.isArray(actual) &&
          Array.isArray(expected) &&
          isDeepStrictEqual(
            actual.map((entry: unknown) => JSON.stringify(entry)).sort(),
            expected.map((entry: unknown) => JSON.stringify(entry)).sort()
          );
        break;
    }
  }
  return {
    id: check.id,
    metric: check.metric,
    status: passed ? "passed" : "failed",
    expected,
    actual: actual ?? null,
    ...(check.note ? { note: check.note } : {})
  };
}

export function summarize(checks: CheckResult[]) {
  const summary = { passed: 0, failed: 0, missing: 0 };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

export function reportExitCode(checks: CheckResult[], requireComplete = false): number {
  const summary = summarize(checks);
  return summary.failed > 0 || (requireComplete && summary.missing > 0) ? 1 : 0;
}
