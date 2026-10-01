// Environment for Node children spawned by the scripts/*.test.mjs suites.
//
// Hosts with APM auto-instrumentation set NODE_OPTIONS (preloading a tracer)
// and DD_* variables; the tracer then writes its startup banner to the child's
// stderr, which breaks exact-stderr assertions. Keys are deleted rather than set
// to undefined because child_process stringifies undefined env values. Hosts
// that inject through /etc/ld.so.preload load the tracer regardless of the
// environment, so the tracer is also told to stay off explicitly.

export function cleanNodeEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith('DD_')) delete env[key];
  }
  env.DD_TRACE_ENABLED = 'false';
  env.DD_TRACE_STARTUP_LOGS = 'false';
  return { ...env, ...overrides };
}
