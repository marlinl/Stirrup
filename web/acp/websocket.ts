export interface ByteTransport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Release the transport; repeated calls must be harmless. */
  close(): void;
}

/** Open a byte-stream transport; reject initial failures and propagate later socket closure. */
export async function openWebSocket(url: string): Promise<ByteTransport> {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const readable = new ReadableStream<Uint8Array>({
    /** Keep the byte stream controller for WebSocket event delivery. */
    start(value) {
      controller = value;
    },
    /** The SDK may cancel the reader first; its controller is already closed on this path. */
    cancel() {
      ended = true;
      socket.close();
    },
  });
  /** End both directions exactly once and wake readers waiting on the socket. */
  const close = (): void => {
    if (ended) return;
    ended = true;
    controller.close();
    socket.close();
  };
  socket.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
    if (!ended)
      controller.enqueue(
        typeof event.data === 'string' ? new TextEncoder().encode(event.data) : new Uint8Array(event.data),
      );
  });
  socket.addEventListener('close', close);
  socket.addEventListener('error', close);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(new Error('连接超时'));
    }, 10_000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'close',
      () => {
        clearTimeout(timer);
        reject(new Error('本地 ACP 连接已关闭'));
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('无法连接本地 ACP 代理，请检查启动终端'));
      },
      { once: true },
    );
  });
  return {
    readable,
    writable: new WritableStream<Uint8Array>({
      /** Forward one SDK chunk; prevent unbounded buffering if the adapter stops reading. */
      write(chunk) {
        if (ended || socket.readyState !== WebSocket.OPEN) throw new Error('连接已断开');
        if (socket.bufferedAmount > 1024 * 1024) {
          close();
          throw new Error('发送缓冲区已满');
        }
        socket.send(new Uint8Array(chunk));
      },
      close,
      abort: close,
    }),
    close,
  };
}
