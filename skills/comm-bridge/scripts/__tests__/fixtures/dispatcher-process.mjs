// One dispatcher process for the restart tests: the real single-session tick
// (runDispatcherTick) against the C4 database in $ZYLOS_DIR and the fake tmux
// on PATH. `restart` first runs the dispatcher's own startup reconcile, as
// main() does. Usage: node dispatcher-process.mjs <first|restart> <ticks>
import fs from 'node:fs';
import path from 'node:path';

process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
const [mode, ticks] = process.argv.slice(2);
const dispatcher = await import('../../c4-dispatcher.js');
const db = await import('../../c4-db.js');
const status = path.join(process.env.ZYLOS_DIR, 'activity-monitor', 'agent-status.json');
// What main() does at start (a dispatcher without startupReconcile, such as
// 2189c729, only released the rows left running).
if (mode === 'restart') (dispatcher.startupReconcile || db.resetOrphanedRunning)();
const { runDispatcherTick } = dispatcher;
for (let i = 0; i < Number(ticks); i++) {
  fs.writeFileSync(status, JSON.stringify({ state: 'idle', health: 'ok', idle_seconds: 30 }));
  await runDispatcherTick();
}
db.close();
