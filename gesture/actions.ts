// src/gesture/actions.ts
import { App, Notice } from 'obsidian';
import { GesturePattern } from '../types/gesture';

export interface GestureActionContext {
  app: App;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  navigateSibling: (delta: number) => void;
  cycleTab: (delta: number) => void;
  openNewTab: () => void;
}

export type ActionId =
  | 'none'
  | 'custom-command'
  | 'navigate-back'
  | 'navigate-forward'
  | 'scroll-top'
  | 'scroll-bottom'
  | 'split-horizontal'
  | 'split-vertical'
  | 'copy-full-path'
  | 'copy-obsidian-url'
  | 'export-pdf'
  | 'open-in-new-window'
  | 'move-to-new-window'
  | 'cycle-tab-left'
  | 'cycle-tab-right'
  | 'close-tab'
  | 'reopen-closed-tab'
  | 'new-tab'
  | 'minimize-window'
  | 'maximize-window'
  | 'next-file'
  | 'prev-file'
  | 'refresh-app'
  | 'undo';

export const ACTION_IDS: ActionId[] = [
  'none',
  'custom-command',
  'navigate-back',
  'navigate-forward',
  'scroll-top',
  'scroll-bottom',
  'split-horizontal',
  'split-vertical',
  'copy-full-path',
  'copy-obsidian-url',
  'export-pdf',
  'open-in-new-window',
  'move-to-new-window',
  'cycle-tab-left',
  'cycle-tab-right',
  'close-tab',
  'reopen-closed-tab',
  'new-tab',
  'minimize-window',
  'maximize-window',
  'next-file',
  'prev-file',
  'refresh-app',
  'undo',
];

type Action = (ctx: GestureActionContext) => boolean;

interface CommandApi {
  executeCommandById: (id: string) => unknown;
}

interface ElectronRemoteWindow {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  setFullScreen(fullscreen: boolean): void;
  isFullScreen(): boolean;
}

interface ElectronWindow extends Window {
  require?: (module: 'electron') => {
    remote?: {
      getCurrentWindow?: () => ElectronRemoteWindow;
    };
  };
}

const tryWithNotice = (label: string, fn: () => void) => {
  try {
    fn();
    return true;
  } catch (err) {
    console.error(label, err);
    return false;
  }
};

const getCurrentWindow = () => {
  try {
    const electron = (window as ElectronWindow).require?.('electron');
    return electron?.remote?.getCurrentWindow?.() ?? null;
  } catch (err) {
    console.error('electron remote unavailable', err);
    return null;
  }
};

const getCommands = (app: App): CommandApi | null => {
  const commands = (app as App & { commands?: CommandApi }).commands;
  return commands ?? null;
};

const runCommand = (app: App, id: string) => {
  const commands = getCommands(app);
  if (!commands) {
    throw new Error(`command API unavailable: ${id}`);
  }
  commands.executeCommandById(id);
};

export const ACTION_TABLE: Record<ActionId, Action> = {
  none: () => true,
  'custom-command': () => true,
  'navigate-back': () => tryWithNotice('navigate back', () => window.history.back()),
  'navigate-forward': () =>
    tryWithNotice('navigate forward', () => window.history.forward()),
  'scroll-top': (ctx) => tryWithNotice('scroll top', () => ctx.scrollToTop()),
  'scroll-bottom': (ctx) =>
    tryWithNotice('scroll bottom', () => ctx.scrollToBottom()),
  'split-horizontal': (ctx) =>
    tryWithNotice('split horizontal', () =>
      runCommand(ctx.app, 'workspace:split-horizontal'),
    ),
  'split-vertical': (ctx) =>
    tryWithNotice('split vertical', () =>
      runCommand(ctx.app, 'workspace:split-vertical'),
    ),
  'copy-full-path': (ctx) =>
    tryWithNotice('copy full path', () =>
      runCommand(ctx.app, 'workspace:copy-full-path'),
    ),
  'copy-obsidian-url': (ctx) =>
    tryWithNotice('copy obsidian url', () =>
      runCommand(ctx.app, 'workspace:copy-url'),
    ),
  'export-pdf': (ctx) =>
    tryWithNotice('export pdf', () =>
      runCommand(ctx.app, 'workspace:export-pdf'),
    ),
  'open-in-new-window': (ctx) =>
    tryWithNotice('open in new window', () =>
      runCommand(ctx.app, 'workspace:open-in-new-window'),
    ),
  'move-to-new-window': (ctx) =>
    tryWithNotice('move to new window', () =>
      runCommand(ctx.app, 'workspace:move-to-new-window'),
    ),
  'cycle-tab-left': (ctx) => tryWithNotice('tab left', () => ctx.cycleTab(-1)),
  'cycle-tab-right': (ctx) => tryWithNotice('tab right', () => ctx.cycleTab(1)),
  'close-tab': (ctx) =>
    tryWithNotice('close tab', () => ctx.app.workspace.getLeaf(false).detach()),
  'reopen-closed-tab': (ctx) =>
    tryWithNotice('reopen closed tab', () =>
      runCommand(ctx.app, 'workspace:undo-close-pane'),
    ),
  'new-tab': (ctx) =>
    tryWithNotice('new tab', () => ctx.openNewTab()),
  'minimize-window': () =>
    tryWithNotice('minimize window', () => {
      const win = getCurrentWindow();
      if (win) win.minimize();
    }),
  'maximize-window': () =>
    tryWithNotice('maximize window', () => {
      const win = getCurrentWindow();
      if (!win) return;
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }),
  'next-file': (ctx) => tryWithNotice('next file', () => ctx.navigateSibling(1)),
  'prev-file': (ctx) => tryWithNotice('prev file', () => ctx.navigateSibling(-1)),
  'refresh-app': (ctx) =>
    tryWithNotice('refresh app', () =>
      runCommand(ctx.app, 'app:reload'),
    ),
  undo: (ctx) =>
    tryWithNotice('undo', () =>
      runCommand(ctx.app, 'editor:undo'),
    ),
};

export function executeGesture(
  pattern: GesturePattern,
  actionId: ActionId,
  ctx: GestureActionContext,
) {
  const key = pattern.join(',');
  const action = ACTION_TABLE[actionId];
  if (!action) {
    new Notice(`Unassigned gesture: ${key}`);
    return false;
  }

  const ok = action(ctx);
  if (!ok) {
    new Notice(`Gesture failed: ${key}`);
  }
  return ok;
}
