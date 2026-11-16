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
  taskHistory, nextTasks, runningTasks, applyTaskUpdates, getTask,
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

const WRITE_ACTIONS = new Set(['add', 'update', 'done', 'remove', 'pause', 'resume']);

async function schedOp(action, params, direct) {
  if (shouldUseBroker()) {
    return await brokerCall('scheduler', { action, ...params });
  }
  const db = dbh();
  if (!WRITE_ACTIONS.has(action)) return direct(db);
  try { return direct(db); }
  catch (error) {
    error.code = 'DB_WRITE_FAILED';
    throw error;
  }
}

// --json on write and history commands: one-line {ok,data} / {ok:false,error}
// envelope; errors exit 1. Text output and exit codes stay as before.
let jsonOutput = false;
const has = (options, key) => Object.hasOwn(options, key);

function success(data) {
  if (!jsonOutput) return false;
  console.log(JSON.stringify({ ok: true, data }));
  return true;
}

function fail(code, message, details = {}, textLines = [], textExitCode = 0) {
  if (jsonOutput) {
    console.log(JSON.stringify({ ok: false, error: { code, message, ...details } }));
    process.exitCode = 1;
  } else {
    console.error(`Error: ${message}`);
    for (const line of textLines) console.error(line);
    process.exitCode = textExitCode;
  }
}

function replyPair(channel, endpoint) {
  return typeof channel === 'string' && channel.trim().length > 0
    && typeof endpoint === 'string' && endpoint.trim().length > 0;
}

/**
 * Report a task-ops {ok:false} result. `status` is the status filter of the
 * lookup (pause: pending, resume: paused), for the "Pending task" wording.
 */
function failTask(res, taskId, status = null) {
  const qualifier = status === 'pending' ? 'Pending ' : status === 'paused' ? 'Paused ' : '';
  switch (res.error) {
    case 'ambiguous': {
      const matches = res.matches || [];
      return fail('TASK_AMBIGUOUS', `Ambiguous task ID prefix '${taskId}' matches multiple${status ? ` ${status}` : ''} tasks:`,
        { matches }, [...matches.map(id => `  - ${id}`), 'Please provide a more specific prefix.']);
    }
    case 'not_found':
      if (status && res.status) return fail('TASK_WRONG_STATUS', `${qualifier}task not found: ${taskId}`, { status: res.status });
      return fail('TASK_NOT_FOUND', `${status ? qualifier + 'task' : 'Task'} not found: ${taskId}`);
    case 'invalid_field':
      return fail('INVALID_ARGS', `Invalid update field: ${res.field}`);
    case 'no_updates':
      fail('NO_UPDATES', 'No updates provided');
      if (!jsonOutput) console.log('Use --help to see available options');
      return;
    case 'retarget_forbidden':
      return fail('RETARGET_FORBIDDEN', 'isolated instances cannot change a task\'s target instance');
    case 'reschedule_not_future':
      return fail('RESCHEDULE_NOT_FUTURE', 'A failed task must be rescheduled to a future time', {}, [], 1);
    default:
      return fail('INTERNAL_ERROR', String(res.error));
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

Update timing:
  --in / --at             Change only the next run of recurring/interval tasks;
                          preserve cadence and saved timezone
  --cron / --every        Replace the schedule and use the current timezone

Write and History Options:
  --json                  Single-line success/error envelope; errors exit 1
  --limit <1-1000>        History maximum rows (default=20)

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
    fail('INVALID_ARGS', 'Prompt is required');
    if (!jsonOutput) console.log('Usage: cli.js add "<prompt>" [options]');
    return;
  }

  let type, nextRunAt, cronExpression, intervalSeconds;

  // Determine task type from options
  if (options.in) {
    type = 'one-time';
    const seconds = parseDuration(options.in);
    if (!seconds) {
      fail('INVALID_ARGS', `Invalid duration "${options.in}"`);
      return;
    }
    nextRunAt = now() + seconds;
  } else if (options.at) {
    type = 'one-time';
    nextRunAt = parseTime(options.at);
    if (!nextRunAt) {
      fail('INVALID_ARGS', `Could not parse time "${options.at}"`);
      return;
    }
  } else if (options.cron) {
    type = 'recurring';
    cronExpression = options.cron;
    if (!isValidCron(cronExpression)) {
      fail('INVALID_ARGS', `Invalid cron expression "${cronExpression}"`);
      return;
    }
    nextRunAt = getNextRun(cronExpression);
  } else if (options.every) {
    type = 'interval';
    intervalSeconds = parseDuration(options.every);
    if (!intervalSeconds) {
      fail('INVALID_ARGS', `Invalid interval "${options.every}"`);
      return;
    }
    nextRunAt = now() + intervalSeconds;
  } else {
    fail('INVALID_ARGS', 'Must specify timing (--in, --at, --cron, or --every)');
    if (!jsonOutput) console.log(HELP);
    return;
  }

  const priority = options.priority ? parseInt(options.priority, 10) : 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    fail('INVALID_ARGS', 'Priority must be 1-3 (1=urgent, 2=high, 3=normal)');
    return;
  }

  // Parse block-queue-until-idle flag (legacy alias: require-idle)
  const requireIdle = (options['block-queue-until-idle'] || options['require-idle']) ? 1 : 0;

  // Parse reply-channel and reply-endpoint
  const replyChannel = options['reply-channel'] || null;
  const replyEndpoint = options['reply-endpoint'] || null;
  if ((has(options, 'reply-channel') || has(options, 'reply-endpoint')) && !replyPair(replyChannel, replyEndpoint)) {
    fail('INVALID_ARGS', '--reply-channel and --reply-endpoint must both be nonempty', {}, [], 1);
    return;
  }

  // Parse miss-threshold
  const missThreshold = options['miss-threshold']
    ? parseInt(options['miss-threshold'], 10)
    : 300;  // Default 5 minutes
  if (!Number.isInteger(missThreshold) || missThreshold < 0) {
    fail('INVALID_ARGS', 'miss-threshold must be a positive integer');
    return;
  }

  // Parse target-instance (multi-session)
  const targetInstance = options['target-instance'] || process.env.ZYLOS_INSTANCE_ID || null;

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
  if (!res.ok) return failTask(res, spec.id);
  const taskId = res.task.id;

  if (success({ task: res.task })) return;
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
    fail('INVALID_ARGS', 'Task ID is required');
    return;
  }

  const res = await schedOp('remove', { prefix: taskId }, (db) => removeTask(db, taskId));
  if (!res.ok) return failTask(res, taskId);
  if (success({ id: res.task.id })) return;
  console.log(`Removed task: ${res.task.id}`);
}

async function cmdDone(taskId) {
  if (!taskId) {
    fail('INVALID_ARGS', 'Task ID is required');
    return;
  }

  const res = await schedOp('done', { prefix: taskId }, (db) => completeTask(db, taskId));
  if (!res.ok) return failTask(res, taskId);
  if (success({ task: res.task })) return;

  console.log(`Completed task: ${res.task.id}`);

  // If recurring/interval, scheduler will handle next run
  if (res.task.type !== 'one-time') {
    console.log('(Scheduler will calculate next run time)');
  }
}

async function cmdPause(taskId) {
  if (!taskId) {
    fail('INVALID_ARGS', 'Task ID is required');
    return;
  }

  const res = await schedOp('pause', { prefix: taskId }, (db) => pauseTask(db, taskId));
  if (!res.ok) return failTask(res, taskId, 'pending');
  if (success({ task: res.task })) return;
  console.log(`Paused task: ${res.task.id}`);
}

async function cmdResume(taskId) {
  if (!taskId) {
    fail('INVALID_ARGS', 'Task ID is required');
    return;
  }

  const res = await schedOp('resume', { prefix: taskId }, (db) => resumeTask(db, taskId));
  if (!res.ok) return failTask(res, taskId, 'paused');
  if (success({ task: res.task })) return;
  console.log(`Resumed task: ${res.task.id}`);
}

async function cmdHistory(taskId, options = {}) {
  const rawLimit = has(options, 'limit') ? options.limit : '20';
  const limit = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    fail('INVALID_ARGS', '--limit must be an integer between 1 and 1000');
    process.exitCode = 1;
    return;
  }

  const { entries: history, prefixMatches } = await schedOp(
    'history', { prefix: taskId || null, limit },
    (db) => taskHistory(db, { prefix: taskId || null, limit })
  );
  const ambiguousPrefix = taskId && prefixMatches.length > 1 ? prefixMatches : [];

  if (success({ rows: history.map(({ prompt, ...entry }) => entry), ambiguousPrefix })) return;

  if (ambiguousPrefix.length) {
    console.log(`\n  ⚠ Warning: Prefix '${taskId}' matches ${ambiguousPrefix.length} tasks:`);
    ambiguousPrefix.forEach(id => console.log(`    - ${id}`));
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
    fail('INVALID_ARGS', 'Task ID is required');
    return;
  }

  // The update depends on the task's current type, status and reply address
  // (next-run override, failed-task reschedule, merged reply validation).
  const found = await schedOp('get', { prefix: taskId }, (db) => getTask(db, taskId));
  if (!found.ok) return failTask(found, taskId);
  const task = found.task;

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
      fail('INVALID_ARGS', 'Priority must be 1-3');
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

  // Validate the merged reply address before writing any task fields.
  if (options['clear-reply']) {
    updates.reply_channel = null;
    updates.reply_endpoint = null;
    updatedFields.push('reply_channel', 'reply_endpoint');
  } else if (has(options, 'reply-channel') || has(options, 'reply-endpoint')) {
    const channel = has(options, 'reply-channel') ? options['reply-channel'] : task.reply_channel;
    const endpoint = has(options, 'reply-endpoint') ? options['reply-endpoint'] : task.reply_endpoint;
    if (!replyPair(channel, endpoint)) {
      fail('INVALID_ARGS', '--reply-channel and --reply-endpoint must both be nonempty', {}, [], 1);
      return;
    }
    if (has(options, 'reply-channel')) { updates.reply_channel = channel; updatedFields.push('reply_channel'); }
    if (has(options, 'reply-endpoint')) { updates.reply_endpoint = endpoint; updatedFields.push('reply_endpoint'); }
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
      fail('INVALID_ARGS', 'miss-threshold must be a positive integer');
      return;
    }
    updates.miss_threshold = threshold;
    updatedFields.push('miss_threshold');
  }

  // Update schedule (type and next_run_at)
  let scheduleUpdated = false;
  const nextRunOnly = ['recurring', 'interval'].includes(task.type) && Boolean(options.in || options.at);
  if (options.in) {
    const seconds = parseDuration(options.in);
    if (!seconds) {
      fail('INVALID_ARGS', `Invalid duration "${options.in}"`);
      return;
    }
    if (!nextRunOnly) {
      updates.type = 'one-time';
      updates.cron_expression = null;
      updates.interval_seconds = null;
    }
    updates.next_run_at = now() + seconds;
    scheduleUpdated = true;
  } else if (options.at) {
    const nextRunAt = parseTime(options.at);
    if (!nextRunAt) {
      fail('INVALID_ARGS', `Could not parse time "${options.at}"`);
      return;
    }
    if (!nextRunOnly) {
      updates.type = 'one-time';
      updates.cron_expression = null;
      updates.interval_seconds = null;
    }
    updates.next_run_at = nextRunAt;
    scheduleUpdated = true;
  } else if (options.cron) {
    const cronExpression = options.cron;
    if (!isValidCron(cronExpression)) {
      fail('INVALID_ARGS', `Invalid cron expression "${cronExpression}"`);
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
      fail('INVALID_ARGS', `Invalid interval "${options.every}"`);
      return;
    }
    updates.type = 'interval';
    updates.cron_expression = null;
    updates.interval_seconds = intervalSeconds;
    updates.next_run_at = now() + intervalSeconds;
    scheduleUpdated = true;
  }

  // A rescheduled failed one-time task becomes pending again (task-ops sets
  // the status and clears its failure details; status is never an update field).
  let reenableFailed = false;
  if (scheduleUpdated) {
    if (!nextRunOnly) updates.timezone = getDefaultTimezone();
    updatedFields.push(...(nextRunOnly ? ['next_run_at'] : ['type', 'schedule']));
    if (task.type === 'one-time' && task.status === 'failed') {
      if (updates.next_run_at <= now()) {
        fail('RESCHEDULE_NOT_FUTURE', 'A failed task must be rescheduled to a future time', {}, [], 1);
        return;
      }
      reenableFailed = true;
    }
  }

  if (Object.keys(updates).length === 0) {
    fail('NO_UPDATES', 'No updates provided');
    if (!jsonOutput) console.log('Use --help to see available options');
    return;
  }

  // Column whitelist + empty-updates validation live in applyTaskUpdates;
  // the broker additionally rejects target_instance changes (retargeting a
  // task would be a cross-instance message primitive).
  const res = await schedOp(
    'update', { prefix: task.id, updates, reenableFailed },
    (db) => applyTaskUpdates(db, task.id, updates, { reenableFailed })
  );
  if (!res.ok) return failTask(res, taskId);
  if (success({ task: res.task, ...(nextRunOnly ? { nextRunOnly: true } : {}) })) return;

  console.log(`\nTask updated: ${res.task.id}`);
  console.log(`  Updated fields: ${updatedFields.join(', ')}`);

  if (scheduleUpdated) {
    console.log(`  Type: ${updates.type || task.type}`);
    if (nextRunOnly) console.log('  Only the next run changed; recurring schedule and timezone unchanged');
    console.log(`  Next run: ${formatTime(updates.next_run_at)} (${getRelativeTime(updates.next_run_at)})`);
  }
  console.log();
}

// ===== Main =====

async function main() {
  const { command, args, options } = parseArgs(process.argv.slice(2));
  const jsonCommands = ['add', 'update', 'done', 'complete', 'remove', 'rm', 'delete', 'pause', 'resume', 'history'];
  jsonOutput = jsonCommands.includes(command) && process.argv.slice(2).includes('--json');

  try {
    process.env.TZ = loadTimezone();
  } catch (error) {
    const code = error.code || 'UNKNOWN_TZ_ERROR';
    if (jsonOutput) fail(code, error.message);
    else console.error(`Error [${code}]: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (jsonOutput) {
    for (const [key, value] of Object.entries(options)) {
      // `--target-instance ""` clears the target (multi-session).
      if (key === 'target-instance' && value === '') continue;
      if (value === undefined || value === '') {
        fail('INVALID_ARGS', `Invalid or missing option: --${key}`);
        return;
      }
    }
  }

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
      await cmdHistory(args[0], options);
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
      if (jsonOutput) fail('INVALID_ARGS', command ? `Unknown command: ${command}` : 'Command is required');
      else {
        if (command) console.error(`Unknown command: ${command}`);
        console.log(HELP);
      }
  }
}

main().catch((err) => {
  // Broker/transport failures land here — fail loud, never fall back to a
  // direct DB path an isolated agent isn't allowed to touch.
  if (jsonOutput) {
    fail(err.code === 'DB_WRITE_FAILED' ? err.code : 'INTERNAL_ERROR', err.message);
    return;
  }
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
