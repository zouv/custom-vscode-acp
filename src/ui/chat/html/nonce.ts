// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// CSP nonce 生成。与旧面板保持同样的 32 字符字母数字形态（旧面板用 Math.random，
// 这里沿用同一实现以避免在同一进程里混用两种熵源）。
// [CUSTOM-END] CUSTOM-20260923-011
const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Generate a 32-character nonce suitable for a CSP `script-src` allowance. */
export function createNonce(): string {
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
  }
  return text;
}
