// A c4.db as it is before DELIVER-1 (no control_queue.dialog_ref, no
// migrations/006 tables or indexes, neither ledger row) whose migration 005
// cannot apply: a trigger aborts its ledger insert, so the ALTER rolls back
// with it on every attempt while the database stays writable for everything
// else. unblock() drops the trigger. Callers create the file with the real
// c4-db first (every migration applied), close it, then call this.
import Database from 'better-sqlite3';

export function makePre005Blocked(file) {
  const d = new Database(file);
  try {
    d.exec(`DROP INDEX idx_control_queue_dialog_escape; DROP INDEX idx_control_queue_dialog_notice;
      ALTER TABLE control_queue DROP COLUMN dialog_ref;
      DROP TABLE dialog_watch_state; DROP TABLE c4_process_capabilities;
      DELETE FROM _migrations WHERE name IN ('005-add-control-dialog-ref.sql', '006-add-dialog-watch-state.sql');
      CREATE TRIGGER block_005 BEFORE INSERT ON _migrations WHEN NEW.name = '005-add-control-dialog-ref.sql'
        BEGIN SELECT RAISE(ABORT, 'migration 005 blocked'); END;`);
  } finally { d.close(); }
}

export function unblock(file) {
  const d = new Database(file);
  try { d.exec('DROP TRIGGER block_005'); } finally { d.close(); }
}

export function schemaFacts(file) {
  const d = new Database(file, { readonly: true });
  try {
    return {
      dialogRef: d.prepare('PRAGMA table_info(control_queue)').all().some((c) => c.name === 'dialog_ref'),
      tables: d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dialog_watch_state', 'c4_process_capabilities') ORDER BY name").all().map((r) => r.name),
      capabilities: d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'c4_process_capabilities'").get().n
        ? d.prepare('SELECT process, pid, capabilities FROM c4_process_capabilities ORDER BY process').all() : [],
    };
  } finally { d.close(); }
}
