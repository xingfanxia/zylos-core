// Composer frames captured from Claude Code CLI 2.1.327 (the host's version
// on 2026-11-19) and 2.1.328 (identical apart from the banner), and from
// Codex CLI 0.170.0, in a private tmux server (throwaway HOME, fake API key,
// nothing submitted; PASTE-STRAND-1). Rows as `tmux capture-pane -p` prints
// them (trailing blanks trimmed), banner paths made generic; `cursor` is
// #{cursor_x},#{cursor_y} as tmux reported it. Fixture text is harmless.

// The 781-character single paragraph of the incident size (one under Claude
// Code's 800-character collapse).
export const MESSAGE_781 = "[TG DM] tester said: harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words h";
// Two lines, a path and a reply-via suffix.
export const MESSAGE_TWO_LINES = "[TG DM] tester said: first line of a harmless fixture\nsecond line, also harmless, with a path /home/fixture/notes/file.md ---- reply via: node /home/fixture/c4-send.js \"telegram\" \"100\"";
// Twenty short lines (Codex scrolls them; Claude collapses them).
export const MESSAGE_20_LINES = "line 01 of a harmless fixture\nline 02 of a harmless fixture\nline 03 of a harmless fixture\nline 04 of a harmless fixture\nline 05 of a harmless fixture\nline 06 of a harmless fixture\nline 07 of a harmless fixture\nline 08 of a harmless fixture\nline 09 of a harmless fixture\nline 10 of a harmless fixture\nline 11 of a harmless fixture\nline 12 of a harmless fixture\nline 13 of a harmless fixture\nline 14 of a harmless fixture\nline 15 of a harmless fixture\nline 16 of a harmless fixture\nline 17 of a harmless fixture\nline 18 of a harmless fixture\nline 19 of a harmless fixture\nline 20 of a harmless fixture";

const RULE = '─'.repeat(80);
const FIXTURE = 'harmless fixture words harmless fixture words harmless fixture words';
const header = [
  '',
  ' ▐▛███▛█   Claude Code v2.1.327',
  '▝▜██████▀  Opus 5.5 · API Usage Billing',
  ' ▝▝   ▝▝   /…/work',
  '',
];

// Claude, 80x24, idle: rule, `❯ ` prompt row, rule, footer.
export const IDLE_COMPOSER = {
  rows: [...header, ...Array(14).fill(''), '                                                            ◐ medium · /effort',
    RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'],
  cursor: [2, 21],
};

// Claude, 80x24, MESSAGE_781 pasted: 11 rows, the box shows 7, the prompt row
// is scrolled away and the top rule counts the hidden rows. On the host this
// frame read promptVisible:false, inputState:"indeterminate", modal:null.
export const SCROLLED_COMPOSER = {
  rows: [...header, ...Array(8).fill(''), '                                                            ◐ medium · /effort',
    `─── ↑ 4 more ${'─'.repeat(67)}`,
    ...Array(6).fill(`  ${FIXTURE}`),
    `  ${FIXTURE} h`,
    RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
  cursor: [72, 21],
};

// Claude, 200x60, MESSAGE_781 pasted: 5 rows, the whole draft on screen.
export const COMPOSER_781_AT_200x60 = { rows: [
  "",
  " ▐▛███▛█   Claude Code v2.1.327",
  "▝▜██████▀  Opus 5.5 · API Usage Billing",
  " ▝▝   ▝▝   /…/work",
  "",
  "⚠ Remote managed settings failed to load (authentication rejected (401)) · no remote policy applied · /status for details",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "                                                                                                                                                                                    ◐ medium · /effort",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ [TG DM] tester said: harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless",
  "  fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture",
  "  words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words",
  "  harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless fixture words harmless",
  "  fixture words h",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)"
], cursor: [17, 57] };

// Claude, 80x24, MESSAGE_TWO_LINES pasted (unscrolled, wrapped).
export const COMPOSER_TWO_LINES = { rows: [
  "",
  " ▐▛███▛█   Claude Code v2.1.327",
  "▝▜██████▀  Opus 5.5 · API Usage Billing",
  " ▝▝   ▝▝   /…/work",
  "",
  "⚠ Remote managed settings failed to load (authentication rejected (401)) · no",
  "  remote policy applied · /status for details",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "                                                         ctrl+g to edit in Vim",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ [TG DM] tester said: first line of a harmless fixture",
  "  second line, also harmless, with a path /home/fixture/notes/file.md ----",
  "  reply via: node /home/fixture/c4-send.js \"telegram\" \"100\"",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)"
], cursor: [59, 21] };

// Codex, 80x24, MESSAGE_781 pasted: `›` row and indented rows down to a blank row.
export const CODEX_781 = { rows: [
  "",
  "  >_ OpenAI Codex (v0.170.0)",
  "     /…/work",
  "",
  "",
  "",
  "",
  "",
  "",
  "› [TG DM] tester said: harmless fixture words harmless fixture words harmless",
  "  fixture words harmless fixture words harmless fixture words harmless fixture",
  "  words harmless fixture words harmless fixture words harmless fixture words",
  "  harmless fixture words harmless fixture words harmless fixture words harmless",
  "  fixture words harmless fixture words harmless fixture words harmless fixture",
  "  words harmless fixture words harmless fixture words harmless fixture words",
  "  harmless fixture words harmless fixture words harmless fixture words harmless",
  "  fixture words harmless fixture words harmless fixture words harmless fixture",
  "  words harmless fixture words harmless fixture words harmless fixture words",
  "  harmless fixture words harmless fixture words harmless fixture words harmless",
  "  fixture words h",
  "",
  "  GPT-6.2-Sol default · /…/work",
  "",
  ""
], cursor: [17, 19] };

// Codex, 80x24, MESSAGE_20_LINES pasted: it keeps the `›` row on screen and
// marks the hidden lines above with `↑` at the end of that row.
export const CODEX_SCROLLED = { rows: [
  "",
  "  >_ OpenAI Codex (v0.170.0)",
  "     /…/work",
  "",
  "",
  "",
  "",
  "",
  "",
  "› line 07 of a harmless fixture                                                ↑",
  "  line 08 of a harmless fixture",
  "  line 09 of a harmless fixture",
  "  line 10 of a harmless fixture",
  "  line 11 of a harmless fixture",
  "  line 12 of a harmless fixture",
  "  line 13 of a harmless fixture",
  "  line 14 of a harmless fixture",
  "  line 15 of a harmless fixture",
  "  line 16 of a harmless fixture",
  "  line 17 of a harmless fixture",
  "  line 18 of a harmless fixture",
  "  line 19 of a harmless fixture",
  "  line 20 of a harmless fixture"
], cursor: [31, 22] };

/**
 * One readTmuxInputState snapshot (capture-pane ; display-message) as tmux
 * prints it, for an execFileSyncImpl.
 */
export function snapshot({ rows, cursor }, paneIdentity = '$1:1000:%2:123') {
  const [x, y] = cursor;
  const [sid, created, pane, pid] = paneIdentity.split(':');
  return `${rows.join('\n')}\n__ZYLOS_CURSOR__ ${x} ${y} ${sid} ${created} ${pane} ${pid}\n`;
}
