import type { DecisionIntelligenceDependencies } from "./decision-intelligence.js";
const modules = new WeakMap<object, DecisionIntelligenceDependencies>();
/** Private owned collaboration between the MI facade and Follow-up Execution. */
export function bindDecisionModule(
  facade: object,
  dependencies: DecisionIntelligenceDependencies
): void {
  modules.set(facade, dependencies);
}
export function decisionModuleFor(
  facade: object
): DecisionIntelligenceDependencies | undefined {
  return modules.get(facade);
}
