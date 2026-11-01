import * as vscode from 'vscode';
// [CUSTOM-BEGIN] CUSTOM-20261101-014 - Resolve file aliases without case-folding case-sensitive filesystems.
import { realpath } from 'node:fs/promises';
// [CUSTOM-END] CUSTOM-20261101-014
import { log, logError } from '../utils/Logger';

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/**
 * Handles ACP file system requests using VS Code's workspace filesystem API.
 * This gives us access to unsaved editor buffers automatically.
 */
export class FileSystemHandler {

  // [CUSTOM-BEGIN] CUSTOM-20261101-014 - Match physical paths, including Windows casing and symlink aliases.
  private async findOpenDocument(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    const exact = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    if (exact) { return exact; }
    let targetPath: string;
    try { targetPath = await realpath(uri.fsPath); }
    catch { return undefined; }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file') { continue; }
      try { if (await realpath(doc.uri.fsPath) === targetPath) { return doc; } }
      catch {}
    }
    return undefined;
  }
  // [CUSTOM-END] CUSTOM-20261101-014

  /**
   * Read a text file. Uses VS Code API to include unsaved editor content.
   */
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    log(`readTextFile: ${params.path}`);

    try {
      const uri = vscode.Uri.file(params.path);

      // Check if the file is open in an editor with unsaved changes
      // [CUSTOM-BEGIN] CUSTOM-20261101-014 - Read the buffer even when the agent uses a file alias.
      const openDoc = await this.findOpenDocument(uri);
      // [CUSTOM-END] CUSTOM-20261101-014

      let content: string;
      if (openDoc) {
        content = openDoc.getText();
      } else {
        const raw = await vscode.workspace.fs.readFile(uri);
        content = Buffer.from(raw).toString('utf-8');
      }

      // [CUSTOM-BEGIN] CUSTOM-20261101-001 - Apply a zero limit even when no starting line is provided.
      // Handle line/limit parameters
      if (params.line !== undefined && params.line !== null
        || params.limit !== undefined && params.limit !== null) {
        const lines = content.split('\n');
        const startLine = (params.line ?? 1) - 1; // 1-based → 0-based
        const endLine = params.limit !== undefined && params.limit !== null
          ? startLine + params.limit
          : lines.length;
        content = lines.slice(startLine, endLine).join('\n');
      }

      // [CUSTOM-END] CUSTOM-20261101-001
      return { content };
    } catch (e) {
      logError(`readTextFile failed: ${params.path}`, e);
      throw e;
    }
  }

  /**
   * Write a text file. Creates parent directories if needed.
   * Opens the file in the editor so the user can see changes.
   */
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    log(`writeTextFile: ${params.path}`);

    try {
      const uri = vscode.Uri.file(params.path);
      // [CUSTOM-BEGIN] CUSTOM-20261101-001 - Keep editor buffers and disk consistent; refuse unsaved user edits.
      const openDoc = await this.findOpenDocument(uri);
      if (openDoc?.isDirty) {
        throw new Error('File has unsaved changes. Save or discard them before the agent writes: ' + params.path);
      }
      let doc: vscode.TextDocument;
      if (openDoc) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(openDoc.uri, new vscode.Range(openDoc.positionAt(0), openDoc.positionAt(openDoc.getText().length)), params.content);
        if (!await vscode.workspace.applyEdit(edit) || !await openDoc.save()) {
          throw new Error('Could not apply and save agent file edit: ' + params.path);
        }
        doc = openDoc;
      } else {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(params.content, 'utf-8'));
        doc = await vscode.workspace.openTextDocument(uri);
      }
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      // [CUSTOM-END] CUSTOM-20261101-001

      return {};
    } catch (e) {
      logError(`writeTextFile failed: ${params.path}`, e);
      throw e;
    }
  }
}
