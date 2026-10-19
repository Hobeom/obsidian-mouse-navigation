import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const { outputFiles } = buildSync({
	entryPoints: [fileURLToPath(new URL('../main.ts', import.meta.url))],
	bundle: true,
	write: false,
	platform: 'node',
	format: 'cjs',
	external: ['obsidian'],
});

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function harness({ behavior = 'empty', apiVersion = '1.1.13' } = {}) {
	const errors = [];
	const versionChecks = [];
	const root = { path: '' };
	const currentFile = { path: 'Notes/A.md', basename: 'A', parent: root };
	const leaf = { setViewState: async () => {} };
	const app = {
		workspace: {
			getActiveFile: () => currentFile,
			getLeaf: () => leaf,
			duplicateLeaf: async () => {},
			openLinkText: async () => {},
		},
		vault: {
			getRoot: () => root,
			getMarkdownFiles: () => [currentFile],
			getAbstractFileByPath: () => null,
			create: async (path) => ({ path }),
		},
		fileManager: { getNewFileParent: () => root },
	};
	const module = { exports: {} };
	vm.runInNewContext(outputFiles[0].text, {
		module,
		exports: module.exports,
		console: { error: (...args) => errors.push(args) },
		require: (name) => {
			assert.equal(name, 'obsidian');
			return {
				Plugin: class {},
				PluginSettingTab: class {},
				Setting: class {},
				MarkdownView: class {},
				Notice: class {},
				requireApiVersion: (required) => {
					versionChecks.push(required);
					const current = apiVersion.split('.').map(Number);
					const minimum = required.split('.').map(Number);
					for (let i = 0; i < minimum.length; i++) {
						if (current[i] !== minimum[i]) return current[i] > minimum[i];
					}
					return true;
				},
			};
		},
	});
	const plugin = new module.exports.default();
	plugin.app = app;
	plugin.settings = { newTabBehavior: behavior };
	return { plugin, app, leaf, root, currentFile, errors, versionChecks };
}

test('empty-tab route waits for setViewState before completing', async () => {
	const h = harness();
	const stateChange = deferred();
	const calls = [];
	h.app.workspace.getLeaf = (type) => { calls.push(type); return h.leaf; };
	h.leaf.setViewState = (state) => {
		assert.equal(state.type, 'empty');
		assert.equal(Object.keys(state.state).length, 0);
		return stateChange.promise;
	};
	h.app.workspace.openLinkText = () => assert.fail('successful empty-tab creation needs no fallback');
	let complete = false;
	const operation = h.plugin.openNewTab().then(() => { complete = true; });
	await nextTurn();
	assert.equal(complete, false);
	assert.deepEqual(calls, ['tab']);
	stateChange.resolve();
	await operation;
	assert.equal(complete, true);
});

for (const fallbackFails of [false, true]) {
	test(`empty-tab fallback is awaited when setViewState rejects; fallback fails=${fallbackFails}`, async () => {
		const h = harness();
		const fallback = deferred();
		const failure = new Error('fallback failed');
		const calls = [];
		h.leaf.setViewState = async () => { throw new Error('empty view unavailable'); };
		h.app.workspace.openLinkText = (...args) => { calls.push(args); return fallback.promise; };
		const operation = h.plugin.openEmptyTab();
		let complete = false;
		const observed = operation.then(
			() => { complete = true; },
			(error) => { complete = true; assert.equal(error, failure); },
		);
		await nextTurn();
		assert.deepEqual(calls, [['', '', 'tab']]);
		assert.equal(complete, false, 'the fallback must finish before openEmptyTab finishes');
		if (fallbackFails) {
			fallback.reject(failure);
			await assert.rejects(operation, (error) => error === failure);
		} else {
			fallback.resolve();
			await operation;
		}
		await observed;
		assert.equal(complete, true);
	});
}

test('current-tab route awaits duplication of the active leaf', async () => {
	const h = harness({ behavior: 'current' });
	const duplication = deferred();
	const calls = [];
	h.app.workspace.getLeaf = (type) => { assert.equal(type, false); return h.leaf; };
	h.app.workspace.duplicateLeaf = (...args) => { calls.push(args); return duplication.promise; };
	h.app.workspace.openLinkText = () => assert.fail('current-tab route must duplicate the active leaf');
	let complete = false;
	const operation = h.plugin.openNewTab().then(() => { complete = true; });
	await nextTurn();
	assert.deepEqual(calls, [[h.leaf, 'tab']]);
	assert.equal(complete, false);
	duplication.resolve();
	await operation;
	assert.equal(complete, true);
});

test('new-note route waits for file creation and for opening the created file', async () => {
	const h = harness({ behavior: 'new-note' });
	const creation = deferred();
	const opening = deferred();
	const calls = [];
	h.app.fileManager.getNewFileParent = () => ({ path: 'Notes' });
	h.app.vault.create = (...args) => { calls.push(['create', ...args]); return creation.promise; };
	h.app.workspace.openLinkText = (...args) => { calls.push(['open', ...args]); return opening.promise; };
	let complete = false;
	const operation = h.plugin.openNewTab().then(() => { complete = true; });
	await nextTurn();
	assert.deepEqual(calls, [['create', 'Notes/Untitled.md', '']]);
	assert.equal(complete, false);
	creation.resolve({ path: 'Notes/Untitled.md' });
	await nextTurn();
	assert.deepEqual(calls[1], ['open', 'Notes/Untitled.md', '', 'tab']);
	assert.equal(complete, false, 'creating a file does not complete opening its tab');
	opening.resolve();
	await operation;
	assert.equal(complete, true);
});

for (const behavior of ['empty', 'current', 'new-note']) {
	test(`gesture action catches asynchronous ${behavior} tab failure`, async () => {
		const h = harness({ behavior });
		const failure = new Error(`${behavior} tab failed`);
		const reject = async () => { throw failure; };
		h.leaf.setViewState = reject;
		h.app.workspace.duplicateLeaf = reject;
		h.app.workspace.openLinkText = reject;
		assert.equal(h.plugin.getGestureActionContext().openNewTab(), undefined);
		await nextTurn();
		assert.equal(h.errors.length, 1);
		assert.equal(h.errors[0][0], 'Failed to open a new tab');
		assert.equal(h.errors[0][1], failure);
	});
}

test('sibling action wraps to the previous note and catches an asynchronous open failure', async () => {
	const h = harness();
	const failure = new Error('note open failed');
	const calls = [];
	h.app.vault.getMarkdownFiles = () => [
		{ path: 'Other/Z.md', basename: 'Z', parent: {} },
		{ path: 'Notes/C.md', basename: 'C', parent: h.root },
		h.currentFile,
		{ path: 'Notes/B.md', basename: 'B', parent: h.root },
	];
	h.app.workspace.openLinkText = async (...args) => { calls.push(args); throw failure; };
	assert.equal(h.plugin.getGestureActionContext().navigateSibling(-1), undefined);
	await nextTurn();
	assert.deepEqual(calls, [['Notes/C.md', 'Notes/A.md', false]]);
	assert.equal(h.errors.length, 1);
	assert.equal(h.errors[0][0], 'Failed to navigate to a sibling note');
	assert.equal(h.errors[0][1], failure);
});

test('Obsidian 1.1.0 creates notes at the vault root without accessing the newer file-parent API', () => {
	const h = harness({ apiVersion: '1.1.0' });
	Object.defineProperty(h.app, 'fileManager', {
		get() { assert.fail('getNewFileParent is unavailable before 1.1.13'); },
	});
	assert.equal(h.plugin.resolveNewNoteFolder(), h.root);
	assert.deepEqual(h.versionChecks, ['1.1.13']);
});

test('Obsidian 1.1.13 resolves the configured new-note folder using the active file', () => {
	const h = harness({ apiVersion: '1.1.13' });
	const folder = { path: 'New notes' };
	h.app.fileManager.getNewFileParent = (path) => {
		assert.equal(path, h.currentFile.path);
		return folder;
	};
	h.app.vault.getRoot = () => assert.fail('supported versions must honor the configured new-note folder');
	assert.equal(h.plugin.resolveNewNoteFolder(), folder);
	assert.deepEqual(h.versionChecks, ['1.1.13']);
});
