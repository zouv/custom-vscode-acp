import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Agent, InitializeResponse } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk/dist/stream.js';
import { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import { AcpClientImpl } from './AcpClientImpl';
import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { TerminalHandler } from '../handlers/TerminalHandler';
import { PermissionHandler } from '../handlers/PermissionHandler';
import type { PermissionBridge } from '../handlers/PermissionBridge';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { log, logError, logTraffic } from '../utils/Logger';
import { version as extensionVersion } from '../../package.json';

// [CUSTOM-BEGIN] CUSTOM-20260923-012 - 暴露终端 handler。
// `TerminalHandler` 此前只在 connect() 里作为局部变量存在（仅被 AcpClientImpl 的私有字段引用），
// 聊天面板拿不到任何句柄，于是工具卡片上的终端 chip 是无数据的死控件。
// [CUSTOM-END] CUSTOM-20260923-012
export interface ConnectionInfo {
  connection: ClientSideConnection;
  client: AcpClientImpl;
  initResponse: InitializeResponse;
  /** Terminal handler for this connection — lets the chat panel read terminal output. */
  terminals: TerminalHandler;
}

/**
 * Manages ACP connections to agent processes.
 * Creates ClientSideConnection instances from spawned child processes.
 */
export class ConnectionManager {
  private connections: Map<string, ConnectionInfo> = new Map();

  constructor(
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    // [CUSTOM-BEGIN] CUSTOM-20260924-020 - 权限桥注入。
    // 每个连接都会新建一个 PermissionHandler，而它此前拿不到任何 UI 服务；
    // 桥是唯一的出口（面板卡片 / 弹框），因此在构造连接时一并传下去。
    private readonly permissionBridge?: PermissionBridge,
    // [CUSTOM-END] CUSTOM-20260924-020
  ) {}

  /**
   * Create an ACP connection from a child process.
   * Sets up streams, creates connection, and performs initialization handshake.
   */
  async connect(agentId: string, process: ChildProcess): Promise<ConnectionInfo> {
    if (!process.stdout || !process.stdin) {
      throw new Error('Agent process missing stdio streams');
    }

    log(`ConnectionManager: connecting to agent ${agentId}`);

    // Create Web Streams from Node.js streams
    const readable = Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>;
    const writable = Writable.toWeb(process.stdin) as WritableStream<Uint8Array>;

    const stream = ndJsonStream(writable, readable);

    // Wrap the stream to intercept and log all ACP traffic
    const tappedStream = this.tapStream(stream);

    // Create handlers
    const fsHandler = new FileSystemHandler();
    const terminalHandler = new TerminalHandler();
    const permissionHandler = new PermissionHandler(this.permissionBridge);

    // Create client implementation
    const client = new AcpClientImpl(
      fsHandler,
      terminalHandler,
      permissionHandler,
      this.sessionUpdateHandler,
    );

    // Create connection — toClient factory receives the Agent proxy
    const connection = new ClientSideConnection(
      (agent: Agent) => {
        client.setAgent(agent);
        return client;
      },
      tappedStream,
    );

    // Initialize the connection
    log(`ConnectionManager: initializing connection to agent ${agentId}`);
    const initResponse = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: 'vscode-acp-client',
        version: extensionVersion,
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    });

    log(`ConnectionManager: initialized. Agent: ${initResponse.agentInfo?.name || 'unknown'} v${initResponse.agentInfo?.version || '?'}`);

    const info: ConnectionInfo = { connection, client, initResponse, terminals: terminalHandler };
    this.connections.set(agentId, info);

    return info;
  }

  getConnection(agentId: string): ConnectionInfo | undefined {
    return this.connections.get(agentId);
  }

  removeConnection(agentId: string): void {
    this.connections.delete(agentId);
  }

  dispose(): void {
    this.connections.clear();
  }

  /**
   * Wrap a Stream to intercept and log all messages in both directions.
   */
  private tapStream(stream: Stream): Stream {
    // Tap outgoing messages (client → agent)
    const sendTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        logTraffic('send', chunk);
        controller.enqueue(chunk);
      },
    });

    // Tap incoming messages (agent → client)
    const recvTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        logTraffic('recv', chunk);
        controller.enqueue(chunk);
      },
    });

    // Pipe: sendTap.readable → original writable, original readable → recvTap.writable
    // These run in the background — no need to await
    void sendTap.readable.pipeTo(stream.writable).catch(e => logError('Traffic tap send pipe error', e));
    void stream.readable.pipeTo(recvTap.writable).catch(e => logError('Traffic tap recv pipe error', e));

    return {
      writable: sendTap.writable,
      readable: recvTap.readable,
    };
  }
}
