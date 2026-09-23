import * as vscode from 'vscode';

// [CUSTOM-BEGIN] CUSTOM-20260923-002 - 遥测已移除：上游硬编码了作者自己的 Application Insights
// 连接串并向其上报使用数据。本 fork 改为 no-op，保留同名 API 以免调用点扩散。
// 若将来需要重新启用，请换成自己的连接串，不要在 fork 中复用上游 key。
// [CUSTOM-END] CUSTOM-20260923-002

/**
 * No-op telemetry stub.  Kept API-compatible with the upstream
 * TelemetryManager so that call sites stay unchanged; every function
 * below deliberately does nothing.
 */
export function initTelemetry(): vscode.Disposable {
  return { dispose() {} };
}

/** No-op. */
export function sendEvent(
  _eventName: string,
  _properties?: Record<string, string>,
  _measurements?: Record<string, number>,
): void {}

/** No-op. */
export function sendError(
  _eventName: string,
  _properties?: Record<string, string>,
  _measurements?: Record<string, number>,
): void {}

/** No-op. */
export function sendException(_error: Error, _properties?: Record<string, string>): void {}
