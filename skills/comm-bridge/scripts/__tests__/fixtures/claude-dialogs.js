// Pane captures shaped like Claude Code CLI 2.1.322 at 80 columns.
//
// The dialog layout follows the CLI's own component tree (read from the
// shipped binary, not from a live limit): Pane = blank row + full-width `─`
// divider + content padded two columns; Dialog = bold title, body, a Select
// with hideIndexes whose focused option is `❯ label` and the others are
// aligned two columns further right, then the dim input guide. The composer is
// a `─` rule, a column-0 `❯` prompt and a closing rule, followed by the status
// line (layout confirmed against a live devbox pane, text masked).

export const RULE = '─'.repeat(80);

const composer = (text = '') => [RULE, `❯ ${text}`, RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];

const transcript = [
  '❯ Heartbeat check. [phase=primary]',
  '',
  '⏺ Acknowledged.',
  '',
];

const fableLimitDialog = [
  '',
  RULE,
  "  You've reached your Fable limit",
  '',
  "  You've used your included Fable usage for this week. Continuing on Claude",
  '  Fable 5.2 uses usage credits, purchased separately from your plan.',
  '',
  "  You don't have usage credits yet.",
  '',
  '  ❯ Switch to Opus 5.5 and continue',
  '    Request usage credits from your admin',
  '',
  '  Enter to select · ↑/↓ to navigate · Esc to cancel',
];

export const cursorLine = (x, y, pane = '%2') => `__ZYLOS_CURSOR__ ${x} ${y} $1 1000 ${pane} 123`;

// Live mid-session limit dialog; the composer is hidden while it is open.
export const FABLE_LIMIT_LIVE = [...transcript, ...fableLimitDialog].join('\n');

// The same dialog drawn directly above a still-visible composer.
export const FABLE_LIMIT_ABOVE_COMPOSER = [...transcript, ...fableLimitDialog, '', ...composer()].join('\n');

// Pre-send variant: the model itself runs on usage credits.
export const CREDITS_OFFER_LIVE = [
  ...transcript,
  '',
  RULE,
  '  Claude Fable 5.2 now uses usage credits',
  '',
  '  Claude Fable 5.2 runs on usage credits, purchased separately from your',
  '  plan.',
  '',
  "  You don't have usage credits yet.",
  '',
  '  ❯ No, keep my current model',
  '    Request usage credits from your admin',
  '',
  '  Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

// Loading state of the same dialog: no select list yet, only the guide.
export const CREDITS_CHECKING_LIVE = [
  ...transcript,
  '',
  RULE,
  "  You've reached your Fable limit",
  '',
  '  ⠋ Checking usage credits…',
  '',
  '  Esc to cancel',
].join('\n');

// The assistant quotes the dialog verbatim; the live composer is below it.
export const QUOTED_LIMIT_TEXT = [
  '❯ What does the Fable limit dialog look like?',
  '',
  '⏺ It looks like this:',
  '',
  "  You've reached your Fable limit",
  "  You've used your included Fable usage for this week. Continuing on Claude",
  '  Fable 5.2 uses usage credits, purchased separately from your plan.',
  '  ❯ Switch to Opus 5.5 and continue',
  '    Request usage credits from your admin',
  '  Enter to select · ↑/↓ to navigate · Esc to cancel',
  '',
  ...composer(),
].join('\n');

// An old dialog still visible higher up (it was answered), then newer
// conversation output and the live composer.
export const SCROLLED_PAST_DIALOG = [
  ...fableLimitDialog,
  '',
  '⏺ Switched to Opus 5.5.',
  '',
  '❯ next message',
  '',
  '⏺ Done.',
  '',
  ...composer(),
].join('\n');

// A modal whose wording is not in the list (a future CLI dialog).
export const UNKNOWN_DIALOG_LIVE = [
  ...transcript,
  '',
  RULE,
  '  Something new needs your answer',
  '',
  '  ❯ Option one',
  '    Option two',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');

// A tool permission prompt (the auto-approve [KEYSTROKE]Enter target).
export const PERMISSION_PROMPT_LIVE = [
  ...transcript,
  '',
  RULE,
  '  Bash command',
  '',
  '    ls -la',
  '',
  '  Do you want to proceed?',
  '  ❯ 1. Yes',
  "    2. Yes, and don't ask again for ls commands",
  '    3. No, and tell Claude what to do differently (esc)',
  '',
  '  Esc to cancel',
].join('\n');

// Idle session with an empty composer.
export const PLAIN_COMPOSER = [...transcript, ...composer()].join('\n');
export const PLAIN_COMPOSER_PROMPT_Y = transcript.length + 1;

// Composer holding the pasted (not yet submitted) message.
export const COMPOSER_WITH_TEXT = [...transcript, ...composer('hello from feishu')].join('\n');
