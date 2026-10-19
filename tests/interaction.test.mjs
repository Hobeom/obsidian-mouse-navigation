import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

// Bundle the real plugin and recognizer; only the Obsidian and browser APIs are mocked.
const { outputFiles } = buildSync({
	entryPoints: [fileURLToPath(new URL('../main.ts', import.meta.url))],
	bundle: true,
	write: false,
	platform: 'node',
	format: 'cjs',
	external: ['obsidian'],
});

class MockMouseEvent {
	constructor(type, options = {}) {
		Object.assign(this, {
			type, button: 2, clientX: 300, clientY: 300,
			isTrusted: false, defaultPrevented: false, propagationStopped: false,
		}, options);
	}
	preventDefault() { this.defaultPrevented = true; }
	stopPropagation() { this.propagationStopped = true; }
}

class MockDocument {
	listeners = new Map();
	menus = [];
	settingsVisible = false;
	constructor() {
		this.body = this.createElement();
		this.target = this.createElement();
	}
	createElement(tagName = 'div') {
		const classes = new Set();
		const element = {
			tagName: tagName.toUpperCase(), ownerDocument: this, parentElement: null, children: [],
			settings: [],
			classList: { add: (...names) => names.forEach((name) => classes.add(name)), contains: (name) => classes.has(name) },
			empty() {
				for (const child of [...this.children]) child.remove();
				this.settings = [];
			},
			createEl(tag, options = {}) {
				const child = this.ownerDocument.createElement(tag);
				child.innerText = options.text ?? '';
				if (options.cls) child.classList.add(options.cls);
				this.appendChild(child);
				return child;
			},
			createDiv(options) { return this.createEl('div', options); },
			appendChild(child) {
				child.remove();
				child.parentElement = this;
				child.ownerDocument = this.ownerDocument;
				this.children.push(child);
			},
			remove() {
				if (this.parentElement) {
					this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
					this.parentElement = null;
				}
			},
			closest() { return null; },
			dispatchEvent: (event) => {
				event.target ??= element;
				return this.dispatch(event);
			},
		};
		if (tagName === 'canvas') {
			const calls = [];
			const context = Object.fromEntries(['beginPath', 'moveTo', 'lineTo', 'stroke'].map(
				(method) => [method, (...args) => calls.push([method, ...args])],
			));
			context.calls = calls;
			element.getContext = (kind) => kind === '2d' ? context : null;
		}
		return element;
	}
	addEventListener(type, callback, capture = false) {
		const listeners = this.listeners.get(type) ?? [];
		if (!listeners.some((entry) => entry.callback === callback && entry.capture === capture)) {
			listeners.push({ callback, capture });
		}
		this.listeners.set(type, listeners);
	}
	removeEventListener(type, callback, capture = false) {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter(
			(entry) => entry.callback !== callback || entry.capture !== capture,
		));
	}
	querySelector(selector) {
		if (selector === '.modal-container') return this.settingsVisible ? { style: { display: 'block' } } : null;
		const find = (element) => element.classList.contains(selector.slice(1)) ? element
			: element.children.map(find).find(Boolean);
		return find(this.body) ?? null;
	}
	elementFromPoint() { return this.target; }
	dispatch(event) {
		this.beforeDispatch?.();
		event.target ??= this.target;
		event.view ??= this.defaultView;
		for (const { callback } of [...(this.listeners.get(event.type) ?? [])]) callback(event);
		if (event.type === 'contextmenu') this.menus.push(event);
		return !event.defaultPrevented;
	}
	trusted(type, options = {}) {
		const event = new MockMouseEvent(type, { isTrusted: true, ...options });
		this.dispatch(event);
		return event;
	}
}

async function harness(settings = {}, { storedData, apiVersion = '1.1.0', availableCommands = [] } = {}) {
	const doc = new MockDocument();
	const actions = [];
	const commands = [];
	const savedData = [];
	let settingsTab;
	const makeWindow = (document) => ({
		document, innerWidth: 1024, innerHeight: 768,
		getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
		history: { back: () => actions.push('back'), forward: () => actions.push('forward') },
	});
	const win = makeWindow(doc);
	doc.defaultView = win;
	const workspace = {
		mode: 'source',
		on(name, callback) { if (name === 'window-open') this.onWindowOpen = callback; },
		getActiveViewOfType() {
			return this.mode === null ? null : {
				getMode: () => this.mode, editor: {}, previewMode: {},
			};
		},
	};
	class Plugin {
		disposers = [];
		constructor() {
			this.app = { workspace, commands: {
				executeCommandById: (id) => commands.push(id),
				listCommands: () => availableCommands,
			} };
		}
		async loadData() {
			return storedData === undefined ? { gestureEngine: 'modern-v2', enableDrawing: false, ...settings } : storedData;
		}
		async saveData(data) { savedData.push(JSON.parse(JSON.stringify(data))); }
		register(callback) { this.disposers.push(callback); }
		registerEvent() {}
		addSettingTab(tab) { settingsTab = tab; }
		registerDomEvent(target, type, callback) {
			target.addEventListener(type, callback);
			this.register(() => target.removeEventListener(type, callback));
		}
	}
	class PluginSettingTab {
		constructor(app) { this.app = app; this.containerEl = doc.createElement(); }
	}
	const requireApiVersion = (minimum) => {
		const current = apiVersion.split('.').map(Number);
		const expected = minimum.split('.').map(Number);
		for (let i = 0; i < expected.length; i++) {
			if (current[i] !== expected[i]) return current[i] > expected[i];
		}
		return true;
	};
	if (requireApiVersion('1.13.0')) {
		PluginSettingTab.prototype.update = function () {
			this.updateCalls = (this.updateCalls ?? 0) + 1;
			const previousRows = this.renderedRows ?? new Map();
			this.renderedRows = new Map();
			this.containerEl.settings = [];
			this.settingItems = this.getSettingDefinitions();
			for (const group of this.settingItems) {
				new Setting(this.containerEl).setName(group.heading).setHeading();
				for (const definition of group.items) {
					// Modern Obsidian requires an explicit renderer for unnamed informational rows.
					if (!definition.name && !definition.render) continue;
					const key = `${group.heading}:${definition.name}`;
					const previous = previousRows.get(key);
					const row = previous?.row ?? new Setting(doc.createElement());
					if (previous) {
						previous.cleanup?.();
						row.clear();
						previousRows.delete(key);
					}
					row.setName(definition.name).setDesc(definition.desc ?? '');
					const cleanup = definition.render?.(row, {});
					this.renderedRows.set(key, { row, cleanup });
					// Only settingEl is retained; siblings added to the temporary parent are discarded.
					this.containerEl.appendChild(row.settingEl);
					this.containerEl.settings.push(row);
				}
			}
			for (const previous of previousRows.values()) previous.cleanup?.();
			const retained = new Set(this.containerEl.settings.map((row) => row.settingEl));
			for (const child of [...this.containerEl.children]) {
				if (!retained.has(child)) child.remove();
			}
		};
	}
	class Setting {
		controls = [];
		constructor(container) {
			container.settings.push(this);
			this.settingEl = container.createDiv();
			this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
			this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
		}
		setName(name) { this.name = name; return this; }
		setDesc(desc) { this.desc = desc; return this; }
		setClass(cls) { this.settingEl.classList.add(cls); return this; }
		setHeading() { this.heading = true; return this; }
		clear() { this.controlEl.empty(); this.controls = []; return this; }
		addControl(kind, configure) {
			const control = {
				kind, options: {}, inputEl: { disabled: false },
				addOptions(options) { Object.assign(this.options, options); return this; },
				setValue(value) { this.value = value; return this; },
				setPlaceholder(value) { this.placeholder = value; return this; },
				setLimits() { return this; },
				setButtonText(value) { this.text = value; return this; },
				onChange(callback) { this.callback = callback; return this; },
				onClick(callback) { this.callback = callback; return this; },
				async change(value) { this.value = value; await this.callback(value); },
			};
			this.controls.push(control);
			configure(control);
			return this;
		}
		addDropdown(configure) { return this.addControl('dropdown', configure); }
		addToggle(configure) { return this.addControl('toggle', configure); }
		addText(configure) { return this.addControl('text', configure); }
		addSlider(configure) { return this.addControl('slider', configure); }
		addButton(configure) { return this.addControl('button', configure); }
	}
	const module = { exports: {} };
	const runtime = {
		module, exports: module.exports, window: win, activeWindow: win, activeDocument: doc,
		MouseEvent: MockMouseEvent, createDiv: () => runtime.activeDocument.createElement(),
		createEl: (tagName) => runtime.activeDocument.createElement(tagName), console,
		require: (name) => {
			assert.equal(name, 'obsidian');
			return { Plugin, PluginSettingTab, Setting, requireApiVersion, MarkdownView: class {}, Notice: class {} };
		},
	};
	const trackActiveDocument = (document) => {
		document.beforeDispatch = () => {
			runtime.activeDocument = document;
			runtime.activeWindow = document.defaultView;
		};
	};
	trackActiveDocument(doc);
	vm.runInNewContext(outputFiles[0].text, runtime);
	const plugin = new module.exports.default();
	await plugin.onload();
	const trigger = plugin.settings.trigerkey;
	const down = () => doc.trusted('mousedown', { button: trigger });
	const up = () => doc.trusted('mouseup', { button: trigger });
	const move = (clientX, clientY = 300) => doc.trusted('mousemove', { clientX, clientY });
	const gesture = () => { down(); move(180); up(); };
	const nativeMenu = () => doc.trusted('contextmenu');
	const syntheticMenus = () => doc.menus.filter((event) => !event.isTrusted);
	const openWindow = () => {
		const otherDoc = new MockDocument();
		otherDoc.defaultView = makeWindow(otherDoc);
		trackActiveDocument(otherDoc);
		workspace.onWindowOpen({ win: otherDoc.defaultView });
		return otherDoc;
	};
	const unload = () => {
		plugin.onunload();
		for (const dispose of plugin.disposers) dispose();
	};
	const settingRows = () => settingsTab.containerEl.settings;
	const showSettings = () => requireApiVersion('1.13.0') ? settingsTab.update() : settingsTab.display();
	return {
		doc, workspace, plugin, actions, commands, savedData, down, up, move, gesture,
		nativeMenu, syntheticMenus, openWindow, unload, settingRows, showSettings, settingsTab,
	};
}

for (const engine of ['modern-v2', 'legacy-v1']) {
	test(`${engine}: a gesture runs once and suppresses the native menu`, async () => {
		const h = await harness({ gestureEngine: engine });
		h.gesture();
		assert.deepEqual(h.actions, ['back']);
		assert.equal(h.nativeMenu().defaultPrevented, true);
		assert.equal(h.syntheticMenus().length, 0);
	});

	test(`${engine}: a stationary editor click opens exactly one synthetic menu`, async () => {
		const h = await harness({ gestureEngine: engine });
		h.down(); h.up();
		assert.deepEqual(h.actions, []);
		assert.equal(h.syntheticMenus().length, 1);
		assert.equal(h.syntheticMenus()[0].defaultPrevented, false);
		assert.equal(h.nativeMenu().defaultPrevented, true);
	});

	test(`${engine}: editor gesture then stationary non-Markdown click does not replay`, async () => {
		const h = await harness({ gestureEngine: engine });
		h.gesture();
		h.workspace.mode = null;
		h.down(); h.up();
		assert.deepEqual(h.actions, ['back'], 'UI mouseup must not replay the previous gesture');
		assert.equal(h.nativeMenu().defaultPrevented, false, 'UI context menu must remain native');
		assert.equal(h.syntheticMenus().length, 0);
		h.workspace.mode = 'source';
		h.down(); h.move(420); h.up();
		assert.deepEqual(h.actions, ['back', 'forward'], 'editor gestures must still work after UI clicks');
	});

	test(`${engine}: a sidebar click with Markdown still active opens one menu without replay`, async () => {
		const h = await harness({ gestureEngine: engine });
		h.gesture();
		const sidebarLeaf = {
			classList: { contains: (name) => name === 'workspace-leaf' },
		};
		const sidebarItem = h.doc.createElement();
		sidebarItem.className = 'nav-folder-title';
		sidebarItem.closest = (selector) => selector === '.workspace-leaf' ? sidebarLeaf : null;
		h.doc.target = sidebarItem;
		h.workspace.mode = 'source';
		h.down();
		// Exercise a native contextmenu arriving before mouseup, as on macOS.
		h.nativeMenu();
		h.up();
		assert.deepEqual(h.actions, ['back'], 'a sidebar click must not replay the editor gesture');
		const deliveredMenus = h.doc.menus.filter((event) => !event.defaultPrevented);
		assert.equal(deliveredMenus.length, 1, 'the sidebar must receive exactly one unsuppressed menu event');
		assert.equal(deliveredMenus[0].target, sidebarItem, 'the menu must target the clicked sidebar item');
	});

	test(`${engine}: a preview click keeps its native menu without synthesizing another`, async () => {
		const h = await harness({ gestureEngine: engine });
		h.gesture();
		h.workspace.mode = 'preview';
		h.down(); h.up();
		assert.deepEqual(h.actions, ['back']);
		assert.equal(h.nativeMenu().defaultPrevented, false);
		assert.equal(h.syntheticMenus().length, 0);
	});

	test(`${engine}: stray trigger mouseup cannot finish the previous interaction twice`, async () => {
		const h = await harness({ gestureEngine: engine });
		h.gesture(); h.up();
		assert.deepEqual(h.actions, ['back']);
		assert.equal(h.syntheticMenus().length, 0);
	});

	test(`${engine}: clicks ignored in settings preserve the native menu and do not replay`, async () => {
		const h = await harness({ gestureEngine: engine });
		h.gesture();
		h.doc.settingsVisible = true;
		h.down(); h.up();
		assert.deepEqual(h.actions, ['back']);
		assert.equal(h.nativeMenu().defaultPrevented, false);
		assert.equal(h.syntheticMenus().length, 0);
	});

	test(`${engine}: releasing a non-trigger button does not finish a gesture`, async () => {
		const h = await harness({ gestureEngine: engine });
		h.down(); h.move(180);
		h.doc.trusted('mouseup', { button: 0 });
		assert.deepEqual(h.actions, []);
		h.up();
		assert.deepEqual(h.actions, ['back']);
	});

	test(`${engine}: middle-button gestures also require a matching trigger press`, async () => {
		const h = await harness({ gestureEngine: engine, trigerkey: 1 });
		h.doc.trusted('mousedown', { button: 2 });
		h.move(180);
		h.doc.trusted('mouseup', { button: 2 });
		assert.deepEqual(h.actions, []);
		h.gesture();
		h.workspace.mode = null;
		h.down(); h.up();
		assert.deepEqual(h.actions, ['back']);
	});

	test(`${engine}: trigger release in another window cancels and cleans up the source gesture`, async () => {
		const h = await harness({ gestureEngine: engine, enableDrawing: true });
		const otherDoc = h.openWindow();
		h.down(); h.move(180);
		const canvas = h.doc.querySelector('.gesture-canvas');
		assert.ok(canvas, 'the source gesture must draw a canvas');
		assert.ok(h.doc.querySelector('.gesture-overlay'), 'the source gesture must display its recognized direction');
		const drawCalls = canvas.getContext('2d').calls;
		assert.ok(drawCalls.some(([method]) => method === 'stroke'));
		const drawnBeforeRelease = drawCalls.length;
		assert.equal(h.nativeMenu().defaultPrevented, true);
		otherDoc.trusted('mouseup');
		assert.deepEqual(h.actions, []);
		assert.equal(h.doc.querySelector('.gesture-canvas'), null, 'foreign release must remove the source canvas');
		assert.equal(h.doc.querySelector('.gesture-overlay'), null, 'foreign release must remove the source overlay');
		assert.equal(h.nativeMenu().defaultPrevented, false, 'foreign release must remove the source menu blocker');
		assert.equal(otherDoc.trusted('contextmenu').defaultPrevented, false);
		h.move(100);
		h.up();
		assert.equal(drawCalls.length, drawnBeforeRelease, 'later source movement must not extend the abandoned stroke');
		assert.deepEqual(h.actions, [], 'later source events must not revive the abandoned gesture');
		assert.equal(h.syntheticMenus().length, 0);
		h.gesture();
		assert.deepEqual(h.actions, ['back']);
		assert.equal(h.doc.querySelector('.gesture-canvas'), null);
		assert.equal(h.doc.querySelector('.gesture-overlay'), null);
	});

	test(`${engine}: a foreign non-trigger release preserves the source gesture`, async () => {
		const h = await harness({ gestureEngine: engine, enableDrawing: true });
		const otherDoc = h.openWindow();
		h.down(); h.move(180);
		const canvas = h.doc.querySelector('.gesture-canvas');
		const overlay = h.doc.querySelector('.gesture-overlay');
		assert.ok(canvas);
		assert.ok(overlay);
		const drawCalls = canvas.getContext('2d').calls;
		const drawnBeforeRelease = drawCalls.length;
		otherDoc.trusted('mouseup', { button: 0 });
		assert.deepEqual(h.actions, []);
		assert.equal(h.doc.querySelector('.gesture-canvas'), canvas);
		assert.equal(h.doc.querySelector('.gesture-overlay'), overlay);
		assert.equal(h.nativeMenu().defaultPrevented, true);
		h.move(150);
		assert.ok(drawCalls.length > drawnBeforeRelease, 'the original drag must continue drawing');
		h.up();
		assert.deepEqual(h.actions, ['back']);
		assert.equal(h.doc.querySelector('.gesture-canvas'), null);
		assert.equal(h.doc.querySelector('.gesture-overlay'), null);
	});

	test(`${engine}: mousemove in another window cannot create a gesture`, async () => {
		const h = await harness({ gestureEngine: engine });
		const otherDoc = h.openWindow();
		h.down();
		otherDoc.trusted('mousemove', { clientX: 180 });
		h.up();
		assert.deepEqual(h.actions, []);
		assert.equal(h.syntheticMenus().length, 1);
	});

	test(`${engine}: a new trigger press replaces an unfinished gesture in another window`, async () => {
		const h = await harness({ gestureEngine: engine, enableDrawing: true });
		const otherDoc = h.openWindow();
		h.down(); h.move(180);
		const oldCanvas = h.doc.querySelector('.gesture-canvas');
		assert.ok(oldCanvas);
		assert.ok(h.doc.querySelector('.gesture-overlay'));
		const oldDrawCalls = oldCanvas.getContext('2d').calls;
		const oldDrawCount = oldDrawCalls.length;
		assert.equal(h.nativeMenu().defaultPrevented, true);
		otherDoc.trusted('mousedown');
		assert.deepEqual(h.actions, []);
		assert.equal(h.doc.querySelector('.gesture-canvas'), null, 'a replacement press must remove the old canvas');
		assert.equal(h.doc.querySelector('.gesture-overlay'), null, 'a replacement press must remove the old overlay');
		assert.equal(h.nativeMenu().defaultPrevented, false, 'a replacement press must remove the old document blocker');
		assert.ok(otherDoc.querySelector('.gesture-canvas'), 'the new document must own the replacement stroke');
		otherDoc.trusted('mousemove', { clientX: 420 });
		otherDoc.trusted('mouseup');
		assert.deepEqual(h.actions, ['forward']);
		assert.equal(oldDrawCalls.length, oldDrawCount);
		assert.equal(otherDoc.querySelector('.gesture-canvas'), null);
		assert.equal(otherDoc.querySelector('.gesture-overlay'), null);
	});

	test(`${engine}: unloading removes a lingering native context-menu blocker`, async () => {
		const h = await harness({ gestureEngine: engine });
		h.gesture();
		assert.equal(h.nativeMenu().defaultPrevented, true);
		h.unload();
		assert.equal(h.nativeMenu().defaultPrevented, false);
	});
}

for (const showContextMenuOnCancel of [false, true]) {
	test(`modern-v2: cancelled gestures respect showContextMenuOnCancel=${showContextMenuOnCancel}`, async () => {
		const h = await harness({ showContextMenuOnCancel });
		h.down(); h.move(180); h.move(180, 420); h.move(300, 420); h.up();
		assert.deepEqual(h.actions, []);
		assert.equal(h.syntheticMenus().length, showContextMenuOnCancel ? 1 : 0);
		h.gesture();
		assert.deepEqual(h.actions, ['back'], 'the next gesture must recover from cancellation');
	});
}

const diagonalCases = [
	{ key: 'up-right', point: [420, 180], icon: '↗', label: 'Reload app', action: 'refresh-app', command: 'app:reload' },
	{ key: 'down-left', point: [180, 420], icon: '↙', label: 'Reopen closed tab', action: 'reopen-closed-tab', command: 'workspace:undo-close-pane' },
	{ key: 'down-right', point: [420, 420], icon: '↘', label: 'Next page', action: 'navigate-forward', history: 'forward' },
	{ key: 'up-left', point: [180, 180], icon: '↖', label: 'Previous page', action: 'navigate-back', history: 'back' },
];

function settingRow(h, name) {
	const row = h.settingRows().find((entry) => entry.name === name);
	assert.ok(row, `missing setting: ${name}`);
	return row;
}

function diagonalRows(h) {
	return h.settingRows().filter((row) => diagonalCases.some(({ icon }) => row.name.startsWith(icon)));
}

function descendantsWithClass(element, className) {
	return element.children.flatMap((child) => [
		...(child.classList.contains(className) ? [child] : []),
		...descendantsWithClass(child, className),
	]);
}

for (const diagonal of diagonalCases) {
	test(`modern-v2: enabled ${diagonal.key} shows its overlay and executes its default once`, async () => {
		const h = await harness({ enableDiagonalGestures: true, enableDrawing: true });
		h.down(); h.move(...diagonal.point);
		const overlay = h.doc.querySelector('.gesture-overlay');
		assert.ok(overlay);
		assert.deepEqual(overlay.children.map((child) => child.innerText), [diagonal.icon, diagonal.label]);
		assert.deepEqual(h.commands, [], 'recognition must not run an action until release');
		assert.deepEqual(h.actions, []);
		h.up(); h.up();
		assert.deepEqual(h.commands, diagonal.command ? [diagonal.command] : []);
		assert.deepEqual(h.actions, diagonal.history ? [diagonal.history] : []);
		assert.equal(h.nativeMenu().defaultPrevented, true);
		assert.equal(h.syntheticMenus().length, 0);
		assert.equal(h.doc.querySelector('.gesture-overlay'), null);
		assert.equal(h.doc.querySelector('.gesture-canvas'), null);
	});
}

test('modern-v2: diagonals default off and keep the previous cardinal interpretation', async () => {
	const h = await harness({ gestureBindings: { up: 'navigate-back' } });
	assert.equal(h.plugin.settings.enableDiagonalGestures, false);
	h.down(); h.move(420, 180); h.up();
	assert.deepEqual(h.actions, ['back']);
	assert.deepEqual(h.commands, [], 'an opt-out diagonal must not reload the app');
});

test('legacy-v1: a saved diagonal preference does not enable diagonal recognition', async () => {
	const h = await harness({ gestureEngine: 'legacy-v1', enableDiagonalGestures: true });
	h.down(); h.move(420, 180); h.up();
	assert.deepEqual(h.actions, []);
	assert.deepEqual(h.commands, []);
	assert.equal(h.syntheticMenus().length, 1);
	h.gesture();
	assert.deepEqual(h.actions, ['back'], 'existing legacy cardinal gestures must still work');
});

test('settings: new and upgraded installations opt out while preserving existing bindings', async () => {
	const fresh = await harness({}, { storedData: null });
	assert.equal(fresh.plugin.settings.gestureEngine, 'modern-v2');
	assert.equal(fresh.plugin.settings.enableDiagonalGestures, false);
	for (const { key, action } of diagonalCases) {
		assert.equal(fresh.plugin.settings.gestureBindings[key], action);
	}
	const h = await harness({}, { storedData: {
		gestureEngine: 'modern-v2', enableDrawing: false,
		gestureBindings: { left: 'custom-command', 'up-right': 'none' },
		customCommandIds: { left: 'editor:undo' },
	} });
	assert.equal(h.plugin.settings.enableDiagonalGestures, false);
	assert.equal(h.plugin.settings.gestureBindings.left, 'custom-command');
	assert.equal(h.plugin.settings.customCommandIds.left, 'editor:undo');
	assert.equal(h.plugin.settings.gestureBindings['up-right'], 'none');
	assert.equal(h.plugin.settings.gestureBindings['down-left'], 'reopen-closed-tab');
	h.gesture();
	assert.deepEqual(h.commands, ['editor:undo']);
	await h.plugin.saveSettings();
	const reloaded = await harness({}, { storedData: h.savedData.at(-1) });
	assert.equal(reloaded.plugin.settings.enableDiagonalGestures, false);
	assert.equal(reloaded.plugin.settings.gestureBindings['up-right'], 'none');
	assert.equal(reloaded.plugin.settings.customCommandIds.left, 'editor:undo');
	const oldLegacy = await harness({}, { storedData: { enableDrawing: false } });
	assert.equal(oldLegacy.plugin.settings.gestureEngine, 'legacy-v1');
	assert.equal(oldLegacy.plugin.settings.enableDiagonalGestures, false);
});

test('modern-v2: each diagonal accepts an overridden action, including none and custom commands', async () => {
	const h = await harness({
		enableDiagonalGestures: true,
		gestureBindings: {
			'up-right': 'none', 'down-left': 'custom-command',
			'down-right': 'navigate-back', 'up-left': 'undo',
		},
		customCommandIds: { 'down-left': 'daily-notes:goto-today' },
	});
	for (const { point } of diagonalCases) {
		h.down(); h.move(...point); h.up();
	}
	assert.deepEqual(h.actions, ['back']);
	assert.deepEqual(h.commands, ['daily-notes:goto-today', 'editor:undo']);
	assert.equal(h.syntheticMenus().length, 0, 'an intentional None binding must not open a menu');
});

for (const apiVersion of ['1.1.0', '1.14.4']) {
test(`settings: Obsidian ${apiVersion} diagonal selectors rerender, retain mappings, and apply toggles without restarting`, async () => {
	const h = await harness({ gestureBindings: { up: 'navigate-back' } }, { apiVersion });
	h.showSettings();
	assert.equal(settingRow(h, 'Enable diagonal gestures').controls[0].value, false);
	assert.equal(diagonalRows(h).length, 0);
	await settingRow(h, 'Enable diagonal gestures').controls[0].change(true);
	assert.equal(diagonalRows(h).length, 4, 'enabling must immediately render every diagonal selector');
	assert.equal(h.savedData.at(-1).enableDiagonalGestures, true);
	const cardinalOptions = settingRow(h, '←  Left').controls[0].options;
	for (const row of diagonalRows(h)) {
		assert.deepEqual(row.controls[0].options, cardinalOptions, 'diagonals must offer all existing actions');
		assert.ok(Object.hasOwn(row.controls[0].options, 'none'));
		assert.ok(Object.hasOwn(row.controls[0].options, 'custom-command'));
	}
	await settingRow(h, '↗  Up-right diagonal').controls[0].change('custom-command');
	const customField = settingRow(h, '↗  Up-right diagonal').controls.find((control) => control.kind === 'text');
	assert.ok(customField, 'choosing a custom command must immediately expose its ID field');
	await customField.change('  editor:undo  ');
	assert.equal(h.savedData.at(-1).customCommandIds['up-right'], 'editor:undo');
	h.down(); h.move(420, 180); h.up();
	assert.deepEqual(h.commands, ['editor:undo'], 'enabling must affect the very next gesture');

	await settingRow(h, 'Enable diagonal gestures').controls[0].change(false);
	assert.equal(diagonalRows(h).length, 0);
	h.down(); h.move(420, 180); h.up();
	assert.deepEqual(h.actions, ['back'], 'disabling must restore cardinal recognition immediately');
	assert.deepEqual(h.commands, ['editor:undo']);
	await settingRow(h, 'Enable diagonal gestures').controls[0].change(true);
	assert.equal(settingRow(h, '↗  Up-right diagonal').controls[0].value, 'custom-command');
	assert.equal(settingRow(h, '↗  Up-right diagonal').controls[1].value, 'editor:undo');

	await settingRow(h, 'Gesture engine').controls[0].change('legacy-v1');
	assert.equal(diagonalRows(h).length, 0, 'legacy settings must hide the diagonal selectors');
	assert.equal(h.settingRows().some((row) => row.name === 'Enable diagonal gestures'), false);
	assert.equal(h.plugin.settings.enableDiagonalGestures, true, 'switching engines must preserve the preference');
	h.down(); h.move(420, 180); h.up();
	assert.deepEqual(h.commands, ['editor:undo']);
	await settingRow(h, 'Gesture engine').controls[0].change('modern-v2');
	assert.equal(settingRow(h, 'Enable diagonal gestures').controls[0].value, true);
	assert.equal(diagonalRows(h).length, 4);
	assert.equal(settingRow(h, '↗  Up-right diagonal').controls[0].value, 'custom-command');
	h.down(); h.move(420, 180); h.up();
	assert.deepEqual(h.commands, ['editor:undo', 'editor:undo']);
	const reloaded = await harness({}, { storedData: h.savedData.at(-1) });
	reloaded.down(); reloaded.move(420, 180); reloaded.up();
	assert.deepEqual(reloaded.commands, ['editor:undo'], 'the enabled preference and custom mapping must survive reload');
});

test(`settings: Obsidian ${apiVersion} preserves input disabling, reset, locale and debug controls`, async () => {
	const h = await harness({}, { apiVersion, availableCommands: [
		{ id: 'editor:undo', name: 'Undo' },
		{ id: 'app:reload', name: 'Reload app' },
	] });
	h.showSettings();
	assert.equal(settingRow(h, 'Custom stroke color').controls[0].inputEl.disabled, true);
	await settingRow(h, 'Stroke color').controls[0].change('custom');
	assert.equal(settingRow(h, 'Custom stroke color').controls[0].inputEl.disabled, false);
	await settingRow(h, 'Custom stroke color').controls[0].change('#123456');
	assert.equal(h.savedData.at(-1).customStrokeColor, '#123456');
	await settingRow(h, 'Stroke color').controls[0].change('accent');
	assert.equal(settingRow(h, 'Custom stroke color').controls[0].inputEl.disabled, true);
	assert.equal(settingRow(h, 'Custom stroke color').controls[0].value, '#123456');

	await settingRow(h, '←  Left').controls[0].change('none');
	await settingRow(h, 'Reset gesture bindings').controls[0].change();
	assert.equal(settingRow(h, '←  Left').controls[0].value, 'navigate-back');
	await settingRow(h, 'Debug mode').controls[0].change(true);
	const containers = () => descendantsWithClass(h.settingsTab.containerEl, 'gesture-command-results');
	assert.equal(containers().length, 1);
	assert.ok(containers()[0].parentElement === settingRow(h, 'Search commands').controlEl,
		'command results must stay inside the control element retained by the host renderer');
	assert.equal(containers()[0].children.length, 2);
	await settingRow(h, 'Search commands').controls[0].change('undo');
	assert.equal(containers()[0].children.length, 1);
	assert.equal(containers()[0].children[0].children[0].innerText, 'editor:undo');
	await settingRow(h, 'Search commands').controls[0].change('missing');
	assert.equal(containers()[0].children[0].innerText, 'No commands found');
	await settingRow(h, 'Language').controls[0].change('ko');
	assert.equal(settingRow(h, '언어').controls[0].value, 'ko');
	assert.equal(containers().length, 1, 'refresh must not leave duplicate command results');
	await settingRow(h, '디버그 모드').controls[0].change(false);
	assert.equal(containers().length, 0);
	assert.equal(h.settingRows().some((row) => row.name === '명령 검색'), false);
	assert.equal(h.settingRows().filter((row) => row.heading).length, 3);
});

test(`settings: Obsidian ${apiVersion} keeps localized guidance rows visible`, async () => {
	const h = await harness({ debugMode: true }, { apiVersion });
	h.showSettings();
	const descriptions = () => h.settingRows().filter((row) => !row.name).map((row) => row.desc);
	assert.deepEqual(descriptions(), [
		'Customize actions for each gesture. You can reset to defaults anytime.',
		'Need more commands? Please open an issue with your request.',
	]);
	await settingRow(h, 'Language').controls[0].change('ko');
	assert.deepEqual(descriptions(), [
		'각 제스처에 매핑할 액션을 선택하세요. 언제든 기본값으로 되돌릴 수 있습니다.',
		'필요한 기능이 있으면 이슈에 요청해 주세요.',
	]);
	assert.equal(descendantsWithClass(h.settingsTab.containerEl, 'gesture-command-empty')[0].innerText,
		'명령이 없습니다', 'an empty command list must remain visible after a locale refresh');
});

test(`settings: Obsidian ${apiVersion} keeps command results live across repeated structural updates`, async () => {
	const h = await harness({ debugMode: true }, { apiVersion, availableCommands: [
		{ id: 'editor:undo', name: 'Undo' },
		{ id: 'workspace:close', name: 'Close current tab' },
	] });
	h.showSettings();
	const containers = () => descendantsWithClass(h.settingsTab.containerEl, 'gesture-command-results');
	assert.equal(containers().length, 1);
	const initialSearch = settingRow(h, 'Search commands');
	for (const enabled of [true, false, true]) {
		await settingRow(h, 'Enable diagonal gestures').controls[0].change(enabled);
		if (apiVersion !== '1.1.0') {
			assert.ok(settingRow(h, 'Search commands') === initialSearch,
				'the modern renderer must exercise the existing Setting instance during updates');
		}
		assert.equal(containers().length, 1, 'a structural update must retain exactly one results container');
		assert.equal(containers()[0].children.length, 2);
		await settingRow(h, 'Search commands').controls[0].change('workspace:close');
		assert.equal(containers()[0].children.length, 1);
		assert.equal(containers()[0].children[0].children[0].innerText, 'workspace:close');
		await settingRow(h, 'Search commands').controls[0].change('missing');
		assert.equal(containers()[0].children[0].innerText, 'No commands found');
	}
});
}

test('settings: modern definitions expose every setting to search and update after structural changes', async () => {
	const h = await harness({}, { apiVersion: '1.14.4' });
	const definitions = () => h.settingsTab.getSettingDefinitions().flatMap((group) => group.items);
	const namedDefinitions = () => definitions().filter((definition) => definition.name);
	const controls = () => h.settingRows().filter((row) => row.controls.length);
	assert.ok(namedDefinitions().length > 20, 'definitions must contain actual settings before opening the tab');
	h.showSettings();
	const names = Array.from(namedDefinitions(), (definition) => definition.name);
	assert.deepEqual(controls().map((row) => row.name), names);
	assert.ok(definitions().find((definition) => definition.name === 'Enable diagonal gestures').desc.includes('off by default'));
	assert.ok(namedDefinitions().every((definition) => typeof definition.render === 'function'));
	const before = h.settingsTab.updateCalls;
	await settingRow(h, 'Enable diagonal gestures').controls[0].change(true);
	assert.ok(h.settingsTab.updateCalls > before, 'modern refresh must use update()');
	assert.equal(h.settingsTab.settingItems.flatMap((group) => group.items).filter((definition) => /diagonal$/.test(definition.name)).length, 4);
	await settingRow(h, '↗  Up-right diagonal').controls[0].change('custom-command');
	assert.ok(definitions().find((definition) => definition.name === '↗  Up-right diagonal').desc.includes('Custom commands'));
	await settingRow(h, 'Gesture engine').controls[0].change('legacy-v1');
	assert.equal(definitions().filter((definition) => /diagonal/.test(definition.name)).length, 0);
});

test('modern-v2: enabled diagonals preserve a long cardinal leg followed by a two-step turn', async () => {
	const h = await harness({
		enableDiagonalGestures: true,
		gestureBindings: { 'right,up': 'custom-command' },
		customCommandIds: { 'right,up': 'test:two-step' },
	});
	h.down(); h.move(380); h.move(600); h.move(600, 180); h.up();
	assert.deepEqual(h.commands, ['test:two-step']);
	assert.deepEqual(h.actions, []);
});

for (const showContextMenuOnCancel of [false, true]) {
	test(`modern-v2: unsupported diagonal combinations cancel with menu preference ${showContextMenuOnCancel}`, async () => {
		for (const points of [
			[[420, 180], [540, 180]],
			[[420, 300], [540, 180]],
			[[420, 180], [540, 300]],
		]) {
			const h = await harness({ enableDiagonalGestures: true, showContextMenuOnCancel });
			h.down();
			for (const point of points) h.move(...point);
			const overlay = h.doc.querySelector('.gesture-overlay');
			assert.ok(overlay);
			assert.deepEqual(overlay.children.map((child) => child.innerText), ['✕', 'Cancel']);
			h.up();
			assert.deepEqual(h.commands, [], 'a canceled combination must not execute its first diagonal');
			assert.deepEqual(h.actions, []);
			assert.equal(h.syntheticMenus().length, showContextMenuOnCancel ? 1 : 0);
			h.down(); h.move(420, 180); h.up();
			assert.deepEqual(h.commands, ['app:reload'], 'a fresh diagonal must recover from cancellation');
		}
	});
}

test('modern-v2: a diagonal cannot replay on a stationary editor or non-Markdown click', async () => {
	const h = await harness({ enableDiagonalGestures: true });
	h.down(); h.move(420, 180); h.up();
	h.down(); h.up();
	assert.deepEqual(h.commands, ['app:reload']);
	assert.equal(h.syntheticMenus().length, 1);
	h.workspace.mode = null;
	h.down(); h.up();
	assert.deepEqual(h.commands, ['app:reload']);
	assert.equal(h.nativeMenu().defaultPrevented, false);
	h.workspace.mode = 'source';
	h.gesture();
	assert.deepEqual(h.actions, ['back']);
});
