import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readTmuxInputState, getModalCapture } from '../tmux-input-state.js';

function observe(capture, cursorX, cursorY, runtime = 'codex') {
  return readTmuxInputState({ sessionName: 'bohe', runtime, execFileSyncImpl: (_cmd, args) => {
    if (args.includes('#{cursor_x}')) return String(cursorX);
    if (args.includes('#{cursor_y}')) return String(cursorY);
    return capture;
  } });
}

describe('runtime terminal state', () => {
  it('rejects Hooks menu chevrons as composer prompts regardless of cursor position', () => {
    const capture = 'Hooks\n› 1. SessionStart\n  2. UserPromptSubmit\nEnter to select · Esc to cancel';
    for (const x of [2, 28]) {
      const state = observe(capture, x, 1);
      assert.equal(state.promptVisible, false);
      assert.equal(state.inputState, 'indeterminate');
      assert.equal(state.dismissibleOverlay, 'hooks');
    }
  });
  it('never labels approval dialogs as safe overlays', () => {
    const capture = 'Hooks\nWould you like to run the following command?\n› 1. Yes\nEsc to cancel';
    assert.deepEqual(getModalCapture(capture), { modal: true, dismissibleOverlay: null });
  });
  it('ignores quoted modal instructions and ordinary approval prose above the live composer', () => {
    for (const transcript of [
      'Do you want to continue? I can approve the change.',
      'Hooks\n› 1. SessionStart\nEnter to select · Esc to cancel',
      'Settings: Status Config Usage\nEsc to cancel',
      'Would you like to run the following command?\n› 1. Yes\nEsc to cancel',
    ]) {
      const capture = transcript + '\n\n› Ask Codex to do anything';
      const state = observe(capture, 2, capture.split('\n').length - 1);
      assert.equal(state.modal, false, transcript);
      assert.equal(state.inputState, 'empty');
    }
  });
  it('rejects unknown selection menus', () => {
    assert.equal(observe('Choose a model\n› gpt-6-astra\nEnter to select · Esc to cancel', 2, 1).modal, true);
  });
  it('recognizes normal Codex busy placeholder and idle prompt', () => {
    const state = observe('• Working (4m 49s • esc to interrupt)\n\n› Ask Codex to do anything\n\n  gpt-6-astra medium · ~/zylos', 2, 2);
    assert.equal(state.inputState, 'empty');
    assert.equal(state.inProgressCapture, true);
    assert.equal(state.modal, false);
    const idle = observe('Done\n› Ask Codex to do anything', 2, 1);
    assert.equal(idle.inputState, 'empty');
    assert.equal(idle.inProgressCapture, false);
  });
  it('handles an indented Codex composer and wrapped content', () => {
    assert.equal(observe('  › Ask Codex to do anything', 4, 0).inputState, 'empty');
    assert.equal(observe('› text\nwrapped', 1, 1).inputState, 'has_content');
  });
  it('preserves Claude busy and idle detection', () => {
    const busy = observe('✻ Thinking…\n❯ ', 2, 1, 'claude');
    assert.equal(busy.inputState, 'empty');
    assert.equal(busy.inProgressCapture, true);
    assert.equal(observe('Done\n❯ ', 2, 1, 'claude').inputState, 'empty');
  });
  it('does not infer content just from a menu cursor without a composer', () => {
    assert.equal(observe('Settings\nNo composer here', 23, 1).inputState, 'indeterminate');
  });
});
