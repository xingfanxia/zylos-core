import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyLimitDialog,
  detectModal,
  findPromptY,
  readTmuxInputState,
} from '../tmux-input-state.js';
import * as fx from './fixtures/claude-dialogs.js';

function stateFor(capture, x, y) {
  return readTmuxInputState({
    sessionName: 'claude-user-pan',
    execFileSyncImpl: () => `${capture}\n${fx.cursorLine(x, y)}\n`,
  });
}

describe('classifyLimitDialog', () => {
  it('classifies the live mid-session Fable limit dialog', () => {
    assert.deepEqual(classifyLimitDialog(fx.FABLE_LIMIT_LIVE),
      { kind: 'fable_limit', text: "You've reached your Fable limit" });
  });

  it('classifies the dialog when it is drawn above a still-visible composer', () => {
    assert.equal(classifyLimitDialog(fx.FABLE_LIMIT_ABOVE_COMPOSER)?.kind, 'fable_limit');
  });

  it('classifies the pre-send usage-credits offer as credits_offer', () => {
    assert.deepEqual(classifyLimitDialog(fx.CREDITS_OFFER_LIVE),
      { kind: 'credits_offer', text: 'Claude Fable 5.2 now uses usage credits' });
  });

  it('classifies the dialog while it is still checking credits (no select yet)', () => {
    assert.equal(classifyLimitDialog(fx.CREDITS_CHECKING_LIVE)?.kind, 'fable_limit');
  });

  it('does not classify the same words quoted in conversation output', () => {
    assert.equal(classifyLimitDialog(fx.QUOTED_LIMIT_TEXT), null);
    assert.equal(detectModal(fx.QUOTED_LIMIT_TEXT), null);
  });

  it('does not classify an answered dialog left higher up on screen', () => {
    assert.equal(classifyLimitDialog(fx.SCROLLED_PAST_DIALOG), null);
    assert.equal(detectModal(fx.SCROLLED_PAST_DIALOG), null);
  });

  it('does not classify a bare keyword line without dialog structure', () => {
    const capture = ["⏺ API Error: You've reached your Fable limit.", '', ...fx.PLAIN_COMPOSER.split('\n')].join('\n');
    assert.equal(classifyLimitDialog(capture), null);
  });

  it('leaves unknown and permission dialogs unclassified', () => {
    assert.equal(classifyLimitDialog(fx.UNKNOWN_DIALOG_LIVE), null);
    assert.equal(classifyLimitDialog(fx.PERMISSION_PROMPT_LIVE), null);
    assert.equal(classifyLimitDialog(''), null);
    assert.equal(classifyLimitDialog(null), null);
  });
});

describe('detectModal', () => {
  it('reports a dialog with unknown wording as an unknown modal (wording miss still blocks)', () => {
    assert.deepEqual(detectModal(fx.UNKNOWN_DIALOG_LIVE), { kind: 'unknown', text: 'Something new needs your answer' });
  });

  it('recognizes a tool permission prompt', () => {
    assert.equal(detectModal(fx.PERMISSION_PROMPT_LIVE)?.kind, 'permission');
  });

  it('reports a bare select list at the bottom when no composer is on screen', () => {
    const capture = ['⏺ Pick one', '', '  ❯ Alpha', '    Beta'].join('\n');
    assert.equal(detectModal(capture)?.kind, 'unknown');
  });

  it('keeps the /usage overlay a modal', () => {
    assert.equal(detectModal('Settings:  Status   Config   Usage\n\nEsc to cancel')?.kind, 'usage_overlay');
  });

  it('reports nothing for a plain composer or a working session', () => {
    assert.equal(detectModal(fx.PLAIN_COMPOSER), null);
    const working = ['⏺ Bash(sleep 5)', '  ⎿  Running…', '', '✻ Thinking… (esc to interrupt)', '', ...fx.PLAIN_COMPOSER.split('\n').slice(4)].join('\n');
    assert.equal(detectModal(working), null);
  });
});

describe('select row vs composer', () => {
  it('never takes an indented select row for the composer prompt', () => {
    const capture = ['  ❯ Switch to Opus 5.5 and continue', '    Request usage credits from your admin'].join('\n');
    assert.equal(findPromptY(capture), -1);
  });

  it('reads a live dialog as no usable composer even with the cursor on the select row', () => {
    const lines = fx.FABLE_LIMIT_LIVE.split('\n');
    const selectY = lines.findIndex((line) => line.includes('❯ Switch'));
    const state = stateFor(fx.FABLE_LIMIT_LIVE, 2, selectY);
    assert.equal(state.promptVisible, false);
    assert.equal(state.inputState, 'indeterminate');
    assert.equal(state.modal.kind, 'fable_limit');
  });

  it('reads the dialog-above-composer layout as modal, not as an empty composer', () => {
    const lines = fx.FABLE_LIMIT_ABOVE_COMPOSER.split('\n');
    const promptY = lines.findIndex((line) => line.startsWith('❯ '));
    const state = stateFor(fx.FABLE_LIMIT_ABOVE_COMPOSER, 2, promptY);
    assert.equal(state.promptVisible, false);
    assert.equal(state.inputState, 'indeterminate');
    assert.equal(state.modal.kind, 'fable_limit');
  });

  it('still reads a plain composer exactly as before', () => {
    const empty = stateFor(fx.PLAIN_COMPOSER, 2, fx.PLAIN_COMPOSER_PROMPT_Y);
    assert.equal(empty.modal, null);
    assert.equal(empty.promptVisible, true);
    assert.equal(empty.inputState, 'empty');
    const typed = stateFor(fx.COMPOSER_WITH_TEXT, 19, fx.PLAIN_COMPOSER_PROMPT_Y);
    assert.equal(typed.modal, null);
    assert.equal(typed.inputState, 'has_content');
  });

  it('skips modal detection when asked (non-Claude runtimes)', () => {
    const state = readTmuxInputState({
      sessionName: 'codex-main', detectModals: false,
      execFileSyncImpl: () => `${fx.UNKNOWN_DIALOG_LIVE}\n${fx.cursorLine(2, 1)}\n`,
    });
    assert.equal(state.modal, null);
  });
});
