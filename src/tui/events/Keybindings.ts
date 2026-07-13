import type { KeyEvent, TextareaRenderable } from '@opentui/core';
import type { AppStateStore } from '../storage/Store';
import type { PermissionBoxManager } from '../components/PermissionBox';
import type { QuestionBoxManager } from '../components/QuestionBox';
import type { ConfirmBoxManager } from '../components/ConfirmBox';
import type { ResultPanelManager } from '../components/ResultPanel';
import type { CompletionManager } from '../components/CompletionManager';
import type { SubPanelManager } from '../components/QueueSubPanel';
import type { SubAgentManager } from '../subs';
import { COLORS } from '../theme';
import { copyTextToClipboard } from '../../storage/clipboard';

export interface KeybindingsContext {
  store: AppStateStore;
  inputField: TextareaRenderable;
  permissionBox: PermissionBoxManager;
  questionBox: QuestionBoxManager;
  confirmBox: ConfirmBoxManager;
  resultPanel: ResultPanelManager;
  completion: CompletionManager;
  subBox: SubPanelManager;
  subManager: SubAgentManager;
  viewerOverlay: { visible: boolean };

  // Callbacks for controller actions
  handleSubmit: () => void;
  togglePlanMode: () => void;
  withModeTag: (prompt: string) => string;
  addInfoLine: (line: string, fg: string) => void;
  updateStatus: () => void;
  requestScroll: () => void;
  handleInterrupt: () => void;
  handleExit: () => void;
  queuePanelRefresh: () => void;
}

export function handleKeyPress(key: KeyEvent, ctx: KeybindingsContext): void {
  const {
    store,
    inputField,
    permissionBox,
    questionBox,
    confirmBox,
    resultPanel,
    completion,
    subBox,
    subManager,
    viewerOverlay,
    handleSubmit,
    togglePlanMode,
    withModeTag,
    addInfoLine,
    updateStatus,
    requestScroll,
    handleInterrupt,
    handleExit,
    queuePanelRefresh,
  } = ctx;

  if (viewerOverlay.visible) {
    return;
  }

  // Meta+C to copy textarea selection or full text to clipboard
  if (key.meta && key.name === 'c') {
    const textToCopy = inputField.getSelectedText() || inputField.plainText;
    if (textToCopy) {
      copyTextToClipboard(textToCopy);
    }
    key.stopPropagation();
    return;
  }

  // Ctrl+C handling (interrupt / quit confirmation)
  if (key.ctrl && key.name === 'c') {
    if (permissionBox.isVisible()) {
      permissionBox.hide('deny');
    } else if (confirmBox.isVisible()) {
      confirmBox.hide(confirmBox.getAcceptCtrlC());
    } else if (store.processing) {
      handleInterrupt();
    } else {
      confirmBox.show(
        'Ctrl+C',
        [
          { content: '  press Ctrl+C again to exit', fg: COLORS.dim },
          { content: '  Escape to cancel', fg: COLORS.dim },
        ],
        (confirmed) => {
          if (confirmed) {
            handleExit();
          }
        },
      );
    }
    key.stopPropagation();
    return;
  }

  // Escape handling
  if (key.name === 'escape') {
    if (permissionBox.isVisible()) {
      permissionBox.hide('deny');
      key.stopPropagation();
      return;
    }
    if (confirmBox.isVisible()) {
      confirmBox.hide(false);
      key.stopPropagation();
      return;
    }
    if (completion.isCompleting()) {
      completion.hide();
      key.stopPropagation();
      return;
    }
    if (resultPanel.isVisible()) {
      resultPanel.hide();
      key.stopPropagation();
      return;
    }
    if (store.processing) {
      handleInterrupt();
      key.stopPropagation();
      return;
    }
    const now = Date.now();
    if (now - store.lastEscape < 500) {
      inputField.setText('');
    }
    store.setLastEscape(now);
    key.stopPropagation();
    return;
  }

  // ConfirmBox Return handling
  if (
    key.name === 'return' &&
    confirmBox.isVisible() &&
    confirmBox.getAcceptReturn()
  ) {
    confirmBox.hide(true);
    key.stopPropagation();
    return;
  }

  // Question Box answers
  if (questionBox.isVisible()) {
    questionBox.handleKeyPress(key);
    key.stopPropagation();
    return;
  }

  // Permission Box answers
  if (permissionBox.isVisible()) {
    if (key.name === 'y' || key.name === 'return') {
      permissionBox.hide('allow');
      key.stopPropagation();
      return;
    }
    if (key.name === 'n') {
      permissionBox.hide('deny');
      key.stopPropagation();
      return;
    }
    if (key.name === 'a') {
      permissionBox.hide('always');
      key.stopPropagation();
      return;
    }
    key.stopPropagation();
    return;
  }

  // Kill running subagent
  if (
    key.name === 'q' &&
    subBox.isVisible() &&
    store.subAgents.some((sub) => sub.status === 'running')
  ) {
    const first = store.subAgents.find((sub) => sub.status === 'running');
    if (first) {
      subManager.kill(first.id);
    }
    key.stopPropagation();
    return;
  }

  // Up/down completion selection navigation
  if ((key.name === 'up' || key.name === 'down') && completion.isCompleting()) {
    const completionList = completion.getCompletionList();
    let idx = completion.getCompletionIndex();
    idx =
      key.name === 'up'
        ? (idx - 1 + completionList.length) % completionList.length
        : (idx + 1) % completionList.length;
    completion.setCompletionIndex(idx);
    completion.render();
    key.stopPropagation();
    return;
  }

  // Shift+Tab or Ctrl+P: Plan mode toggle
  if ((key.name === 'tab' && key.shift) || (key.ctrl && key.name === 'p')) {
    togglePlanMode();
    key.stopPropagation();
    return;
  }

  // Tab (autocomplete trigger or message queueing)
  if (key.name === 'tab' && !key.shift) {
    if (completion.isCompleting()) {
      const completionList = completion.getCompletionList();
      let idx = completion.getCompletionIndex();
      idx = (idx + 1) % completionList.length;
      completion.setCompletionIndex(idx);
      completion.render();
      key.stopPropagation();
      return;
    }
    if (store.processing) {
      const raw = inputField.plainText.trim();
      if (raw) {
        store.queuePending.push(withModeTag(raw));
        inputField.setText('');
        addInfoLine(`  (queued #${store.queuePending.length})`, COLORS.yellow);
        queuePanelRefresh();
        updateStatus();
        requestScroll();
      }
      key.stopPropagation();
      return;
    }
    completion.trigger();
    key.stopPropagation();
    return;
  }

  // Return key to accept autocomplete
  if (key.name === 'return' && completion.isCompleting() && !key.shift) {
    completion.accept();
    key.stopPropagation();
    return;
  }

  // Return key to submit message
  if (key.name === 'return' && !key.shift && !store.processing) {
    const text = inputField.plainText.trim();
    if (text) {
      handleSubmit();
      key.stopPropagation();
      return;
    }
  }

  // Ctrl+D on empty input to exit TUI
  if (key.ctrl && key.name === 'd' && !inputField.plainText) {
    handleExit();
    key.stopPropagation();
    return;
  }

  // Auto-trigger completion on keypress
  if (!key.ctrl && !key.meta && key.name && key.name.length === 1) {
    queueMicrotask(() => {
      const val = inputField.plainText;
      if (/(\/|#)\S*$/.exec(val) || /@\S*$/.exec(val) || /\$\S*$/.exec(val)) {
        completion.trigger();
      } else if (completion.isCompleting()) {
        completion.hide();
      }
    });
  }

  // Backspace completion adjustment
  if (key.name === 'backspace' && completion.isCompleting()) {
    queueMicrotask(() => {
      const val = inputField.plainText;
      if (
        !/(\/|#)\S*$/.test(val) &&
        !/@\S*$/.test(val) &&
        !/\$\{\S*$/.test(val) &&
        !/\$\S*$/.test(val)
      ) {
        completion.hide();
      } else {
        completion.trigger();
      }
    });
  }
}
