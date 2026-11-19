// Composer frames captured from Claude Code CLI 2.1.327 (the version on the
// host on 2026-11-19) and 2.1.328, identical apart from the banner, at 80x24
// in a private tmux server (throwaway HOME, fake API key, nothing submitted;
// PASTE-STRAND-1). Fixture text is harmless; the banner path is generic.
// Rows are as `tmux capture-pane -p` prints them (trailing blanks trimmed);
// `cursor` is #{cursor_x},#{cursor_y} as tmux reported it.

const RULE = '─'.repeat(80);
const FIXTURE = 'harmless fixture words harmless fixture words harmless fixture words';

const header = [
  '',
  ' ▐▛███▛█   Claude Code v2.1.327',
  '▝▜██████▀  Opus 5.5 · API Usage Billing',
  ' ▝▝   ▝▝   /…/work',
  '',
];

// Idle: rule, `❯ ` prompt row, rule, footer. Cursor right after the prompt.
export const IDLE_COMPOSER = {
  rows: [...header, ...Array(14).fill(''), '                                                            ◐ medium · /effort',
    RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'],
  cursor: [2, 21],
};

// A 781-character single-paragraph paste (one under Claude Code's 800-character
// collapse into "[Pasted text #1 +N lines]") wraps to 11 rows; the box shows 7.
// The prompt row is scrolled away and the top rule carries the hidden count.
// The cursor sits at the end of the last box row. On the host this frame read
// promptVisible:false, inputState:"indeterminate", modal:null.
export const SCROLLED_COMPOSER = {
  rows: [...header, ...Array(8).fill(''), '                                                            ◐ medium · /effort',
    `─── ↑ 4 more ${'─'.repeat(67)}`,
    ...Array(6).fill(`  ${FIXTURE}`),
    `  ${FIXTURE} h`,
    RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
  cursor: [72, 21],
};

/**
 * One readTmuxInputState snapshot (capture-pane ; display-message) as tmux
 * prints it, for an execFileSyncImpl.
 */
export function snapshot({ rows, cursor }, paneIdentity = '$1:1000:%2:123') {
  const [x, y] = cursor;
  const [sid, created, pane, pid] = paneIdentity.split(':');
  return `${rows.join('\n')}\n__ZYLOS_CURSOR__ ${x} ${y} ${sid} ${created} ${pane} ${pid}\n`;
}
