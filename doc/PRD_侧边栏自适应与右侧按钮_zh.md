# PRD：侧边栏自适应宽度与对话窗格右侧工具栏

版本：v1.0
创建者：自动生成（AI 协助）
创建日期：2025-10-06

概述
---
本需求旨在调整扩展的弹窗与侧边栏布局：使侧边栏/弹窗宽度响应式、自适应（目前固定 400px 导致过宽），并在对话窗格右侧新增一列垂直工具栏。工具栏第一个按钮为“网页总结”（仅图标），并在鼠标悬停时显示 tooltip，工具栏保留额外按钮位以便未来扩展。

目标
---
- 使 `popup` 与 `sidebar` 在不同视口下表现更合理：默认最大宽度 360px、最小宽度 280px，宽度随容器收缩。
- 在对话窗格右侧添加垂直工具栏（宽度 56px），首个按钮为“网页总结”（仅图标、带 tooltip），工具栏在对话滚动时保持可见（sticky）。
- 移除输入区域底部的重复“网页总结”按钮，仅在右侧工具栏保留。
- 保持现有的视觉风格（毛玻璃 `.glass-panel`、`.btn.secondary` 样式），并保证无障碍（提供 tooltip）。

范围（Scope）
---
包括文件：`popup.html`、`sidebar.html`、`popup.css`、`popup.js`、`doc/` 中的 PRD 文档及 `CURSOR.md`/`README_zh.md` 的记录更新。

用户故事
---
- 作为一名用户，我希望侧边栏不要太宽，能在不同分辨率下自适应，以便在浏览器弹窗和侧边栏中有更舒适的阅读体验。
- 作为一名用户，我希望把“网页总结”按钮放在对话窗格右侧，随对话滚动保持可见，便于在任何时候触发页面抓取与摘要。

交互细节与 UX
---
- 侧栏/弹窗宽度：`max-width: 360px; min-width: 280px; width: 100%;`。
- 对话结构：在 `#chatContainer` 内新增 `.chat-wrapper`，包含 `.chat-main`（消息流）和 `.chat-toolbar`（垂直按钮列）。
- 工具栏：`.chat-toolbar { width:56px; display:flex; flex-direction:column; gap:8px; align-items:center; padding:8px; position:sticky; top: 12px; }`。
- 按钮：仅图标（建议 48x48px），使用现有 `.btn.secondary` 视觉风格；鼠标悬停显示 tooltip（例如 title 属性或轻量 tooltip 实现）。
- 在窄视口（<=320px）下，工具栏保持可访问性：若空间不足，可折叠（默认不在本 PRD 强制实现，视需后续扩展）。

非功能性需求
---
- 不改变后端行为与消息持久化逻辑。
- 保持对现有 DOM 查询与事件绑定的兼容，尽量复用 `#fetchAndSendBtn` 的事件句柄，仅调整选择器以匹配新位置。

验收标准
---
1. 在常见桌面分辨率下，弹窗宽度不再固定 400px，而是遵循 max/min 配置；侧栏在 280-360px 之间展示良好。
2. 对话窗格右侧出现垂直工具栏，首个按钮为“网页总结”图标，鼠标悬停显示说明文本。
3. 底部输入区不再显示“网页总结”按钮。
4. 点击工具栏“网页总结”行为与原先底部按钮一致（注入 content_fetch.js 并触发发送流程）。
5. 相关改动已记录在 `CURSOR.md` 与 `README_zh.md`（必要时）中。

实施步骤（高等级）
---
1. 添加本 PRD 到 `doc/`（已完成）。
2. 修改 `popup.css`：替换固定 `width:400px` 为响应式 `max-width/min-width/width`，并新增 `.chat-wrapper`、`.chat-toolbar` 的样式（继承现有毛玻璃与按钮样式）。
3. 修改 `popup.html` 与 `sidebar.html`：在 `#chatContainer` 内添加 `.chat-wrapper` 结构；将 `#fetchAndSendBtn` 从 `.input-actions` 移到 `.chat-toolbar`。
4. 修改 `popup.js`：在 `initializeElements()` 中更新 `this.fetchAndSendBtn` 的选择器（保持 id 不变即可），并在 `attachEventListeners()` 保持事件绑定；新增 tooltip 行为（`title` 属性或 mouseenter/mouseleave 简易实现）。
5. 运行手动验收：在不同窗口宽度下检查样式、在侧栏与弹窗中检查按钮位置与功能。
6. 更新 `CURSOR.md` 与 `README_zh.md` 变更记录。

测试计划
---
- 手动测试：在 Chrome 中调起扩展弹窗与侧边栏，验证宽度与工具栏显示、按钮触发抓取与返回行为、滚动时工具栏是否可见。
- 边界测试：窗口宽度为 280px、320px、360px、1024px 时的表现。

风险与回退
---
- 若新布局影响现有 DOM 查询（极少），将回退到同时保留原底部按钮的兼容实现（临时显示两个按钮）。

后续扩展
---
- 在工具栏中加入更多操作（例如：导出会话、复制会话链接、快速插入模板），以及小屏折叠策略。


