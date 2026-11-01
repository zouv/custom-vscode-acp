// [CUSTOM-BEGIN] CUSTOM-20261101-005 - Serialized bounded logs with continuous rotation and bounded pending work.
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export class BoundedLogWriter {
  private tail: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private size: number | null = null;
  constructor(readonly file: string, private readonly maxBytes = 5 * 1024 * 1024, private readonly maxLineBytes = 64 * 1024) {}

  append(line: string): void {
    const raw = Buffer.from(line + '\n', 'utf8');
    const limit = Math.min(this.maxBytes, this.maxLineBytes);
    let end = Math.min(raw.length, limit - 1);
    while (end > 0 && (raw[end] & 0xc0) === 0x80) { end--; }
    const bytes = raw.length <= limit ? raw : Buffer.concat([raw.subarray(0, end), Buffer.from('\n')]);
    if (this.pendingBytes + bytes.length > 1024 * 1024) { return; }
    this.pendingBytes += bytes.length;
    this.tail = this.tail.then(async () => {
      await fs.mkdir(dirname(this.file), { recursive: true });
      if (this.size === null) {
        try { this.size = (await fs.stat(this.file)).size; } catch { this.size = 0; }
      }
      if (this.size + bytes.length > this.maxBytes) {
        await fs.rm(this.file + '.1', { force: true });
        try { await fs.rename(this.file, this.file + '.1'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
        this.size = 0;
      }
      await fs.appendFile(this.file, bytes);
      this.size += bytes.length;
    }).catch(() => { this.size = null; }).finally(() => { this.pendingBytes -= bytes.length; });
  }

  flush(): Promise<void> { return this.tail; }
}
// [CUSTOM-END] CUSTOM-20261101-005
