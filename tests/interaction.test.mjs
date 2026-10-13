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
	createElement() {
		return {
			classList: { add() {}, contains() { return false; } },
			appendChild() {}, remove() {}, closest() { return null; },
			dispatchEvent: (event) => this.dispatch(event),
		};
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
	querySelector() { return this.settingsVisible ? { style: { display: 'block' } } : null; }
	elementFromPoint() { return this.target; }
	dispatch(event) {
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

async function harness(settings = {}) {
	const doc = new MockDocument();
	const actions = [];
	const win = {
		document: doc,
		history: { back: () => actions.push('back'), forward: () => actions.push('forward') },
	};
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
		constructor() { this.app = { workspace }; }
		async loadData() { return { gestureEngine: 'modern-v2', enableDrawing: false, ...settings }; }
		register(callback) { this.disposers.push(callback); }
		registerEvent() {}
		addSettingTab() {}
		registerDomEvent(target, type, callback) {
			target.addEventListener(type, callback);
			this.register(() => target.removeEventListener(type, callback));
		}
	}
	const module = { exports: {} };
	vm.runInNewContext(outputFiles[0].text, {
		module, exports: module.exports, window: win, activeWindow: win, activeDocument: doc,
		MouseEvent: MockMouseEvent, createDiv: () => doc.createElement(), console,
		require: (name) => {
			assert.equal(name, 'obsidian');
			return { Plugin, PluginSettingTab: class {}, MarkdownView: class {}, Notice: class {} };
		},
	});
	const plugin = new module.exports.default();
	await plugin.onload();
	const trigger = settings.trigerkey ?? 2;
	const down = () => doc.trusted('mousedown', { button: trigger });
	const up = () => doc.trusted('mouseup', { button: trigger });
	const move = (clientX, clientY = 300) => doc.trusted('mousemove', { clientX, clientY });
	const gesture = () => { down(); move(180); up(); };
	const nativeMenu = () => doc.trusted('contextmenu');
	const syntheticMenus = () => doc.menus.filter((event) => !event.isTrusted);
	const openWindow = () => {
		const otherDoc = new MockDocument();
		otherDoc.defaultView = { document: otherDoc };
		workspace.onWindowOpen({ win: otherDoc.defaultView });
		return otherDoc;
	};
	const unload = () => {
		plugin.onunload();
		for (const dispose of plugin.disposers) dispose();
	};
	return { doc, workspace, actions, down, up, move, gesture, nativeMenu, syntheticMenus, openWindow, unload };
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

	test(`${engine}: mouseup in another window cannot consume the editor gesture`, async () => {
		const h = await harness({ gestureEngine: engine });
		const otherDoc = h.openWindow();
		h.down(); h.move(180);
		otherDoc.trusted('mouseup');
		assert.deepEqual(h.actions, []);
		h.up();
		assert.deepEqual(h.actions, ['back']);
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
		const h = await harness({ gestureEngine: engine });
		const otherDoc = h.openWindow();
		h.down(); h.move(180);
		otherDoc.trusted('mousedown');
		h.up();
		assert.deepEqual(h.actions, []);
		otherDoc.trusted('mousemove', { clientX: 420 });
		otherDoc.trusted('mouseup');
		assert.deepEqual(h.actions, ['forward']);
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
