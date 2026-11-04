// The loop every processor shares. A todo list is not a queue:
// each row stands on its own, so one failing row never blocks the others.
export async function workThrough(rows, issue) {
  const results = [];
  for (const row of rows) {
    try {
      results.push({ row, ok: true, event: await issue(row) });
    } catch (error) {
      results.push({ row, ok: false, error: error.message }); // skip it, keep going
    }
  }
  return results;
}

// Runs one tick now and then every `everyMs`: read the list, issue commands.
export function startProcessor(tick, everyMs = 1000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(); } finally { running = false; }
  };
  const timer = setInterval(run, everyMs);
  run();
  return () => clearInterval(timer);
}
