import * as acp from '@agentclientprotocol/sdk';
import type { ByteTransport } from './websocket';

export type Phase =
  | 'initializing'
  | 'ready'
  | 'authenticating'
  | 'creating'
  | 'configuring'
  | 'prompting'
  | 'cancelling'
  | 'closed';
export interface Permission {
  id: acp.JsonRpcId;
  request: acp.RequestPermissionRequest;
}
export interface ClientEvents {
  /** Notify the page to read the client's current connection and turn state. */
  state(): void;
  /** Deliver an update belonging to this client's current session. */
  update(notification: acp.SessionNotification): void;
  /** Replace the page's approval cards with the supplied pending requests. */
  permissions(items: Permission[]): void;
}

/** Own one ACP connection and one session, with explicit turn and permission lifetimes. */
export class AcpClient {
  phase: Phase = 'initializing';
  sessionId?: string;
  info?: acp.InitializeResponse;
  modes?: acp.SessionModeState;
  configOptions: acp.SessionConfigOption[] = [];
  private readonly connection: acp.ClientConnection;
  private readonly pending = new Map<
    acp.JsonRpcId,
    Permission & { finish(response: acp.RequestPermissionResponse): void }
  >();

  /** Bind SDK handlers to the supplied transport; events contain no transport-specific state. */
  constructor(
    private readonly transport: ByteTransport,
    private readonly events: ClientEvents,
  ) {
    this.connection = acp
      .client({ name: 'stirrup' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (this.phase !== 'closed' && params.sessionId === this.sessionId) {
          if (params.update.sessionUpdate === 'current_mode_update' && this.modes) {
            this.modes.currentModeId = params.update.currentModeId;
          }
          if (params.update.sessionUpdate === 'config_option_update') {
            this.configOptions = params.update.configOptions;
            events.state();
          }
          events.update(params);
        }
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params, requestId, signal }) =>
        this.requestPermission(requestId, params, signal),
      )
      .connect(acp.ndJsonStream(transport.writable, transport.readable));
    void this.connection.closed.then(() => this.close());
  }

  /** Negotiate stable ACP with no client file/terminal capabilities; close on failure or timeout. */
  async initialize(): Promise<acp.InitializeResponse> {
    const timer = setTimeout(() => this.close(new Error('ACP 初始化超时')), 20_000);
    try {
      const info = await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'stirrup', title: 'Stirrup', version: '0.1.0' },
      });
      if (this.connection.signal.aborted) throw new Error('连接已断开');
      if (info.protocolVersion !== acp.PROTOCOL_VERSION)
        throw new Error(`不支持 ACP 版本 ${info.protocolVersion}`);
      this.info = info;
      this.setPhase('ready');
      return info;
    } catch (error) {
      this.close(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Authenticate with an advertised method ID; secrets remain in the adapter's local environment. */
  async authenticate(methodId: string): Promise<void> {
    this.requireReady();
    if (this.sessionId) throw new Error('请在创建会话前认证');
    if (!this.info?.authMethods?.some((method) => method.id === methodId)) throw new Error('未知认证方式');
    this.setPhase('authenticating');
    try {
      await this.connection.agent.request(acp.methods.agent.authenticate, { methodId });
    } finally {
      this.restoreReady();
    }
  }

  /** Create this connection's single session in an absolute local working directory. */
  async newSession(cwd: string): Promise<acp.NewSessionResponse> {
    this.requireReady();
    if (this.sessionId) throw new Error('当前连接已有会话，请断开后新建');
    if (!/^(\/|[A-Za-z]:[\\/])/.test(cwd)) throw new Error('工作目录必须是绝对路径');
    this.setPhase('creating');
    try {
      const result = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      if (this.connection.signal.aborted) throw new Error('连接已断开');
      this.sessionId = result.sessionId;
      this.modes = result.modes ?? undefined;
      this.configOptions = result.configOptions ?? [];
      return result;
    } finally {
      this.restoreReady();
    }
  }

  /** Restore a known agent session only through an advertised method; ignore load replay until ready. */
  async restoreSession(cwd: string, sessionId: string): Promise<void> {
    this.requireReady();
    if (this.sessionId) throw new Error('当前连接已有会话');
    const capabilities = this.info?.agentCapabilities;
    const method = capabilities?.sessionCapabilities?.resume
      ? acp.methods.agent.session.resume
      : capabilities?.loadSession
        ? acp.methods.agent.session.load
        : undefined;
    if (!method) throw new Error('此代理不支持恢复历史会话，请在该项目新建对话');
    this.setPhase('creating');
    try {
      const result = await this.connection.agent.request(method, { cwd, sessionId, mcpServers: [] });
      if (this.connection.signal.aborted) throw new Error('连接已断开');
      this.sessionId = sessionId;
      this.modes = result?.modes ?? undefined;
      this.configOptions = result?.configOptions ?? [];
    } finally {
      this.restoreReady();
    }
  }

  /** Change a server-advertised option while idle; replace local options with the complete response. */
  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    this.requireReady();
    const option = this.configOptions.find((item) => item.id === configId);
    if (!this.sessionId || !option) throw new Error('当前会话不支持此配置');
    if (option.type === 'select') {
      const choices = option.options.flatMap((item) => ('group' in item ? item.options : [item]));
      if (typeof value !== 'string' || !choices.some((item) => item.value === value))
        throw new Error('无效配置选项');
    } else if (typeof value !== 'boolean') throw new Error('配置需要布尔值');
    this.setPhase('configuring');
    try {
      const result = await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.sessionId,
        configId,
        ...(typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value }),
      });
      if (this.connection.signal.aborted) throw new Error('连接已断开');
      this.configOptions = result.configOptions;
    } finally {
      this.restoreReady();
    }
  }

  /** Select only a mode advertised for this session, updating state after the agent accepts it. */
  async setMode(modeId: string): Promise<void> {
    this.requireReady();
    if (!this.sessionId || !this.modes?.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error('当前会话不支持此模式');
    }
    this.setPhase('configuring');
    try {
      await this.connection.agent.request(acp.methods.agent.session.setMode, {
        sessionId: this.sessionId,
        modeId,
      });
      if (this.connection.signal.aborted) throw new Error('连接已断开');
      this.modes.currentModeId = modeId;
    } finally {
      this.restoreReady();
    }
  }

  /** Send a nonempty text turn and resolve only on the agent's final response. */
  async prompt(text: string): Promise<acp.PromptResponse> {
    this.requireReady();
    if (!this.sessionId) throw new Error('请先创建会话');
    if (!text.trim()) throw new Error('消息不能为空');
    this.setPhase('prompting');
    try {
      return await this.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
    } finally {
      this.cancelPermissions();
      this.restoreReady();
    }
  }

  /** Cancel the active turn, dismiss approvals, and keep the turn busy until its response arrives. */
  async cancel(): Promise<void> {
    if (this.phase !== 'prompting' || !this.sessionId) return;
    this.setPhase('cancelling');
    this.cancelPermissions();
    try {
      await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
    } catch (error) {
      this.close(error);
      throw error;
    }
  }

  /** Answer a pending approval with an advertised option, or cancel it when optionId is absent. */
  answerPermission(id: acp.JsonRpcId, optionId?: string): void {
    const item = this.pending.get(id);
    if (!item) throw new Error('审批已结束');
    if (optionId !== undefined && !item.request.options.some((option) => option.optionId === optionId)) {
      throw new Error('无效审批选项');
    }
    item.finish({
      outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId },
    });
  }

  /** Close idempotently, rejecting requests and dismissing all permissions without approving. */
  close(error?: unknown): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.cancelPermissions();
    this.connection.close(error);
    this.transport.close();
    this.sessionId = undefined;
    this.modes = undefined;
    this.configOptions = [];
    this.events.state();
  }

  /** Track an agent approval only during this session's active turn; abort removes it from the UI. */
  private requestPermission(
    id: acp.JsonRpcId,
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    if (this.phase !== 'prompting' || request.sessionId !== this.sessionId || signal.aborted) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    return new Promise((resolve) => {
      /** Resolve this approval once, unregister its abort handler, and publish remaining approvals. */
      const finish = (response: acp.RequestPermissionResponse): void => {
        if (!this.pending.delete(id)) return;
        signal.removeEventListener('abort', abort);
        resolve(response);
        this.emitPermissions();
      };
      /** Treat agent-side request cancellation as a dismissed approval. */
      const abort = (): void => finish({ outcome: { outcome: 'cancelled' } });
      this.pending.set(id, { id, request, finish });
      signal.addEventListener('abort', abort, { once: true });
      this.emitPermissions();
    });
  }

  /** Cancel each outstanding approval using its normal cleanup path. */
  private cancelPermissions(): void {
    for (const item of [...this.pending.values()]) item.finish({ outcome: { outcome: 'cancelled' } });
  }

  /** Publish a snapshot without exposing the internal resolution callbacks. */
  private emitPermissions(): void {
    this.events.permissions([...this.pending.values()].map(({ id, request }) => ({ id, request })));
  }

  /** Reject overlapping operations and use before changing any request state. */
  private requireReady(): void {
    if (this.phase !== 'ready') throw new Error('连接未就绪或操作尚未结束');
  }

  /** Update the visible phase synchronously so repeated clicks cannot start concurrent operations. */
  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.events.state();
  }

  /** Restore readiness after a request without reviving an already closed connection. */
  private restoreReady(): void {
    if (this.phase !== 'closed') this.setPhase('ready');
  }
}
