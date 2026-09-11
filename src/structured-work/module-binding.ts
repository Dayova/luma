import type { StructuredWorkDependencies } from "./structured-work.js";
const modules = new WeakMap<object, StructuredWorkDependencies>();
export function bindStructuredWorkModule(
  facade: object,
  dependencies: StructuredWorkDependencies
): void {
  modules.set(facade, dependencies);
}
export function structuredWorkModuleFor(
  facade: object
): StructuredWorkDependencies | undefined {
  return modules.get(facade);
}
