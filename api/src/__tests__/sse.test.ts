/**
 * SSE module unit tests — import the actual module
 */

// Import the actual module (no jest.mock for sse.ts here)
import { addSSEClient, broadcast, broadcastLog } from '../lib/sse.js';
import type { Response } from 'express';

function makeRes(): Partial<Response> & { _data: string[]; _closed: boolean } {
  const data: string[] = [];
  let closeHandler: (() => void) | undefined;
  return {
    _data: data,
    _closed: false,
    write: jest.fn((chunk: string) => {
      data.push(chunk);
      return true;
    }) as unknown as Response['write'],
    on: jest.fn((event: string, handler: () => void) => {
      if (event === 'close') closeHandler = handler;
      return undefined as unknown as Response;
    }) as unknown as Response['on'],
    _close: () => closeHandler?.(),
  } as ReturnType<typeof makeRes>;
}

describe('SSE module', () => {
  beforeEach(() => {
    // Clear all SSE clients between tests by triggering close
    jest.clearAllMocks();
  });

  it('addSSEClient registers a client', () => {
    const res = makeRes();
    addSSEClient(res as Response);
    expect(res.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('broadcast sends data to registered client', () => {
    const res = makeRes();
    addSSEClient(res as Response);
    broadcast({ type: 'queue_depth', depth: 5 });
    expect(res.write).toHaveBeenCalled();
    const writtenData = (res._data[0] ?? '') as string;
    expect(writtenData).toContain('"type":"queue_depth"');
    expect(writtenData).toContain('"depth":5');
    // Cleanup
    (res as unknown as { _close: () => void })._close();
  });

  it('broadcastLog sends a log event', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = makeRes();
    addSSEClient(res as Response);
    broadcastLog('info', 'test log message');
    expect(res.write).toHaveBeenCalled();
    const written = res._data[0] ?? '';
    expect(written).toContain('"type":"log"');
    expect(written).toContain('test log message');
    consoleSpy.mockRestore();
    (res as unknown as { _close: () => void })._close();
  });

  it('broadcastLog calls console.error for errors', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    addSSEClient(res as Response);
    broadcastLog('error', 'error message');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    (res as unknown as { _close: () => void })._close();
  });

  it('broadcastLog calls console.warn for warnings', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = makeRes();
    addSSEClient(res as Response);
    broadcastLog('warn', 'warning message');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    (res as unknown as { _close: () => void })._close();
  });

  it('client removed after close event', () => {
    const res = makeRes();
    addSSEClient(res as Response);

    // Trigger close
    (res as unknown as { _close: () => void })._close();

    // After close, write should not be called on this client
    const callsBefore = (res.write as jest.Mock).mock.calls.length;
    broadcast({ type: 'queue_depth', depth: 99 });
    const callsAfter = (res.write as jest.Mock).mock.calls.length;
    expect(callsAfter).toBe(callsBefore); // no new writes
  });
});
