/** Provider controls fixed by the versioned LUM-56 experiment protocol. */
export function promptTuningEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    LUMA_EVAL_GOOGLE_BACKEND: "vertex",
    LUMA_EVAL_ANTHROPIC_OUTPUT: "prompt-json",
    // The frozen protocol uses Vertex Express, not a project-scoped route.
    VERTEX_PROJECT_ID: ""
  };
}
