import type {
  Client,
  Agent,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from '@agentclientprotocol/sdk';

import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { TerminalHandler } from '../handlers/TerminalHandler';
import { PermissionHandler } from '../handlers/PermissionHandler';
import { ElicitationHandler } from '../handlers/ElicitationHandler';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { log } from '../utils/Logger';

/**
 * ACP Client implementation for VS Code.
 * Delegates to individual handlers for each capability.
 *
 * Passed as a factory to ClientSideConnection:
 *   new ClientSideConnection((agent) => new AcpClientImpl(...), stream)
 */
export class AcpClientImpl implements Client {
  private agent: Agent | null = null;

  constructor(
    private readonly fsHandler: FileSystemHandler,
    private readonly terminalHandler: TerminalHandler,
    private readonly permissionHandler: PermissionHandler,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    // [CUSTOM-20260929-119] Optional so an existing three-arg construction keeps
    // working; without it the SDK method is simply not implemented and an agent asking
    // for a form gets `methodNotFound` — which is what happened before this round.
    private readonly elicitationHandler?: ElicitationHandler,
  ) {}

  setAgent(agent: Agent): void {
    this.agent = agent;
  }

  getAgent(): Agent | null {
    return this.agent;
  }

  // --- Required methods ---

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(params);
  }

  /**
   * [CUSTOM-20260929-119] AskUserQuestion (and MCP elicitations, and the refusal
   * fallback consent prompt) arrive here once `clientCapabilities.elicitation.form`
   * is declared. The method name must match the SDK's `Client` interface exactly or
   * the connection never dispatches to it.
   *
   * [CUSTOM-20261003-175] SDK 1.x 把它从 `unstable_createElicitation` 正式化为
   * `createElicitation`（旧名字在 1.x 里已不存在）。
   */
  async createElicitation(
    params: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    if (!this.elicitationHandler) {
      // Should not happen: the capability is only declared by ConnectionManager, which
      // always constructs the handler. Refuse rather than leaving the agent waiting.
      log('AcpClientImpl: elicitation request with no handler; cancelling');
      return { action: 'cancel' };
    }
    return this.elicitationHandler.create(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdateHandler.handleUpdate(params);
  }

  // --- File system methods ---

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    log(`Client.writeTextFile: ${params.path}`);
    return this.fsHandler.writeTextFile(params);
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    log(`Client.readTextFile: ${params.path}`);
    return this.fsHandler.readTextFile(params);
  }

  // --- Terminal methods ---

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    return this.terminalHandler.createTerminal(params);
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    return this.terminalHandler.terminalOutput(params);
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return this.terminalHandler.waitForTerminalExit(params);
  }

  async killTerminal(
    params: KillTerminalRequest,
  ): Promise<KillTerminalResponse> {
    return this.terminalHandler.killTerminal(params);
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    return this.terminalHandler.releaseTerminal(params);
  }
}
