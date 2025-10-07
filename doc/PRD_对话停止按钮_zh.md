# PRD：对话停止按钮

## 背景
为增强用户在流式生成或长时任务中的控制能力，需要在弹窗与侧边栏的输入区新增“停止”按钮，允许用户中断当前与大模型的对话请求。

## 目的与目标
- 目标1：允许用户在模型正在响应时中断请求，避免等待或继续生成多余内容。
- 目标2：确保中断操作不会导致会话状态不一致或丢失已接收部分内容。
- 目标3：提供幂等且可恢复的中断行为，适用于流式与非流式请求。

## 范围
- 在 `popup.html` 与 `sidebar.html` 的输入区域，发送按钮右侧添加 `停止` 按钮（`id="stopMessageBtn"`）。
- 前端（`popup.js`）生成 `requestId` 并随发送消息发送到后台（`background.js`）。
- 后台对每个正在进行的请求维护 `AbortController`（或等价中止机制）。
- 用户点击 `停止` 时，前端向后台发送 `abortChat`（包含 `requestId`）消息，后台查找对应控制器并调用 `abort()`，随后向前端发送终止通知。

## 交互流程（详细）
1. 用户在输入框输入消息并点击 `发送`。
2. 前端生成唯一 `requestId`（如 `req_<timestamp>_<rand>`），将其保存在内存（`this._currentRequestId`），并将 `stop` 按钮设为可见/可用。
3. 前端通过 `chrome.runtime.sendMessage` 发送 `sendChat` 包含字段 `{ action: 'sendChat', requestId, url, model, messages, stream }`。
4. 后台在收到 `sendChat` 后，为该 `requestId` 创建 `AbortController` 并保存在映射 `activeRequests[requestId] = controller`。
5. 后台开始发起 `fetch`（或流式 fetch）并将 `controller.signal` 传入 `fetch` 的 `signal`；后台在过程中以当前实现的 NDJSON/流拆分逻辑继续向 popup 发送 `streamUpdate`。若 fetch 被中止，捕获异常并向 popup 发送 `streamError`（或 `streamUpdate` done=true 且含 `aborted: true`）。
6. 用户点击 `停止` 按钮时，前端发送 `abortChat` 消息 `{ action: 'abortChat', requestId }`。
7. 后台在收到 `abortChat` 后查找 `activeRequests[requestId]`，若存在则调用 `controller.abort()` 并从映射中删除该控制器，并返回确认；若对应 request 不存在或已完成，则返回无操作确认。
8. 前端在收到后台的终止确认或 `streamError` 后：
   - 移除 assistant 占位（或根据用户需求移除并展示“已取消”提示）；
   - 将当前 `this.currentMessageId` 清空；
   - 若需要，保存会话的当前已接收部分为 assistant 内容（视实现选择）。

## UI/无障碍
- `stopMessageBtn` 初始为 hidden 或 disabled；当发起请求并处于等待/流式接收时显示并启用。
- 按钮应具有 `aria-label="停止生成"`，支持键盘焦点与可访问性。

## 错误处理与边界
- 多次点击 `停止` 应为幂等操作。
- 如果后台未能找到对应 `requestId`，应返回一个无害的响应，前端仅根据情况显示提示（可选）。
- 若 fetch 抛出错误（网络/403/timeout），后台应发送 `streamError`，前端通过现有错误处理逻辑显示并清理占位。

## 技术实现要点
- 后台新增 `activeRequests` 映射对象管理 `AbortController`。
- 在 `fetchChatAndNotify` 和其他发起 fetch 的函数中接收 `requestId` 参数并使用对应 controller.signal。
- `sendChat` ACK 不变（仍先返回 success:true），实际处理在后台异步执行，需保持兼容性。

## 测试方案（手动）
1. 流式模式：发送一条会产生长流输出的消息，等待流开始后点击 `停止`，确认后台中止、前端移除占位且显示“已取消”。
2. 非流式模式：发送一个延时的非流式请求，点击 `停止`，确认请求被 aborted 且前端正确清理 UI。
3. 重复停止：在已停止或未发起请求时点击 `停止`，应无副作用且不崩溃。

## 回退策略
- 如果浏览器不支持 `AbortController`，使用一个标记位在后台忽略接收到的后续流并向 popup 发送终止通知。

## 文档更新
- 更新 `CURSOR.md` 与 `README_zh.md`/`README.md` 的变更记录，记录新增了“停止”按钮与后台中止支持。



请确认 PRD 内容或指出需要修改的部分，我随后会开始实现。
