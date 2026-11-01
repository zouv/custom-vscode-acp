import * as assert from 'assert';
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ConnectionInfo } from '../core/ConnectionManager';
import { ConnectionManager } from '../core/ConnectionManager';
import { AgentManager } from '../core/AgentManager';
import { SessionManager, type SessionInfo, type AgentCapabilitySummary } from '../core/SessionManager';
import { SessionHistoryStore } from '../core/SessionHistoryStore';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { TerminalHandler } from '../handlers/TerminalHandler';
import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { BoundedLogWriter } from '../utils/BoundedLogWriter';
import { parseRegistry, fetchRegistry, clearRegistryCache } from '../config/RegistryClient';
import { TerminalAuthHandler, terminalAuthOptions } from '../handlers/TerminalAuthHandler';
import { terminateProcess } from '../utils/ProcessLifecycle';
import { panelIdForAgent } from '../ui/chat/panelContract';
import { domClient } from '../ui/chat/html/client/dom';
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';

class Memento implements vscode.Memento {
  readonly data = new Map<string, unknown>();
  keys(): readonly string[] { return Array.from(this.data.keys()); }
  get<T>(key: string, fallback?: T): T { return (this.data.get(key) ?? fallback) as T; }
  update(key: string, value: unknown): Promise<void> { this.data.set(key, value); return Promise.resolve(); }
}

function managerHarness(terminalAuth?: Pick<TerminalAuthHandler, 'authenticate' | 'dispose'>) {
  const updates = new SessionUpdateHandler();
  const agents = new AgentManager();
  let killed = 0;
  agents.killAgent = () => { killed++; return true; };
  const connections = new ConnectionManager(updates);
  const terminals = new TerminalHandler();
  const conn = { connection: { newSession: async () => { throw new Error('invalid cwd'); }, listSessions: async () => ({ sessions: [{ sessionId: 's1', cwd: '/tmp' }] }), prompt: async () => ({ stopReason: 'end_turn' }), setSessionMode: async () => { throw new Error('legacy mode must not be called'); } },
    initResponse: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } }, terminals, supportsSteering: false,
  } as unknown as ConnectionInfo;
  (connections as unknown as { connections: Map<string, ConnectionInfo> }).connections.set('agent', conn);
  const manager = new SessionManager(agents, connections, updates, terminalAuth);
  const state = manager as unknown as { sessions: Map<string, SessionInfo>; agentProcesses: Map<string, string>; agentProcessNames: Map<string, string>; agentSessions: Map<string, Set<string>>; capabilities: Map<string, AgentCapabilitySummary> };
  state.agentProcesses.set('Claude Code', 'agent'); state.agentProcessNames.set('agent', 'Claude Code');
  state.agentSessions.set('Claude Code', new Set(['s1']));
  state.capabilities.set('Claude Code', { list: true, load: true, resume: false, close: true, fork: false, additionalDirectories: false });
  const session: SessionInfo = { sessionId: 's1', agentId: 'agent', agentName: 'Claude Code', agentDisplayName: 'Claude', cwd: '/tmp', createdAt: new Date().toISOString(), initResponse: conn.initResponse, modes: null, models: null, configOptions: null, availableCommands: [] };
  state.sessions.set('s1', session);
  const store = new SessionHistoryStore(new Memento()); manager.setHistoryStore(store);
  store.upsertNew('Claude Code', '/tmp', 's1'); store.upsertNew('Claude Code', '/elsewhere', 's2');
  return { manager, conn, session, store, agents, connections, killed: () => killed, dispose() { manager.dispose(); store.dispose(); updates.dispose(); } };
}

suite('ACP regressions: sessions and capability contracts', () => {
  test('newSession failure preserves an existing shared session and process', async () => {
    const h = managerHarness();
    try { await assert.rejects(h.manager.createSession('Claude Code', { cwd: '/invalid' }), /invalid cwd/); assert.strictEqual(h.killed(), 0); assert.ok(h.manager.getSession('s1')); } finally { h.dispose(); }
  });
  test('auth-required with no advertised methods does not kill another session', async () => {
    const h = managerHarness();
    h.conn.connection.newSession = async () => { throw new RequestError(-32000, 'Authentication required'); };
    try { await assert.rejects(h.manager.createSession('Claude Code', { cwd: '/tmp' }), /did not advertise/); assert.strictEqual(h.killed(), 0); assert.ok(h.manager.getSession('s1')); } finally { h.dispose(); }
  });

  test('terminal authentication appends agent args and never calls the authenticate RPC', async () => {
    let loginCalls = 0;
    const h = managerHarness({ async authenticate(config, method, cwd) { loginCalls++; assert.strictEqual(config.command, 'mock-agent'); assert.deepStrictEqual(method.args, ['--cli', 'auth', 'login']); assert.strictEqual(cwd, '/tmp'); }, dispose() {} });
    h.agents.getAgent = () => ({ id: 'agent', name: 'Claude Code', process: {} as import('node:child_process').ChildProcess, config: { command: 'mock-agent', args: ['base'] } });
    h.conn.initResponse.authMethods = [{ id: 'login', name: 'Login', type: 'terminal', args: ['--cli', 'auth', 'login'] }];
    h.conn.connection.authenticate = async () => { throw new Error('Terminal methods must not call authenticate'); };
    let attempts = 0;
    h.conn.connection.newSession = async () => { if (attempts++ === 0) { throw new RequestError(-32000, 'Authentication required'); } return { sessionId: 's-new' }; };
    const old = vscode.window.showInformationMessage;
    vscode.window.showInformationMessage = (async () => 'Authenticate') as typeof old;
    try { const created = await h.manager.createSession('Claude Code', { cwd: '/tmp' }); assert.strictEqual(created.sessionId, 's-new'); assert.strictEqual(loginCalls, 1); assert.strictEqual(h.killed(), 0); }
    finally { vscode.window.showInformationMessage = old; h.dispose(); }
  });
  test('failed session creation after agent authentication preserves shared sessions', async () => {
    const h = managerHarness(); let calls = 0;
    h.conn.initResponse.authMethods = [{ id: 'login', name: 'Login' }];
    h.conn.connection.authenticate = async () => { calls++; return {}; };
    let attempts = 0;
    h.conn.connection.newSession = async () => { if (attempts++ === 0) { throw new RequestError(-32000, 'Authentication required'); } throw new Error('retry failed'); };
    const old = vscode.window.showInformationMessage; vscode.window.showInformationMessage = (async () => 'Authenticate') as typeof old;
    try { await assert.rejects(h.manager.createSession('Claude Code', { cwd: '/tmp' }), /retry failed/); assert.strictEqual(calls, 1); assert.strictEqual(h.killed(), 0); assert.ok(h.manager.getSession('s1')); }
    finally { vscode.window.showInformationMessage = old; h.dispose(); }
  });
  test('a partial first page cannot remove cached sessions', async () => {
    const h = managerHarness(); h.conn.connection.listSessions = async () => ({ sessions: [{ sessionId: 's1', cwd: '/tmp' }], nextCursor: 'page2' });
    try { await h.manager.listSessions('Claude Code'); assert.ok(h.store.get('Claude Code', 's2')); } finally { h.dispose(); }
  });
  test('complete paginated history includes older sessions and deduplicates IDs', async () => {
    const h = managerHarness();
    h.conn.connection.listSessions = async params => params.cursor ? { sessions: [{ sessionId: 's2', cwd: '/elsewhere' }, { sessionId: 's1', cwd: '/tmp' }] } : { sessions: [{ sessionId: 's1', cwd: '/tmp' }], nextCursor: 'next' };
    try { assert.deepStrictEqual((await h.manager.listAllSessions('Claude Code')).map(s => s.sessionId), ['s1', 's2']); assert.ok(h.store.get('Claude Code', 's2')); }
    finally { h.dispose(); }
  });
  test('failed or cyclic pagination cannot prune cached history', async () => {
    for (const cycle of [false, true]) {
      const h = managerHarness(); let calls = 0;
      h.conn.connection.listSessions = async () => { if (calls++ > 0 && !cycle) { throw new Error('page failed'); } return { sessions: [{ sessionId: 's1', cwd: '/tmp' }], nextCursor: 'next' }; };
      try { await assert.rejects(h.manager.listAllSessions('Claude Code'), /page failed|repeated/); assert.ok(h.store.get('Claude Code', 's2')); }
      finally { h.dispose(); }
    }
  });
  test('merged history pagination keeps cache-only rows when reconciliation is disabled', async () => {
    const { manager, conn, store, dispose } = managerHarness();
    conn.connection.listSessions = async () => ({ sessions: [{ sessionId: 's1', cwd: '/tmp' }] });
    try { await manager.listAllSessions('Claude Code', { reconcile: false }); assert.ok(store.get('Claude Code', 's2')); }
    finally { dispose(); }
  });
  test('a cwd-filtered list cannot remove sessions from another directory', async () => {
    const h = managerHarness();
    try { await h.manager.listSessions('Claude Code', { cwd: '/tmp' }); assert.ok(h.store.get('Claude Code', 's2')); } finally { h.dispose(); }
  });
  test('a complete unfiltered snapshot still reconciles stale cache entries', async () => {
    const h = managerHarness();
    try { await h.manager.listSessions('Claude Code'); assert.strictEqual(h.store.get('Claude Code', 's2'), undefined); assert.ok(h.manager.getSession('s1')); } finally { h.dispose(); }
  });
  test('dead agent teardown releases its connection exactly once', () => {
    const h = managerHarness(); let disposed = 0; h.conn.dispose = () => { disposed++; };
    try { h.agents.emit('agent-closed', { agentId: 'agent', name: 'Claude Code', code: 1 }); assert.strictEqual(h.connections.getConnection('agent'), undefined); h.connections.dispose(); assert.strictEqual(disposed, 1); assert.strictEqual(h.killed(), 0); } finally { h.dispose(); }
  });
  test('unsupported image content is rejected before sending a prompt', async () => {
    const h = managerHarness();
    try { await assert.rejects(h.manager.sendPrompt('s1', [{ type: 'image', data: 'AA==', mimeType: 'image/png' }]), /does not support/); assert.strictEqual(h.manager.hasRunningTurn('s1'), false); } finally { h.dispose(); }
  });
  test('resource links need no embeddedContext capability', async () => {
    const h = managerHarness();
    try { assert.strictEqual((await h.manager.sendPrompt('s1', [{ type: 'resource_link', uri: 'file:///tmp/a', name: 'a' }])).stopReason, 'end_turn'); } finally { h.dispose(); }
  });
  test('configOptions presence forbids legacy mode fallback', async () => {
    const h = managerHarness(); h.session.configOptions = [];
    try { await assert.rejects(h.manager.setMode('s1', 'plan'), /did not expose/); } finally { h.dispose(); }
  });
  test('Codex-style model config uses the config RPC and replaces dependent options', async () => {
    const h = managerHarness(); h.session.agentName = 'Codex CLI';
    const model = { id: 'model', category: 'model', name: 'Model', type: 'select' as const, currentValue: 'gpt', options: [{ value: 'gpt', name: 'GPT' }, { value: 'other', name: 'Other' }] };
    h.session.configOptions = [model];
    h.conn.connection.setSessionConfigOption = async params => { assert.deepStrictEqual(params, { sessionId: 's1', configId: 'model', value: 'other' }); return { configOptions: [{ ...model, currentValue: 'other' }] }; };
    try { await h.manager.setModel('s1', 'other'); assert.strictEqual(h.session.configOptions[0].currentValue, 'other'); }
    finally { h.dispose(); }
  });
  test('Codex-style prompt capabilities accept images and embedded resources, not audio', async () => {
    const h = managerHarness(); h.session.agentName = 'Codex CLI'; h.conn.initResponse.agentCapabilities!.promptCapabilities = { image: true, embeddedContext: true };
    try { await h.manager.sendPrompt('s1', [{ type: 'image', data: 'AA==', mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'file:///tmp/a', text: 'context', mimeType: 'text/plain' } }]); await assert.rejects(h.manager.sendPrompt('s1', [{ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }]), /does not support/); }
    finally { h.dispose(); }
  });
  test('unsupported legacy model switching fails explicitly', async () => {
    const h = managerHarness();
    try { await assert.rejects(h.manager.setModel('s1', 'unknown'), /legacy model switching is unavailable/); }
    finally { h.dispose(); }
  });
  test('Codex and custom agent names use session-keyed modern transcripts', () => {
    for (const name of ['Claude Code', 'Codex CLI', 'My Codex', 'Gemini CLI']) { assert.strictEqual(panelIdForAgent(name), 'modern'); }
  });
});

suite('ACP regressions: filesystem, logs and terminals', () => {
  let temp = '';
  setup(async () => { temp = await fs.mkdtemp(join(tmpdir(), 'acpc-regression-')); });
  teardown(async function () { this.timeout(10000); await vscode.commands.executeCommand('workbench.action.closeAllEditors'); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  test('dirty user text is never silently replaced on disk or in the editor', async () => {
    const uri = vscode.Uri.file(join(temp, 'dirty.txt')); await fs.writeFile(uri.fsPath, 'original');
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(0, 0), 'user-'); await vscode.workspace.applyEdit(edit);
    try { await assert.rejects(new FileSystemHandler().writeTextFile({ sessionId: 's', path: uri.fsPath, content: 'agent' }), /unsaved changes/); assert.strictEqual(doc.getText(), 'user-original'); assert.strictEqual(await fs.readFile(uri.fsPath, 'utf8'), 'original'); } finally { await doc.save(); }
  });
  test('case-alias reads include the unsaved editor buffer on Windows', async function () {
    if (process.platform !== 'win32') { this.skip(); }
    const uri = vscode.Uri.file(join(temp, 'CaseRead.txt')); await fs.writeFile(uri.fsPath, 'original');
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), 'user-'); await vscode.workspace.applyEdit(edit);
    try { assert.strictEqual((await new FileSystemHandler().readTextFile({ sessionId: 's', path: uri.fsPath.toUpperCase() })).content, 'user-original'); }
    finally { await doc.save(); }
  });
  test('case-alias writes cannot bypass dirty editor protection on Windows', async function () {
    if (process.platform !== 'win32') { this.skip(); }
    const uri = vscode.Uri.file(join(temp, 'CaseWrite.txt')); await fs.writeFile(uri.fsPath, 'original');
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), 'user-'); await vscode.workspace.applyEdit(edit);
    try {
      await assert.rejects(new FileSystemHandler().writeTextFile({ sessionId: 's', path: uri.fsPath.toUpperCase(), content: 'agent' }), /unsaved changes/);
      assert.strictEqual(doc.getText(), 'user-original'); assert.strictEqual(await fs.readFile(uri.fsPath, 'utf8'), 'original');
    } finally { await doc.save(); }
  });
  test('file writes create missing parent directories', async () => {
    const file = join(temp, 'missing', 'nested', 'new.txt');
    await new FileSystemHandler().writeTextFile({ sessionId: 's', path: file, content: 'new file' });
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'new file');
  });
  test('symlink-alias writes cannot bypass dirty editor protection', async () => {
    const realDirectory = join(temp, 'real'); const aliasDirectory = join(temp, 'alias');
    await fs.mkdir(realDirectory); await fs.symlink(realDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const uri = vscode.Uri.file(join(realDirectory, 'file.txt')); await fs.writeFile(uri.fsPath, 'original');
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), 'user-'); await vscode.workspace.applyEdit(edit);
    try {
      const handler = new FileSystemHandler(); const alias = join(aliasDirectory, 'file.txt');
      assert.strictEqual((await handler.readTextFile({ sessionId: 's', path: alias })).content, 'user-original');
      await assert.rejects(handler.writeTextFile({ sessionId: 's', path: alias, content: 'agent' }), /unsaved changes/);
      assert.strictEqual(await fs.readFile(uri.fsPath, 'utf8'), 'original');
    } finally { await doc.save(); }
  });
  test('clean case-alias writes use the existing editor identity on Windows', async function () {
    if (process.platform !== 'win32') { this.skip(); }
    const file = join(temp, 'CaseClean.txt'); await fs.writeFile(file, 'before');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await new FileSystemHandler().writeTextFile({ sessionId: 's', path: file.toUpperCase(), content: 'after' });
    assert.strictEqual(doc.getText(), 'after'); assert.strictEqual(doc.isDirty, false);
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'after');
  });
  test('clean open-document write synchronizes disk and subsequent reads', async () => {
    const file = join(temp, 'clean.txt'); await fs.writeFile(file, 'before');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const handler = new FileSystemHandler(); await handler.writeTextFile({ sessionId: 's', path: file, content: 'after' });
    assert.strictEqual(doc.getText(), 'after'); assert.strictEqual(doc.isDirty, false); assert.strictEqual(await fs.readFile(file, 'utf8'), 'after');
    assert.strictEqual((await handler.readTextFile({ sessionId: 's', path: file })).content, 'after');
  });
  test('zero line limit returns no lines', async () => {
    const file = join(temp, 'zero.txt'); await fs.writeFile(file, 'one\ntwo'); assert.strictEqual((await new FileSystemHandler().readTextFile({ sessionId: 's', path: file, limit: 0 })).content, '');
  });
  test('logs continuously rotate and create a missing directory', async () => {
    const file = join(temp, 'logs', 'acpc.log'); const writer = new BoundedLogWriter(file, 100, 40);
    for (let i = 0; i < 12; i++) { writer.append('line-' + i + '-'.repeat(15)); } await writer.flush();
    assert.ok((await fs.stat(file)).size <= 100); assert.ok((await fs.stat(file + '.1')).size <= 100); assert.ok((await fs.readFile(file, 'utf8')).includes('line-11'));
  });
  test('log entry truncation preserves UTF-8 and the byte budget', async () => {
    const file = join(temp, 'utf8.log'); const writer = new BoundedLogWriter(file, 100, 10); writer.append('😀'.repeat(30)); await writer.flush();
    const bytes = await fs.readFile(file); assert.ok(bytes.length <= 10); assert.ok(!bytes.toString().includes('�'));
  });
  test('terminal preserves literal argv and cross-chunk UTF-8', async () => {
    const handler = new TerminalHandler();
    try {
      const { terminalId } = await handler.createTerminal({ sessionId: 's', command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1]); const b=Buffer.from("😀"); process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),25)', 'two words & literal'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] });
      await handler.waitForTerminalExit({ sessionId: 's', terminalId });
      assert.strictEqual((await handler.terminalOutput({ sessionId: 's', terminalId })).output, 'two words & literal😀');
      await assert.rejects(handler.terminalOutput({ sessionId: 'other', terminalId }), /another session/);
      await handler.releaseTerminal({ sessionId: 's', terminalId }); assert.strictEqual(handler.readOutput(terminalId), null);
    } finally { handler.dispose(); }
  });
  test('terminal output is visible before exit or a 100ms polling tick', async () => {
    const handler = new TerminalHandler();
    try {
      const { terminalId } = await handler.createTerminal({ sessionId: 's', command: process.execPath, args: ['-e', 'process.stdout.write("hello");setTimeout(()=>{},5000)'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] });
      const child = (handler as unknown as { terminals: Map<string, { process: import('node:child_process').ChildProcess }> }).terminals.get(terminalId)!.process;
      await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => { try { assert.strictEqual(handler.readOutput(terminalId)?.output, 'hello'); resolve(); } catch (e) { reject(e); } }); child.once('error', reject); });
    } finally { handler.dispose(); }
  });
  test('sub-codepoint terminal limits never leave a surrogate or exceed bytes', async () => {
    const handler = new TerminalHandler();
    try { const { terminalId } = await handler.createTerminal({ sessionId: 's', command: process.execPath, args: ['-e', 'process.stdout.write("😀")'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }], outputByteLimit: 1 }); await handler.waitForTerminalExit({ sessionId: 's', terminalId }); const output = await handler.terminalOutput({ sessionId: 's', terminalId }); assert.strictEqual(output.output, ''); assert.strictEqual(output.truncated, true); } finally { handler.dispose(); }
  });

  test('handshake error and unsupported version destroy stdio without caching a connection', async () => {
    for (const reply of [{ error: { code: -32603, message: 'handshake failed' } }, { result: { protocolVersion: PROTOCOL_VERSION + 1, agentCapabilities: {} } }]) {
      const script = 'process.stdin.setEncoding("utf8");process.stdin.on("data",s=>{for(const l of s.trim().split("\\n")){const r=JSON.parse(l);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,...'+JSON.stringify(reply)+'})+"\\n")}})';
      const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', windowsHide: true });
      const updates = new SessionUpdateHandler(); const manager = new ConnectionManager(updates);
      try { await assert.rejects(manager.connect('bad', child), /handshake failed|Unsupported ACP/); assert.strictEqual(manager.getConnection('bad'), undefined); assert.ok(child.stdin!.destroyed); assert.ok(child.stdout!.destroyed); }
      finally { child.kill(); manager.dispose(); updates.dispose(); }
    }
  });
  test('killing a managed process terminates its running descendant', async () => {
    const script = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{env:process.env,stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)';
    const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: process.platform !== 'win32', stdio: 'pipe', windowsHide: true });
    let descendant = 0;
    try {
      descendant = await new Promise<number>((resolve, reject) => { child.stdout!.once('data', b => resolve(Number(String(b).trim()))); child.once('error', reject); });
      assert.ok(descendant > 0); terminateProcess(child, true);
      const alive = () => { try { process.kill(descendant, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 5000; while (alive() && Date.now() < deadline) { await new Promise(r => setTimeout(r, 25)); }
      assert.strictEqual(alive(), false, 'descendant must not survive tree cleanup');
    } finally { terminateProcess(child, true); if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* stopped */ } } }
  });
  test('Windows cmd shim preserves literal args through agent and interactive auth launches', async function () {
    this.timeout(10000);
    if (process.platform !== 'win32') { this.skip(); }
    const dir = join(temp, 'with spaces', 'node_modules', '.bin'); await fs.mkdir(dir, { recursive: true });
    const script = join(temp, 'argv.cjs'); await fs.writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const command = join(dir, 'mock.cmd'); await fs.writeFile(command, '@echo off\r\n"' + (process.env.NODE || process.execPath) + '" "' + script + '" %*\r\n');
    const args = ['two words', 'literal & text', 'quote"inside', 'trail\\', '%UNKNOWN_VARIABLE%'];
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    const agents = new AgentManager();
    const instance = agents.spawnAgent('Mock', { command, args, env }, temp);
    const output = async (child: import('node:child_process').ChildProcess) => { let text = ''; let error = ''; child.stdout!.on('data', b => { text += b; }); child.stderr!.on('data', b => { error += b; }); await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('exit '+code+': '+error))); }); return JSON.parse(text); };
    try { assert.deepStrictEqual(await output(instance.process), args); } finally { agents.killAll(); }
    const options = terminalAuthOptions({ command, args: args.slice(0, 2), env }, { id: 'login', name: 'Login', args: args.slice(2) }, temp);
    const auth = spawn(options.shellPath!, [options.shellArgs as string], { env: { ...process.env, ...env }, cwd: temp, windowsHide: true, windowsVerbatimArguments: true, stdio: 'pipe' });
    try { assert.deepStrictEqual(await output(auth), args); } finally { auth.kill(); }
  });
  test('Windows native executable with spaces preserves argv during terminal auth', async function () {
    this.timeout(10000);
    if (process.platform !== 'win32') { this.skip(); }
    const args = ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'two words', 'literal & text', 'quote"inside', 'trail\\', '%UNKNOWN_VARIABLE%'];
    const options = terminalAuthOptions({ command: (process.env.NODE || process.execPath), args: args.slice(0, 2), env: { ELECTRON_RUN_AS_NODE: '1' } }, { id: 'login', name: 'Login', args: args.slice(2) }, temp);
    const child = spawn(options.shellPath!, [options.shellArgs as string], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsVerbatimArguments: true, windowsHide: true, stdio: 'pipe' });
    let output = ''; let stderr = ''; child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { stderr += b; });
    try { await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('exit ' + code + ': ' + stderr))); }); assert.deepStrictEqual(JSON.parse(output), args.slice(2)); }
    finally { child.kill(); }
  });
  test('real stdio handshake resources are closed on manager disposal', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.setEncoding("utf8");process.stdin.on("data",s=>{for(const line of s.trim().split("\\n")){const r=JSON.parse(line);if(r.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{protocolVersion:1,agentCapabilities:{}}})+"\\n")}})'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', windowsHide: true });
    const updates = new SessionUpdateHandler(); const connections = new ConnectionManager(updates);
    try { const info = await connections.connect('mock', child); let calls = 0; const original = info.terminals.dispose.bind(info.terminals); info.terminals.dispose = () => { calls++; original(); }; connections.dispose(); connections.dispose(); assert.strictEqual(calls, 1); await info.connection.closed; } finally { child.kill(); connections.dispose(); updates.dispose(); }
  });
});

suite('ACP regressions: registry and sanitizer', () => {
  test('registry validates distribution-based entries and deduplicates IDs', () => {
    assert.deepStrictEqual(parseRegistry({ agents: [{ id: 'codex', name: 'Codex', version: '1', distribution: { npx: {} } }, { id: 'codex', name: 'duplicate' }, { name: 'bad' }] }).map(a => a.id), ['codex']); assert.throws(() => parseRegistry({ invalid: [] }), /Invalid ACP registry/);
  });
  test('registry coalesces requests and reuses fresh validated results', async () => {
    const original = globalThis.fetch; let calls = 0; clearRegistryCache();
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ agents: [{ id: 'mock', name: 'Mock' }] }), { status: 200 }); };
    try { const [a, b] = await Promise.all([fetchRegistry(), fetchRegistry()]); assert.deepStrictEqual(a, b); assert.strictEqual(calls, 1); assert.deepStrictEqual(await fetchRegistry(), a); assert.strictEqual(calls, 1); }
    finally { globalThis.fetch = original; clearRegistryCache(); }
  });
  test('cache clear prevents an older registry response from replacing a new generation', async () => {
    const original = globalThis.fetch; clearRegistryCache(); let first!: (r: Response) => void; let calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? await new Promise<Response>(resolve => { first = resolve; }) : new Response(JSON.stringify({ agents: [{ id: 'new', name: 'New' }] }));
    try { const old = fetchRegistry(); clearRegistryCache(); const fresh = await fetchRegistry(); first(new Response(JSON.stringify({ agents: [{ id: 'old', name: 'Old' }] }))); await old; assert.deepStrictEqual(await fetchRegistry(), fresh); assert.strictEqual(calls, 2); }
    finally { globalThis.fetch = original; clearRegistryCache(); }
  });
  test('invalid registry responses fall back safely without becoming cached data', async () => {
    const original = globalThis.fetch; let calls = 0; clearRegistryCache();
    globalThis.fetch = async () => { calls++; return new Response('{}'); };
    try { assert.deepStrictEqual(await fetchRegistry(), []); assert.deepStrictEqual(await fetchRegistry(), []); assert.strictEqual(calls, 2); }
    finally { globalThis.fetch = original; clearRegistryCache(); }
  });
  test('sanitizer walks nested unknown wrappers before promoting children', () => {
    class Element {
      nodeType = 1; attributes = [{ name: 'onclick' }]; childNodes: Element[] = [];
      constructor(readonly tagName: string) {}
      get firstChild(): Element | undefined { return this.childNodes[0]; }
      insertBefore(child: Element, before: Element): void { const owner = all.find(n => n.childNodes.includes(child)); if (owner) { owner.removeChild(child); } this.childNodes.splice(this.childNodes.indexOf(before), 0, child); }
      removeChild(child: Element): void { this.childNodes.splice(this.childNodes.indexOf(child), 1); }
      removeAttribute(name: string): void { this.attributes = this.attributes.filter(a => a.name !== name); }
      setAttribute(): void {}
      get innerHTML(): string { return this.childNodes.map(c => '<' + c.tagName + (c.attributes.length ? ' onclick' : '') + '>' + c.innerHTML).join(''); }
    }
    const body = new Element('BODY'), unknown = new Element('UNKNOWN'), nested = new Element('CUSTOM'), span = new Element('SPAN'), img = new Element('IMG');
    const all = [body, unknown, nested, span, img]; body.childNodes = [unknown]; unknown.childNodes = [nested]; nested.childNodes = [span, img];
    const ns = {} as { dom: { sanitize(html: string): string } };
    new Function('window', 'DOMParser', domClient)({ __acpc: ns }, class { parseFromString() { return { body }; } });
    const result = ns.dom.sanitize('input'); assert.strictEqual(result, '<SPAN>');
  });
});

suite('ACP regressions: interactive auth lifecycle', () => {
  for (const code of [0, 1, undefined]) {
    test('terminal auth accepts only exit code zero: ' + String(code), async () => {
      const close = new vscode.EventEmitter<vscode.Terminal>();
      const terminal = { exitStatus: { code }, show() {}, dispose() {} } as unknown as vscode.Terminal;
      const handler = new TerminalAuthHandler({ createTerminal: (() => terminal) as typeof vscode.window.createTerminal, onDidCloseTerminal: close.event });
      const pending = handler.authenticate({ command: 'agent' }, { id: 'login', name: 'Login' });
      close.fire(terminal);
      try { if (code === 0) { await pending; } else { await assert.rejects(pending, /failed or was cancelled/); } }
      finally { handler.dispose(); close.dispose(); }
    });
  }
  test('a real no-op authentication terminal completes on natural process exit', async function () {
    this.timeout(20000);
    const handler = new TerminalAuthHandler(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        handler.authenticate({ command: (process.env.NODE || process.execPath), args: ['-e', 'process.exit(0)'], env: { ELECTRON_RUN_AS_NODE: '1' } }, { id: 'noop', name: 'Regression no-op', args: [] }, tmpdir()),
        new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Natural terminal exit did not settle authentication')), 12000); }),
      ]);
    } finally { if (timer) { clearTimeout(timer); } handler.dispose(); }
  });
  test('client disposal settles pending terminal auth', async () => {
    const close = new vscode.EventEmitter<vscode.Terminal>(); let disposed = 0;
    const terminal = { show() {}, dispose() { disposed++; } } as unknown as vscode.Terminal;
    const handler = new TerminalAuthHandler({ createTerminal: (() => terminal) as typeof vscode.window.createTerminal, onDidCloseTerminal: close.event });
    const pending = handler.authenticate({ command: 'agent' }, { id: 'login', name: 'Login' });
    handler.dispose(); await assert.rejects(pending, /client disposed/); assert.strictEqual(disposed, 1); close.dispose();
  });
  test('terminal auth merges arguments and environment without replacing base configuration', () => {
    const options = terminalAuthOptions({ command: 'agent', args: ['base'], env: { KEEP: 'yes', OVERRIDE: 'old' } }, { id: 'login', name: 'Login', args: ['login'], env: { OVERRIDE: 'new' } }, '/cwd');
    assert.deepStrictEqual(options.env, { KEEP: 'yes', OVERRIDE: 'new' }); assert.strictEqual(options.cwd, '/cwd');
    if (process.platform === 'win32') { assert.ok(String(options.shellArgs).includes('base')); assert.ok(String(options.shellArgs).includes('login')); } else { assert.deepStrictEqual(options.shellArgs, ['base', 'login']); }
  });
});
