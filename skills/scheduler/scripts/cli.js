#!/usr/bin/env node
/**
 * Task Management CLI
 * Command-line interface for task creation, monitoring, and control
 */

import { getDb, generateId, now } from './database.js';
import { getNextRun, isValidCron, describeCron, getDefaultTimezone } from './cron-utils.js';
import { parseTime, parseDuration, formatTime, getRelativeTime } from './time-utils.js';
import { loadTimezone } from './tz.js';
import {
  listTasks, insertTask, completeTask, removeTask, pauseTask, resumeTask,
  taskHistory, nextTasks, runningTasks, applyTaskUpdates,
} from './task-ops.js';
import { shouldUseBroker, brokerCall } from '../../comm-bridge/scripts/c4-client.js';

// Isolated instances have no direct scheduler.db access — every op routes
// through the c4-broker 'scheduler' op, which re-runs the same task-ops with
// the scope forced to the socket-derived caller. Admin/scheduler (and
// single-session installs) keep the direct path. The DB handle is lazy so an
// isolated agent never touches the file (it would be EACCES post-harden).
let _db = null;
function dbh() {
  if (!_db) _db = getDb();
  return _db;
}

async function schedOp(action, params, direct) {
  if (shouldUseBroker()) {
    return await brokerCall('scheduler', { action, ...params });
  }
  return direct(dbh());
}

/** Shared error formatting for task-ops {ok:false} results. */
function printTaskError(res, taskId, noun = 'task') {
  if (res.error === 'ambiguous') {
    console.error(`Error: Ambiguous task ID prefix '${taskId}' matches multiple ${noun}s:`);
    (res.matches || []).forEach(id => console.error(`  - ${id}`));
    console.error('Please provide a more specific prefix.');
  } else if (res.error === 'not_found') {
    console.error(`Error: ${noun.charAt(0).toUpperCase() + noun.slice(1)} not found: ${taskId}`);
  } else if (res.error === 'invalid_field') {
    console.error(`Error: Invalid update field: ${res.field}`);
  } else if (res.error === 'no_updates') {
    console.error('Error: No updates provided');
    console.log('Use --help to see available options');
  } else if (res.error === 'retarget_forbidden') {
    console.error('Error: isolated instances cannot change a task\'s target instance');
  } else {
    console.error(`Error: ${res.error}`);
  }
}

const HELP = `
Task CLI - Scheduler V2

Usage: ~/zylos/.claude/skills/scheduler/scripts/cli.js <command> [options]

Commands:
  list [options]          List all tasks
  add <prompt> [options]  Add a new task
  update <task-id> [options]  Update an existing task
  remove <task-id>        Remove a task
  done <task-id>          Mark task as completed
  pause <task-id>         Pause a task
  resume <task-id>        Resume a paused task
  history [task-id]       Show execution history
  next                    Show upcoming tasks
  running                 Show currently running tasks

List Options:
  --json                  Machine-readable output: JSON array of full task rows
                          (untruncated id, type, status, last_error, reply_channel,
                          reply_endpoint, next_run_at, ...)
  --reply-channel "<ch>"  Only tasks with this reply channel (works with or without --json)

Add Options:
  --in "<duration>"       One-time: run in X time (e.g., "30 minutes")
  --at "<time>"           One-time: run at specific time (e.g., "tomorrow 9am")
  --cron "<expression>"   Recurring: cron expression (e.g., "0 8 * * *")
  --every "<interval>"    Interval: repeat every X time (e.g., "2 hours")
  --priority <1-3>        Priority level (1=urgent, 2=high, 3=normal, default=3)
  --name "<name>"         Task name (optional)
  --block-queue-until-idle
                          Wait for sustained idle, then block subsequent dispatch until execution settles
                          Legacy alias: --require-idle
  --reply-channel "<source>"      Reply channel (e.g., "telegram", "lark")
  --reply-endpoint "<endpoint>"  Reply endpoint (e.g., "8101553026", "chat_id topic_id")
  --miss-threshold <seconds>  Skip if overdue by more than this (default=300)
  --target-instance <id>  Target a specific instance (multi-session)

Update Options (same as Add, plus):
  --prompt "<prompt>"     Update task content
  --no-block-queue-until-idle
                          Disable block-queue-until-idle behavior
                          Legacy alias: --no-require-idle
  --clear-reply           Clear reply configuration
  --target-instance <id>  Set target instance (empty string clears it)

Examples:
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Say hello" --in "30 minutes"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Health check" --cron "0 8 * * *"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Check updates" --every "1 hour"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --priority 1
  ~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --block-queue-until-idle
  ~/zylos/.claude/skills/scheduler/scripts/cli.js done task-abc123
`;

function parseArgs(args) {
  const result = { command: null, args: [], options: {} };

  if (args.length === 0) {
    return result;
  }

  result.command = args[0];

  // Boolean flags (no value required)
  const booleanFlags = new Set([
    'block-queue-until-idle',
    'no-block-queue-until-idle',
    'require-idle',
    'no-require-idle',
    'clear-reply',
    'json'
  ]);

  let i = 1;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);

      // Check if this is a boolean flag
      if (booleanFlags.has(key)) {
        result.options[key] = true;
        i++;
      } else {
        // Regular flag with value
        const value = args[i + 1];
        result.options[key] = value;
        i += 2;
      }
    } else {
      result.args.push(arg);
      i++;
    }
  }

  return result;
}

// ===== Commands =====

async function cmdList(options = {}) {
  // Show all active tasks including failed ones (so user can see what timed out)
  const replyChannel = options['reply-channel'] || null;
  const tasks = await schedOp(
    'list',
    { replyChannel },
    (db) => listTasks(db, { replyChannel }),
  );

  if (options.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  if (tasks.length === 0) {
    console.log('No tasks scheduled.');
    return;
  }

  console.log(`\n  Tasks (TZ: ${getDefaultTimezone()}):\n`);
  console.log('  ID              | Pri | Type      | Status  | Next Run           | Name');
  console.log('  ' + '-'.repeat(85));

  for (const task of tasks) {
    const id = task.id.substring(0, 14).padEnd(14);
    const pri = task.priority.toString().padEnd(3);
    const type = task.type.padEnd(9);
    const status = task.status.padEnd(7);
    const nextRun = task.status === 'completed' ? 'done'.padEnd(18) :
                    formatTime(task.next_run_at).padEnd(18);
    const name = task.name || task.prompt.substring(0, 30);
    const instanceTag = task.target_instance ? ` [->${ task.target_instance}]` : '';

    console.log(`  ${id} | ${pri} | ${type} | ${status} | ${nextRun} | ${name}${instanceTag}`);

    // Show prompt (truncated to 80 chars)
    const promptPreview = task.prompt.substring(0, 80).replace(/\n/g, ' ');
    console.log(`                    └─ ${promptPreview}${task.prompt.length > 80 ? '...' : ''}`);
  }
  console.log();
}

async function cmdAdd(args, options) {
  const prompt = args.join(' ');

  if (!prompt) {
    console.error('Error: Prompt is required');
    console.log('Usage: cli.js add "<prompt>" [options]');
    return;
  }

  let type, nextRunAt, cronExpression, intervalSeconds;

  // Determine task type from options
  if (options.in) {
    type = 'one-time';
    const seconds = parseDuration(options.in);
    if (!seconds) {
      console.error(`Error: Invalid duration "${options.in}"`);
      return;
    }
    nextRunAt = now() + seconds;
  } else if (options.at) {
    type = 'one-time';
    nextRunAt = parseTime(options.at);
    if (!nextRunAt) {
      console.error(`Error: Could not parse time "${options.at}"`);
      return;
    }
  } else if (options.cron) {
    type = 'recurring';
    cronExpression = options.cron;
    if (!isValidCron(cronExpression)) {
      console.error(`Error: Invalid cron expression "${cronExpression}"`);
      return;
    }
    nextRunAt = getNextRun(cronExpression);
  } else if (options.every) {
    type = 'interval';
    intervalSeconds = parseDuration(options.every);
    if (!intervalSeconds) {
      console.error(`Error: Invalid interval "${options.every}"`);
      return;
    }
    nextRunAt = now() + intervalSeconds;
  } else {
    console.error('Error: Must specify timing (--in, --at, --cron, or --every)');
    console.log(HELP);
    return;
  }

  const priority = options.priority ? parseInt(options.priority, 10) : 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    console.error('Error: Priority must be 1-3 (1=urgent, 2=high, 3=normal)');
    return;
  }

  // Parse block-queue-until-idle flag (legacy alias: require-idle)
  const requireIdle = (options['block-queue-until-idle'] || options['require-idle']) ? 1 : 0;

  // Parse reply-channel and reply-endpoint
  const replyChannel = options['reply-channel'] || null;
  const replyEndpoint = options['reply-endpoint'] || null;

  // Parse miss-threshold
  const missThreshold = options['miss-threshold']
    ? parseInt(options['miss-threshold'], 10)
    : 300;  // Default 5 minutes
  if (!Number.isInteger(missThreshold) || missThreshold < 0) {
    console.error('Error: miss-threshold must be a positive integer');
    return;
  }

  // Parse target-instance (multi-session)
  const targetInstance = options['target-instance'] || null;

  const currentTime = now();
  const spec = {
    id: generateId(),
    name: options.name || prompt.substring(0, 40),  // Default name to truncated prompt
    prompt,
    type,
    cron_expression: cronExpression || null,
    interval_seconds: intervalSeconds || null,
    next_run_at: nextRunAt,
    priority,
    require_idle: requireIdle,
    miss_threshold: missThreshold,
    reply_channel: replyChannel,
    reply_endpoint: replyEndpoint,
    created_at: currentTime,
    updated_at: currentTime,
    timezone: getDefaultTimezone(),
    target_instance: targetInstance,
  };

  // Broker path: id/timestamps/target_instance are regenerated server-side
  // (target is always forced to this instance — agents cannot schedule work
  // onto another instance).
  const res = await schedOp('add', { spec }, (db) => insertTask(db, spec));
  if (!res.ok) return printTaskError(res, spec.id);
  const taskId = res.task.id;

  console.log(`\nTask created: ${taskId}`);
  console.log(`  Type: ${type}`);
  console.log(`  Priority: ${priority}`);
  console.log(`  Next run: ${formatTime(nextRunAt)} (${getRelativeTime(nextRunAt)})`);

  if (cronExpression) {
    console.log(`  Schedule: ${describeCron(cronExpression)}`);
  }
  console.log();
}

async function cmdRemove(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  const res = await schedOp('remove', { prefix: taskId }, (db) => removeTask(db, taskId));
  if (!res.ok) return printTaskError(res, taskId);
  console.log(`Removed task: ${res.task.id}`);
}

async function cmdDone(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  const res = await schedOp('done', { prefix: taskId }, (db) => completeTask(db, taskId));
  if (!res.ok) return printTaskError(res, taskId);

  console.log(`Completed task: ${res.task.id}`);

  // If recurring/interval, scheduler will handle next run
  if (res.task.type !== 'one-time') {
    console.log('(Scheduler will calculate next run time)');
  }
}

async function cmdPause(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  const res = await schedOp('pause', { prefix: taskId }, (db) => pauseTask(db, taskId));
  if (!res.ok) return printTaskError(res, taskId, 'pending task');
  console.log(`Paused task: ${res.task.id}`);
}

async function cmdResume(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  const res = await schedOp('resume', { prefix: taskId }, (db) => resumeTask(db, taskId));
  if (!res.ok) return printTaskError(res, taskId, 'paused task');
  console.log(`Resumed task: ${res.task.id}`);
}

async function cmdHistory(taskId) {
  const { entries: history, prefixMatches } = await schedOp(
    'history', { prefix: taskId || null },
    (db) => taskHistory(db, { prefix: taskId || null })
  );

  if (taskId && prefixMatches.length > 1) {
    console.log(`\n  ⚠ Warning: Prefix '${taskId}' matches ${prefixMatches.length} tasks:`);
    prefixMatches.forEach(id => console.log(`    - ${id}`));
    console.log();
  }

  if (history.length === 0) {
    console.log('No execution history.');
    return;
  }

  console.log('\n  Execution History:\n');
  console.log('  Time                | Task ID        | Status  | Duration');
  console.log('  ' + '-'.repeat(65));

  for (const entry of history) {
    const time = formatTime(entry.executed_at).padEnd(18);
    const id = entry.task_id.substring(0, 14).padEnd(14);
    const status = entry.status.padEnd(7);
    const duration = entry.duration_ms ? `${Math.round(entry.duration_ms / 1000)}s` : '-';

    console.log(`  ${time} | ${id} | ${status} | ${duration}`);
  }
  console.log();
}

async function cmdNext() {
  const tasks = await schedOp('next', {}, (db) => nextTasks(db));

  if (tasks.length === 0) {
    console.log('No pending tasks.');
    return;
  }

  console.log('\n  Upcoming Tasks:\n');

  for (const task of tasks) {
    console.log(`  ${getRelativeTime(task.next_run_at).padEnd(12)} | P${task.priority} | ${task.name || task.prompt.substring(0, 40)}`);
  }
  console.log();
}

async function cmdRunning() {
  const tasks = await schedOp('running', {}, (db) => runningTasks(db));

  if (tasks.length === 0) {
    console.log('\n  No running tasks. Safe to compact.\n');
    return;
  }

  console.log('\n  ⚠️  Running Tasks (complete these before compacting!):\n');
  console.log('  ID              | Started            | Name');
  console.log('  ' + '-'.repeat(60));

  for (const task of tasks) {
    const id = task.id.substring(0, 14).padEnd(14);
    const started = formatTime(task.updated_at).padEnd(18);
    const name = task.name || task.prompt.substring(0, 30);

    console.log(`  ${id} | ${started} | ${name}`);
  }

  console.log('\n  Run "cli.js done <task-id>" to complete them before /compact\n');
}

async function cmdUpdate(taskId, options) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  const updates = {};
  const updatedFields = [];

  // Update name
  if (options.name) {
    updates.name = options.name;
    updatedFields.push('name');
  }

  // Update prompt
  if (options.prompt) {
    updates.prompt = options.prompt;
    updatedFields.push('prompt');
  }

  // Update priority
  if (options.priority) {
    const priority = parseInt(options.priority, 10);
    if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
      console.error('Error: Priority must be 1-3');
      return;
    }
    updates.priority = priority;
    updatedFields.push('priority');
  }

  // Update require_idle (external flag renamed to block-queue-until-idle)
  if (options['block-queue-until-idle'] || options['require-idle']) {
    updates.require_idle = 1;
    updatedFields.push('require_idle');
  } else if (options['no-block-queue-until-idle'] || options['no-require-idle']) {
    updates.require_idle = 0;
    updatedFields.push('require_idle');
  }

  // Update reply configuration
  if (options['clear-reply']) {
    updates.reply_channel = null;
    updates.reply_endpoint = null;
    updatedFields.push('reply_channel', 'reply_endpoint');
  } else {
    if (options['reply-channel']) {
      updates.reply_channel = options['reply-channel'];
      updatedFields.push('reply_channel');
    }
    if (options['reply-endpoint']) {
      updates.reply_endpoint = options['reply-endpoint'];
      updatedFields.push('reply_endpoint');
    }
  }

  // Update target_instance (empty string clears it)
  if (options['target-instance'] !== undefined) {
    const val = options['target-instance'];
    updates.target_instance = (val === '' || val === true) ? null : val;
    updatedFields.push('target_instance');
  }

  // Update miss_threshold
  if (options['miss-threshold']) {
    const threshold = parseInt(options['miss-threshold'], 10);
    if (!Number.isInteger(threshold) || threshold < 0) {
      console.error('Error: miss-threshold must be a positive integer');
      return;
    }
    updates.miss_threshold = threshold;
    updatedFields.push('miss_threshold');
  }

  // Update schedule (type and next_run_at)
  let scheduleUpdated = false;
  if (options.in) {
    const seconds = parseDuration(options.in);
    if (!seconds) {
      console.error(`Error: Invalid duration "${options.in}"`);
      return;
    }
    updates.type = 'one-time';
    updates.cron_expression = null;
    updates.interval_seconds = null;
    updates.next_run_at = now() + seconds;
    scheduleUpdated = true;
  } else if (options.at) {
    const nextRunAt = parseTime(options.at);
    if (!nextRunAt) {
      console.error(`Error: Could not parse time "${options.at}"`);
      return;
    }
    updates.type = 'one-time';
    updates.cron_expression = null;
    updates.interval_seconds = null;
    updates.next_run_at = nextRunAt;
    scheduleUpdated = true;
  } else if (options.cron) {
    const cronExpression = options.cron;
    if (!isValidCron(cronExpression)) {
      console.error(`Error: Invalid cron expression "${cronExpression}"`);
      return;
    }
    updates.type = 'recurring';
    updates.cron_expression = cronExpression;
    updates.interval_seconds = null;
    updates.next_run_at = getNextRun(cronExpression);
    scheduleUpdated = true;
  } else if (options.every) {
    const intervalSeconds = parseDuration(options.every);
    if (!intervalSeconds) {
      console.error(`Error: Invalid interval "${options.every}"`);
      return;
    }
    updates.type = 'interval';
    updates.cron_expression = null;
    updates.interval_seconds = intervalSeconds;
    updates.next_run_at = now() + intervalSeconds;
    scheduleUpdated = true;
  }

  if (scheduleUpdated) {
    updates.timezone = getDefaultTimezone();
    updatedFields.push('type', 'schedule');
  }

  // Column whitelist + empty-updates validation live in applyTaskUpdates;
  // the broker additionally rejects target_instance changes (retargeting a
  // task would be a cross-instance message primitive).
  const res = await schedOp(
    'update', { prefix: taskId, updates },
    (db) => applyTaskUpdates(db, taskId, updates)
  );
  if (!res.ok) return printTaskError(res, taskId);

  console.log(`\nTask updated: ${res.task.id}`);
  console.log(`  Updated fields: ${updatedFields.join(', ')}`);

  if (scheduleUpdated) {
    console.log(`  Type: ${updates.type}`);
    console.log(`  Next run: ${formatTime(updates.next_run_at)} (${getRelativeTime(updates.next_run_at)})`);
  }
  console.log();
}

// ===== Main =====

async function main() {
  try {
    process.env.TZ = loadTimezone();
  } catch (error) {
    const code = error.code || 'UNKNOWN_TZ_ERROR';
    console.error(`Error [${code}]: ${error.message}`);
    process.exit(1);
  }

  const { command, args, options } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'list':
      await cmdList(options);
      break;
    case 'add':
      await cmdAdd(args, options);
      break;
    case 'update':
      await cmdUpdate(args[0], options);
      break;
    case 'remove':
    case 'rm':
    case 'delete':
      await cmdRemove(args[0]);
      break;
    case 'done':
    case 'complete':
      await cmdDone(args[0]);
      break;
    case 'pause':
      await cmdPause(args[0]);
      break;
    case 'resume':
      await cmdResume(args[0]);
      break;
    case 'history':
      await cmdHistory(args[0]);
      break;
    case 'next':
      await cmdNext();
      break;
    case 'running':
      await cmdRunning();
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
      }
      console.log(HELP);
  }
}

main().catch((err) => {
  // Broker/transport failures land here — fail loud, never fall back to a
  // direct DB path an isolated agent isn't allowed to touch.
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
