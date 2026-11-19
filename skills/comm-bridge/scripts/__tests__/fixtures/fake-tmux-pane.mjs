#!/usr/bin/env node
// A fake `tmux` for the restart tests: one Claude Code pane whose state lives
// in the JSON file $FAKE_PANE_STATE, so several dispatcher processes in turn
// see the same pane. It renders the composer from that state (the reader's
// capture-pane ; display-message read), applies set-buffer / paste-buffer /
// send-keys Enter, and records every paste, every Enter (with the composer it
// was sent to) and every submission. `kill: 'enter'` ends the dispatcher
// process (SIGKILL to the parent) right after an Enter was accepted, before
// it can record anything; `dropEnters: n` ignores the first n Enters (the
// TUI did not consume them); `script[n]` overrides the n-th capture
// ('modal', 'unreadable').
import fs from 'node:fs';

const file = process.env.FAKE_PANE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const args = process.argv.slice(2);
const IDENTITY = '$1 1000 %2 123';

function frame() {
  state.captures = (state.captures || 0) + 1;
  const override = state.script?.[String(state.captures)];
  if (override === 'modal') return { rows: state.modalRows, cursor: [2, 2] };
  if (override === 'unreadable') return { rows: ['', '  ▒▒ a layout nobody knows yet ▒▒'], cursor: [5, 1] };
  const rows = [...state.idleRows];
  rows[state.promptY] = `❯ ${state.composer}`;
  return { rows, cursor: [2 + Array.from(state.composer).length, state.promptY] };
}

switch (args[0]) {
  case 'capture-pane': {
    const { rows, cursor } = frame();
    save();
    process.stdout.write(`${rows.join('\n')}\n__ZYLOS_CURSOR__ ${cursor[0]} ${cursor[1]} ${IDENTITY}\n`);
    break;
  }
  case 'set-buffer':
    state.buffer = args[args.length - 1];
    save();
    break;
  case 'paste-buffer':
    state.composer = state.buffer;
    state.pastes.push(state.buffer);
    save();
    break;
  case 'send-keys':
    if (args[args.length - 1] === 'Enter') {
      state.enters.push(state.composer);
      // `dropEnters`: the TUI ignores that many Enters (the text stays).
      if (state.dropEnters > 0) { state.dropEnters--; save(); break; }
      if (state.composer) { state.submissions.push(state.composer); state.composer = ''; }
      save();
      if (state.kill === 'enter') { state.kill = null; save(); process.kill(process.ppid, 'SIGKILL'); }
    }
    break;
  case 'display-message':
    process.stdout.write(`${IDENTITY.split(' ').join(':')}\n`);
    break;
  default:
    break;
}
