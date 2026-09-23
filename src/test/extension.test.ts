import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('zouv.acp-client-custom'));
	});

	test('Should activate extension', async () => {
		const ext = vscode.extensions.getExtension('zouv.acp-client-custom');
		assert.ok(ext);
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});

	test('Should register ACP commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		const acpCommands = commands.filter(c => c.startsWith('acpc.'));
		assert.ok(acpCommands.length > 0, 'ACP commands should be registered');
		assert.ok(acpCommands.includes('acpc.connectAgent'), 'connectAgent command should exist');
		assert.ok(acpCommands.includes('acpc.newConversation'), 'newConversation command should exist');
		assert.ok(acpCommands.includes('acpc.openChat'), 'openChat command should exist');
	});
});
