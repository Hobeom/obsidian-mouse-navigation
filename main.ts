import {
	App,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	WorkspaceLeaf,
	WorkspaceWindow,
} from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import { GestureRecognizer } from './gesture/recognizer';
import {
	ActionId,
	ACTION_IDS,
	executeGesture,
} from './gesture/actions';
import { GesturePattern } from './types/gesture';
import { getStrings, Locale } from './locales';

interface GestureNavSettings {
	trigerkey: TrigerKey;
	enableDrawing: boolean;
	strokeColor: string; 
	customStrokeColor: string; 
	lineWidth: number;   
	gestureBindings: Record<string, ActionId>;
	gestureEngine: GestureEngine;
	enableDiagonalGestures: boolean;
	language: Locale;
	showContextMenuOnCancel: boolean;
	newTabBehavior: NewTabBehavior;
	debugMode: boolean;
	customCommandIds: Record<string, string>;
}

enum TrigerKey {
	RIGHT_CLICK = 2,
	WHEEL_CLICK = 1,
}

type NewTabBehavior = 'empty' | 'current' | 'new-note';
type GestureEngine = 'legacy-v1' | 'modern-v2';
type WorkspaceLeafWithParent = WorkspaceLeaf & {
	parent?: {
		children?: WorkspaceLeaf[];
	};
};

const DEFAULT_SETTINGS: GestureNavSettings = {
	trigerkey: TrigerKey.RIGHT_CLICK,
	enableDrawing: true, 
	strokeColor: 'accent', 
	customStrokeColor: '', 
	lineWidth: 5,          
	gestureBindings: {},
	gestureEngine: 'modern-v2',
	enableDiagonalGestures: false,
	language: 'en',
	showContextMenuOnCancel: false,
	newTabBehavior: 'empty',
	debugMode: false,
	customCommandIds: {},
};

const DEFAULT_GESTURE_BINDINGS: Record<string, ActionId> = {
	left: 'navigate-back',
	right: 'navigate-forward',
	up: 'scroll-top',
	down: 'scroll-bottom',
	'up-right': 'refresh-app',
	'down-left': 'reopen-closed-tab',
	'down-right': 'navigate-forward',
	'up-left': 'navigate-back',
	'down,left': 'cycle-tab-left',
	'down,right': 'cycle-tab-right',
	'up,left': 'close-tab',
	'up,right': 'new-tab',
	'right,down': 'copy-obsidian-url',
	'right,up': 'maximize-window',
	'left,down': 'next-file',
	'left,up': 'prev-file',
	'UD-UD': 'split-vertical',
	'LR-LR': 'split-horizontal',
};

const GESTURE_META: { key: string; icon: string; diagonal?: boolean }[] = [
	{ key: 'left', icon: '←' },
	{ key: 'right', icon: '→' },
	{ key: 'up', icon: '↑' },
	{ key: 'down', icon: '↓' },
	{ key: 'up-right', icon: '↗', diagonal: true },
	{ key: 'down-left', icon: '↙', diagonal: true },
	{ key: 'down-right', icon: '↘', diagonal: true },
	{ key: 'up-left', icon: '↖', diagonal: true },
	{ key: 'down,left', icon: '↵' },
	{ key: 'down,right', icon: '↳' },
	{ key: 'up,left', icon: '↰' },
	{ key: 'up,right', icon: '↱' },
	{ key: 'right,down', icon: '⬎' },
	{ key: 'right,up', icon: '⬏' },
	{ key: 'left,down', icon: '⬐' },
	{ key: 'left,up', icon: '⬑' },
	{ key: 'UD-UD', icon: '⇅' },
	{ key: 'LR-LR', icon: '⇄' },
];

const isPreviewMode = (markdownView: MarkdownView | null) => {
	if (markdownView === null) return false;
	const mode = markdownView.getMode();
	return mode === 'preview' && markdownView.previewMode !== null;
};

const isEditMode = (markdownView: MarkdownView | null) => {
	if (markdownView === null) return false;
	const mode = markdownView.getMode();
	return mode === 'source' && markdownView.editor !== null;
};

export default class GestureNav extends Plugin {
	settings: GestureNavSettings;
	private recognizer = new GestureRecognizer({
		thresholdPx: 60,
		maxSegments: 4,
	});
	private gestureCanceled = false;
	private completedGestureType: 'two' | null = null;
	private completedPoint: { x: number; y: number } | null = null;
	// repeatCandidate removed; 2-step repeat handled in recognizer
	private activeGestureDocument: Document | null = null;
	private contextMenuCleanup: (() => void) | null = null;
	private recognizedGesture = false;
	private gestureStarted = false;
	private legacyCurrentGesture: 'left' | 'right' | 'up' | 'down' | null = null;
	private legacyStartPoint: { x: number; y: number } | null = null;
	private registeredDocs = new Set<Document>();

	async onload() {
		await this.loadSettings();

		this.registerEvent(
			this.app.workspace.on('window-open', (newWindow: WorkspaceWindow) =>
				this.registerEvents(newWindow.win),
			),
		);
		this.registerEvents(window);

		this.addSettingTab(new GestureNavSettingTab(this.app, this));
	}

	onunload() {
		this.resetGestureInteraction();
	}

	async loadSettings() {
		const rawData = (await this.loadData()) as
			| (Partial<GestureNavSettings> & { openNewTabCreatesNote?: boolean })
			| null;
		const hasExistingData =
			rawData !== null && Object.keys(rawData).length > 0;
		const gestureEngine: GestureEngine =
			rawData?.gestureEngine ??
			(hasExistingData ? 'legacy-v1' : DEFAULT_SETTINGS.gestureEngine);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, rawData, {
			gestureEngine,
		});

		this.settings.gestureBindings = {
			...DEFAULT_GESTURE_BINDINGS,
			...(this.settings.gestureBindings ?? {}),
		};
		this.settings.customCommandIds = {
			...(this.settings.customCommandIds ?? {}),
		};

		// migrate legacy settings
		if (rawData && typeof rawData.openNewTabCreatesNote === 'boolean') {
			this.settings.newTabBehavior = rawData.openNewTabCreatesNote
				? 'new-note'
				: 'current';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private isModernEngine() {
		return this.settings.gestureEngine === 'modern-v2';
	}

	private getCommands() {
		const appWithCommands = this.app as App & {
			commands?: { executeCommandById: (id: string) => unknown };
		};
		return appWithCommands.commands ?? null;
	}

	private runCommand(id: string) {
		this.getCommands()?.executeCommandById(id);
	}

	private executeActionForPattern(pattern: GesturePattern) {
		const actionId = this.getActionForPattern(pattern);
		if (actionId === 'custom-command') {
			const customId = this.getCustomCommandId(pattern.join(','));
			if (customId) {
				this.runCommand(customId);
			}
			return;
		}
		executeGesture(pattern, actionId, this.getGestureActionContext());
	}

	private overlay: HTMLElement | null = null; // gesture overlay

	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private drawing = false; // Keep track if we are currently drawing

	private resetGestureInteraction() {
		this.activeGestureDocument = null;
		this.contextMenuCleanup?.();
		this.contextMenuCleanup = null;
		this.stopDrawing();
		this.hideGestureOverlay();
		this.gestureCanceled = false;
		this.completedGestureType = null;
		this.completedPoint = null;
		this.recognizedGesture = false;
		this.gestureStarted = false;
		this.recognizer.start(0, 0);
		this.legacyStartPoint = null;
		this.legacyCurrentGesture = null;
	}

	private registerEvents(currentWindow: Window) {
		const doc: Document = currentWindow.document;
		this.registeredDocs.add(doc);

		const contextMenuBlocker = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			if (
				target.closest('.workspace-leaf')?.classList.contains('nav-folder')
			) {
				return;
			}
			if (event.isTrusted) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		this.register(() => {
			doc.removeEventListener('contextmenu', contextMenuBlocker, true);
			this.registeredDocs.delete(doc);
		});

		// Detect when the right mouse button is pressed
		this.registerDomEvent(doc, 'mousedown', (evt: MouseEvent) => {
			if (evt.button !== Number(this.settings.trigerkey)) {
				return;
			}

			// Every trigger press starts clean, including presses outside the editor.
			this.resetGestureInteraction();
			this.recognizer = new GestureRecognizer({
				thresholdPx: 60,
				maxSegments: 4,
				enableDiagonals: this.isModernEngine() && this.settings.enableDiagonalGestures,
			});
			this.recognizer.start(evt.clientX, evt.clientY);

			if (this.isSettingsVisible() || !isEditMode(this.getCurrentViewOfType())) {
				doc.removeEventListener('contextmenu', contextMenuBlocker, true);
				return;
			}

			doc.addEventListener('contextmenu', contextMenuBlocker, true);
			this.contextMenuCleanup = () => doc.removeEventListener('contextmenu', contextMenuBlocker, true);
			this.activeGestureDocument = doc;
			this.startDrawing(evt);
			if (!this.isModernEngine()) {
				this.legacyStartPoint = { x: evt.clientX, y: evt.clientY };
			}
		});

		// Track mouse movement to detect gestures, but do not execute actions yet
		this.registerDomEvent(doc, 'mousemove', (evt: MouseEvent) => {
			if (this.activeGestureDocument === doc) {
				if (this.drawing) {
					this.draw(evt.clientX, evt.clientY);
				}
				if (!this.isModernEngine()) {
					if (!this.legacyStartPoint) return;
					const gestureMargin = 75;
					const deltaX = evt.clientX - this.legacyStartPoint.x;
					const deltaY = evt.clientY - this.legacyStartPoint.y;
					let detectedGesture: 'left' | 'right' | 'up' | 'down' | null =
						null;
					if (
						Math.abs(deltaX) > gestureMargin &&
						Math.abs(deltaY) < gestureMargin
					) {
						detectedGesture = deltaX > 0 ? 'right' : 'left';
					} else if (
						Math.abs(deltaY) > gestureMargin &&
						Math.abs(deltaX) < gestureMargin
					) {
						detectedGesture = deltaY > 0 ? 'down' : 'up';
					}
					if (detectedGesture !== this.legacyCurrentGesture) {
						this.legacyCurrentGesture = detectedGesture;
						if (detectedGesture) {
							this.showGestureOverlayByPattern([detectedGesture]);
						} else {
							this.hideGestureOverlay();
						}
					}
					return;
				}

				if (this.gestureCanceled) {
					this.showGestureOverlay('✕', this.getStrings().common.cancel);
					return;
				}
				this.recognizer.track(evt.clientX, evt.clientY, (segments) => {
					if (this.recognizer.isCanceled()) {
						this.recognizedGesture = true;
						this.cancelGesture();
						return;
					}
					if (!this.gestureStarted && segments.length > 0) {
						this.gestureStarted = true;
					}

					if (segments.length === 2 && !this.completedGestureType) {
						this.completedGestureType = 'two';
						this.completedPoint = { x: evt.clientX, y: evt.clientY };
						this.recognizedGesture = true;
					}

					if (
						this.completedGestureType === 'two' &&
						segments.length > 2
					) {
						this.cancelGesture();
						return;
					}

					if (segments.length >= 2) {
						const pattern = this.recognizer.finish();
						if (pattern.length > 0) {
							this.showGestureOverlayByPattern(pattern);
							return;
						}
					}

					this.showGestureOverlayBySegments(segments);
				});
			}
		});

		// When the right mouse button is released, execute the corresponding gesture action
		this.registerDomEvent(doc, 'mouseup', (evt: MouseEvent) => {
			if (evt.button === Number(this.settings.trigerkey)) {
				if (this.activeGestureDocument !== doc) {
					// A release in another window ends the source interaction without an action.
					if (this.activeGestureDocument) this.resetGestureInteraction();
					return;
				}
				this.activeGestureDocument = null;
				// Retain the blocker until the next press to suppress a trailing native menu.
				this.stopDrawing();
				if (!this.isModernEngine()) {
					if (this.legacyCurrentGesture) {
						this.showGestureOverlayByPattern([this.legacyCurrentGesture]);
						this.executeActionForPattern([this.legacyCurrentGesture]);
					} else {
						this.showContextMenu(evt);
					}
					this.hideGestureOverlay();
					this.legacyCurrentGesture = null;
					this.legacyStartPoint = null;
					return;
				}

				const pattern = this.recognizer.finish();
				const allowContextMenu =
					(this.gestureCanceled &&
						(!this.recognizedGesture ||
							this.settings.showContextMenuOnCancel)) ||
					(!this.gestureCanceled &&
						pattern.length === 0 &&
						!this.gestureStarted);

				if (allowContextMenu) {
					// const markdownView = this.getCurrentViewOfType();
					// this.selectTextUnderCursor(evt);
					this.showContextMenu(evt);
				}

				if (this.gestureCanceled) {
					this.hideGestureOverlay();
					this.completedGestureType = null;
					this.completedPoint = null;
					this.recognizedGesture = false;
					return;
				}

				if (pattern.length !== 0) {
					this.showGestureOverlayByPattern(pattern);
					this.executeActionForPattern(pattern);
				}

				this.hideGestureOverlay();
				this.recognizedGesture = false;
				this.gestureStarted = false;
			}
		});
	}
	private startDrawing(evt: MouseEvent) {
		// Check if drawing is enabled
		if (!this.settings.enableDrawing) {
			return; // Exit early if drawing is disabled
		}

		this.drawing = true;
		const doc = evt.view?.document ?? activeDocument;
		const win = doc.defaultView ?? activeWindow;
	
		// Create a canvas if it doesn't exist
		if (!this.canvas) {
			this.canvas = createEl('canvas');
			this.canvas.classList.add('gesture-canvas'); 
	
			this.canvas.width = win.innerWidth;
			this.canvas.height = win.innerHeight;
	
			doc.body.appendChild(this.canvas);
			this.ctx = this.canvas.getContext('2d');
	
			let strokeColor = this.settings.strokeColor;
			if (strokeColor === 'accent') {
				const obsidianStyles = win.getComputedStyle(doc.body);
				strokeColor = obsidianStyles.getPropertyValue('--interactive-accent').trim();
			} else if (strokeColor === 'custom') {
				strokeColor = this.settings.customStrokeColor || '#000000'; // Fallback to black if custom color is not provided
			}
	
			// Set the drawing style using the selected stroke color
			if (this.ctx) {
				this.ctx.strokeStyle = strokeColor;
				this.ctx.lineWidth = this.settings.lineWidth;
				this.ctx.lineJoin = 'round';
				this.ctx.lineCap = 'round';
			}
		}
	
		// Begin path at the current mouse position
		if (this.ctx) {
			this.ctx.beginPath();
			this.ctx.moveTo(evt.clientX, evt.clientY);
		}
	}
	
	// Draw the line to the current mouse position
	private draw(x: number, y: number) {
		if (!this.drawing || !this.settings.enableDrawing) {
			return;
		}
		if (this.ctx) {
			this.ctx.lineTo(x, y); // Draw line to this point
			this.ctx.stroke(); // Actually render the line
		}
	}
	
	// Stop drawing and remove the canvas if necessary
	private stopDrawing() {
		this.drawing = false;
		if (this.canvas) {
			this.canvas.remove();
			this.canvas = null;
			this.ctx = null;
		}
	}
	
	private showContextMenu(evt: MouseEvent) {
		const markdownView = this.getCurrentViewOfType();
		if (isEditMode(markdownView)) {
			this.showEditModeContextMenu(evt);
		} else if (isPreviewMode(markdownView)) {
			this.showPreviewContextMenu(evt);
		}
	}

	private showEditModeContextMenu(evt: MouseEvent) {
		const doc = evt.view?.document ?? activeDocument;
		const target = doc.elementFromPoint(evt.clientX, evt.clientY);
		if (!target) return;
		target.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX: evt.clientX,
				clientY: evt.clientY,
			}),
		);
	}

	private isSettingsVisible(): boolean {
		const settingTabs = activeDocument.querySelector<HTMLElement>(
			'.modal-container',
		);
		return settingTabs !== null && settingTabs.style.display !== 'none';
	}

	private selectTextUnderCursor(evt: MouseEvent) {
		// TODO: Implement text selection under cursor
	}	

	private showPreviewContextMenu(evt: MouseEvent) {
		this.showEditModeContextMenu(evt);
	}

	private showGestureOverlay(icon: string, actionText: string, doc: Document = activeDocument) {
		if (this.overlay) {
			this.overlay.remove();
		}
	
		this.overlay = createDiv();
		this.overlay.classList.add('gesture-overlay');
	
		// Add the arrow symbol to the overlay
		const arrow = createDiv();
		arrow.innerText = icon;
		this.overlay.appendChild(arrow);
	
		// Add text below the arrow based on gesture direction
		const text = createDiv();
		text.innerText = actionText;
		text.classList.add('gesture-text');
		this.overlay.appendChild(text);
	
		doc.body.appendChild(this.overlay);
	}

	private hideGestureOverlay() {
		if (this.overlay) {
			this.overlay.remove();
			this.overlay = null;
		}
	}

	private showGestureOverlayBySegments(segments: string[]) {
		if (segments.length === 0) {
			this.hideGestureOverlay();
			return;
		}
		if (segments.length > 2) {
			// Repeat gestures are only shown on mouseup
			return;
		}
		const key = segments.join(',');
		const meta = this.getGestureMeta(key);
		if (!meta) {
			this.showGestureOverlay('✕', this.getStrings().common.cancel);
			return;
		}
		const actionLabel = this.getActionLabel(this.getActionForKey(key));
		this.showGestureOverlay(meta.icon, actionLabel);
	}

	private showGestureOverlayByPattern(pattern: GesturePattern) {
		const key = pattern.join(',');
		const meta = this.getGestureMeta(key);
		if (!meta) {
			this.showGestureOverlay('✕', this.getStrings().common.cancel);
			return;
		}
		const actionLabel = this.getActionLabel(this.getActionForKey(key));
		this.showGestureOverlay(meta.icon, actionLabel);
	}

	private getGestureMeta(key: string) {
		return GESTURE_META.find((meta) => meta.key === key);
	}


	private cancelGesture() {
		this.gestureCanceled = true;
		this.showGestureOverlay('✕', this.getStrings().common.cancel);
	}

	private getActionForPattern(pattern: GesturePattern): ActionId {
		return this.getActionForKey(pattern.join(','));
	}

	private getActionForKey(key: string): ActionId {
		return this.settings.gestureBindings[key] ?? 'none';
	}

	private getActionLabel(actionId: ActionId) {
		const strings = this.getStrings();
		return strings.actionLabels[actionId] ?? strings.actionLabels.none;
	}

	public getCustomCommandId(key: string) {
		return this.settings.customCommandIds[key] ?? '';
	}

	public getGestureLabel(key: string) {
		const strings = this.getStrings();
		const labels = strings.gestureLabels as Record<string, string>;
		return labels[key] ?? key;
	}

	private getStrings() {
		return getStrings(this.settings.language);
	}
	

	public getCurrentViewOfType(): MarkdownView | null {
		// get the current active view
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		// // To distinguish whether the current view is hidden or not markdownView
		// const currentView = this.app.workspace.getActiveViewOfType(
		// 	View,
		// );
		// // solve the problem of closing always focus new tab setting
		// if (markdownView !== null) {
		// 	globalMarkdownView = markdownView;
		// } else {
		// 	// fix the plugin shutdown problem when the current view is not exist
		// 	if (currentView == null || !(currentView instanceof EditableFileView) && currentView?.file?.extension == 'md') {
		// 		markdownView = globalMarkdownView;
		// 	}
		// }
		return markdownView;
	}

	private scrollToTop() {
		const markdownView = this.getCurrentViewOfType();
		if (markdownView === null) return;
		markdownView.currentMode.applyScroll(0);
	}

	private scrollToBottom = () => {
		const markdownView = this.getCurrentViewOfType();
		if (markdownView === null) return;
		markdownView.currentMode.applyScroll(Number.MAX_SAFE_INTEGER);
	};

	private async navigateSibling(delta: number) {
		const currentFile = this.app.workspace.getActiveFile();
		if (!currentFile) return;
		const folder = currentFile.parent;
		if (!folder) return;
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.parent === folder)
			.sort((a, b) => a.basename.localeCompare(b.basename));

		const currentIndex = files.findIndex(
			(file) => file.path === currentFile.path,
		);
		if (currentIndex === -1 || files.length < 2) return;
		const nextIndex = (currentIndex + delta + files.length) % files.length;
		await this.app.workspace.openLinkText(
			files[nextIndex].path,
			currentFile.path,
			false,
		);
	}

	private cycleTab(delta: number) {
		const activeLeaf = this.app.workspace.getLeaf(false);

		const parent = (activeLeaf as WorkspaceLeafWithParent).parent;
		const children = parent?.children;
		const siblingLeaves: WorkspaceLeaf[] = Array.isArray(children)
			? children
			: [];

		if (siblingLeaves.length > 1) {
			const activeIndex = siblingLeaves.findIndex(
				(leaf) => leaf === activeLeaf,
			);
			if (activeIndex === -1) return;
			const nextIndex =
				(activeIndex + delta + siblingLeaves.length) %
				siblingLeaves.length;
			const nextLeaf = siblingLeaves[nextIndex];
			if (!nextLeaf) return;
			this.app.workspace.setActiveLeaf(nextLeaf, { focus: true });
			return;
		}

		// fallback: same view type
		const viewType = activeLeaf.view.getViewType();
		const leaves = this.app.workspace.getLeavesOfType(viewType);
		const activeIndex = leaves.findIndex((leaf) => leaf === activeLeaf);
		if (activeIndex === -1 || leaves.length < 2) return;
		const nextIndex = (activeIndex + delta + leaves.length) % leaves.length;
		const nextLeaf = leaves[nextIndex];
		if (!nextLeaf) return;
		this.app.workspace.setActiveLeaf(nextLeaf, { focus: true });
	}

	private async openNewTab() {
		if (this.settings.newTabBehavior === 'empty') {
			await this.openEmptyTab();
			return;
		}
		if (this.settings.newTabBehavior === 'current') {
			const activeLeaf = this.app.workspace.getLeaf(false);
			await this.app.workspace.duplicateLeaf(activeLeaf, 'tab');
			return;
		}
		await this.createNewNoteInTab();
	}

	private async openEmptyTab() {
		try {
			const leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: 'empty', state: {} });
			return;
		} catch {
			await this.app.workspace.openLinkText('', '', 'tab');
		}
	}

	private async createNewNoteInTab() {
		const folder = this.resolveNewNoteFolder();
		const file = await this.createUniqueMarkdownFile(
			folder?.path ?? '',
			'Untitled',
		);
		if (!file) return;
		await this.app.workspace.openLinkText(file.path, '', 'tab');
	}

	private resolveNewNoteFolder() {
		if (requireApiVersion('1.1.13')) {
			const currentPath = this.app.workspace.getActiveFile()?.path ?? '';
			return this.app.fileManager.getNewFileParent(currentPath);
		}
		return this.app.vault.getRoot();
	}

	private async createUniqueMarkdownFile(folderPath: string, baseName: string) {
		const normalized = folderPath ? folderPath.replace(/\/+$/, '') : '';
		const prefix = normalized ? `${normalized}/` : '';
		let attempt = 0;
		while (attempt < 200) {
			const suffix = attempt === 0 ? '' : ` ${attempt}`;
			const filename = `${prefix}${baseName}${suffix}.md`;
			const exists = this.app.vault.getAbstractFileByPath(filename);
			if (!exists) {
				try {
					return await this.app.vault.create(filename, '');
				} catch {
					// continue
				}
			}
			attempt += 1;
		}
		return null;
	}

	private getGestureActionContext() {
		return {
			app: this.app,
			scrollToTop: this.scrollToTop.bind(this),
			scrollToBottom: this.scrollToBottom.bind(this),
			navigateSibling: (delta: number) => {
				void this.navigateSibling(delta).catch((error: unknown) => {
					console.error('Failed to navigate to a sibling note', error);
				});
			},
			cycleTab: this.cycleTab.bind(this),
			openNewTab: () => {
				void this.openNewTab().catch((error: unknown) => {
					console.error('Failed to open a new tab', error);
				});
			},
		};
	}
}


type GestureSettingRow = {
	name: string;
	desc?: string;
} & ({ render: (setting: Setting) => void | (() => void) } | { render?: never });

interface GestureSettingGroup {
	type: 'group';
	heading: string;
	items: GestureSettingRow[];
}

class GestureNavSettingTab extends PluginSettingTab {
	plugin: GestureNav;

	constructor(app: App, plugin: GestureNav) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.createSettingGroups();
	}

	// Obsidian before 1.13 calls display(); newer versions render the definitions.
	display(): void {
		this.renderLegacySettings();
	}

	private refreshSettings() {
		if (requireApiVersion('1.13.0')) {
			this.update();
		} else {
			this.renderLegacySettings();
		}
	}

	private renderLegacySettings() {
		this.containerEl.empty();
		for (const group of this.createSettingGroups()) {
			new Setting(this.containerEl).setName(group.heading).setHeading();
			for (const definition of group.items) {
				const row = new Setting(this.containerEl).setName(definition.name);
				if (definition.desc) row.setDesc(definition.desc);
				definition.render?.(row);
			}
		}
	}

	private createSettingGroups(): GestureSettingGroup[] {
		const strings = getStrings(this.plugin.settings.language);
		const appearance: GestureSettingRow[] = [
			{
				...strings.settings.language,
				render: (row) => { row.addDropdown((dropdown) => dropdown
					.addOptions({ en: getStrings('en').languageName, ko: getStrings('ko').languageName })
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value as Locale;
						await this.plugin.saveSettings();
						this.refreshSettings();
					})); },
			},
			{
				name: strings.settings.triggerKey.name,
				desc: strings.settings.triggerKey.desc,
				render: (row) => { row.addDropdown((dropdown) => dropdown
					.addOptions({ [TrigerKey.RIGHT_CLICK]: strings.settings.triggerKey.options.rightClick })
					.setValue(String(this.plugin.settings.trigerkey))
					.onChange(async (value) => {
						this.plugin.settings.trigerkey = Number(value);
						await this.plugin.saveSettings();
					})); },
			},
			{
				...strings.settings.enableDrawing,
				render: (row) => { row.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.enableDrawing)
					.onChange(async (value) => {
						this.plugin.settings.enableDrawing = value;
						await this.plugin.saveSettings();
					})); },
			},
			{
				...strings.settings.strokeColor,
				render: (row) => { row.addDropdown((dropdown) => dropdown
					.addOptions({
						accent: 'Accent color', red: 'Red', orange: 'Orange', yellow: 'Yellow',
						green: 'Green', blue: 'Blue', purple: 'Purple', custom: 'Custom',
					})
					.setValue(this.plugin.settings.strokeColor || 'accent')
					.onChange(async (value) => {
						this.plugin.settings.strokeColor = value;
						await this.plugin.saveSettings();
						this.refreshSettings();
					})); },
			},
			{
				...strings.settings.customStrokeColor,
				render: (row) => { row.addText((text) => {
					text.setPlaceholder('#000000')
						.setValue(this.plugin.settings.customStrokeColor || '')
						.onChange(async (value) => {
							this.plugin.settings.customStrokeColor = value;
							await this.plugin.saveSettings();
						});
					// The native input is available on 1.1.0; Setting.setDisabled is not.
					text.inputEl.disabled = this.plugin.settings.strokeColor !== 'custom';
				}); },
			},
			{
				...strings.settings.lineWidth,
				render: (row) => { row.addSlider((slider) => slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.lineWidth)
					.onChange(async (value) => {
						this.plugin.settings.lineWidth = value;
						await this.plugin.saveSettings();
					})); },
			},
		];

		const gestures: GestureSettingRow[] = [];
		const modernEngine = this.plugin.settings.gestureEngine === 'modern-v2';
		if (modernEngine) {
			gestures.push({
				...strings.settings.enableDiagonalGestures,
				render: (row) => { row.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.enableDiagonalGestures)
					.onChange(async (value) => {
						this.plugin.settings.enableDiagonalGestures = value;
						await this.plugin.saveSettings();
						this.refreshSettings();
					})); },
			});
		}
		gestures.push(
			{ name: '', desc: strings.gestureBindings.title },
			{
				name: strings.gestureBindings.resetName,
				desc: strings.gestureBindings.resetDesc,
				render: (row) => { row.addButton((button) => button
					.setButtonText(strings.gestureBindings.resetButton)
					.onClick(async () => {
						this.plugin.settings.gestureBindings = { ...DEFAULT_GESTURE_BINDINGS };
						await this.plugin.saveSettings();
						this.refreshSettings();
					})); },
			},
		);
		const actionOptions = ACTION_IDS.reduce((options, action) => {
			options[action] = strings.actionLabels[action];
			return options;
		}, {} as Record<string, string>);
		for (const meta of GESTURE_META) {
			if (meta.diagonal && !(modernEngine && this.plugin.settings.enableDiagonalGestures)) continue;
			const customCommand = this.plugin.settings.gestureBindings[meta.key] === 'custom-command';
			gestures.push({
				name: `${meta.icon}  ${this.plugin.getGestureLabel(meta.key)}`,
				desc: customCommand ? strings.settings.customCommandWarning : undefined,
				render: (row) => {
					row.addDropdown((dropdown) => dropdown
						.addOptions(actionOptions)
						.setValue(this.plugin.settings.gestureBindings[meta.key] ?? 'none')
						.onChange(async (value) => {
							this.plugin.settings.gestureBindings[meta.key] = value as ActionId;
							await this.plugin.saveSettings();
							this.refreshSettings();
						}));
					if (customCommand) {
						row.addText((text) => text
							.setPlaceholder('Command ID')
							.setValue(this.plugin.getCustomCommandId(meta.key))
							.onChange(async (value) => {
								this.plugin.settings.customCommandIds[meta.key] = value.trim();
								await this.plugin.saveSettings();
							}));
					}
				},
			});
		}

		const actions: GestureSettingRow[] = [
			{
				name: strings.settings.gestureEngine.name,
				desc: strings.settings.gestureEngine.desc,
				render: (row) => { row.addDropdown((dropdown) => dropdown
					.addOptions({
						'modern-v2': strings.settings.gestureEngine.options.modern,
						'legacy-v1': strings.settings.gestureEngine.options.legacy,
					})
					.setValue(this.plugin.settings.gestureEngine)
					.onChange(async (value) => {
						this.plugin.settings.gestureEngine = value as GestureEngine;
						await this.plugin.saveSettings();
						this.refreshSettings();
					})); },
			},
			{
				name: strings.settings.newTabBehavior.name,
				desc: strings.settings.newTabBehavior.desc,
				render: (row) => { row.addDropdown((dropdown) => dropdown
					.addOptions({
						empty: strings.settings.newTabBehavior.options.empty,
						current: strings.settings.newTabBehavior.options.current,
						'new-note': strings.settings.newTabBehavior.options.newNote,
					})
					.setValue(this.plugin.settings.newTabBehavior)
					.onChange(async (value) => {
						this.plugin.settings.newTabBehavior = value as NewTabBehavior;
						await this.plugin.saveSettings();
						this.refreshSettings();
					})); },
			},
			{
				...strings.settings.showContextMenuOnCancel,
				render: (row) => { row.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.showContextMenuOnCancel)
					.onChange(async (value) => {
						this.plugin.settings.showContextMenuOnCancel = value;
						await this.plugin.saveSettings();
					})); },
			},
			{
				...strings.settings.debugMode,
				render: (row) => { row.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.debugMode)
					.onChange(async (value) => {
						this.plugin.settings.debugMode = value;
						await this.plugin.saveSettings();
						this.refreshSettings();
					})); },
			},
		];
		const groups: GestureSettingGroup[] = [
			{ type: 'group', heading: strings.sections.appearance, items: appearance },
			{ type: 'group', heading: strings.sections.gestures, items: gestures },
			{ type: 'group', heading: strings.sections.actions, items: actions },
		];
		if (this.plugin.settings.debugMode) {
			groups.push({
				type: 'group',
				heading: strings.debug.commandsTitle,
				items: [
					{ name: '', desc: strings.debug.requestNote },
					{
						name: strings.debug.searchLabel,
						desc: strings.debug.searchDesc,
						render: (row) => this.renderCommandSearch(row),
					},
				],
			});
		}
		return groups;
	}

	private renderCommandSearch(searchSetting: Setting) {
		const strings = getStrings(this.plugin.settings.language);
		const parent = searchSetting.settingEl.parentElement;
		if (!parent) return;
		const resultsContainer = parent.createDiv({ cls: 'gesture-command-results' });
		const renderResults = (query: string) => {
			resultsContainer.empty();
			const q = query.trim().toLowerCase();
			const commandsApi = (this.app as App & {
				commands?: { listCommands: () => Array<{ id: string; name: string }> };
			}).commands;
			const commands = (commandsApi?.listCommands() ?? [])
				.filter((cmd) => !q || cmd.name.toLowerCase().includes(q) || cmd.id.toLowerCase().includes(q))
				.slice(0, 100);
			if (commands.length === 0) {
				resultsContainer.createDiv({ text: strings.debug.noResults, cls: 'gesture-command-empty' });
				return;
			}
			for (const cmd of commands) {
				const row = resultsContainer.createDiv({ cls: 'gesture-command-row' });
				row.createDiv({ text: cmd.id, cls: 'gesture-command-id' });
				row.createDiv({ text: cmd.name, cls: 'gesture-command-name' });
			}
		};
		searchSetting.addText((text) => text
			.setPlaceholder(strings.debug.searchPlaceholder)
			.onChange((value) => renderResults(value)));
		renderResults('');
		return () => resultsContainer.remove();
	}
}
