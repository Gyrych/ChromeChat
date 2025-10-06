# PRD：浅色毛玻璃界面（Glassmorphism）

## 背景与目标

- 目的：为扩展的弹窗（`popup`）与侧边栏（`sidebar`）提供统一的、现代的浅色毛玻璃（frosted glass）界面，提升视觉质感与产品一致性。
- 范围：`popup.html`、`sidebar.html`、`popup.css` 的视觉与结构调整；同步更新 `CURSOR.md` 与 README（中/英）中的变更记录与说明。

## 设计规范

- 视觉基调：浅色、半透明白（白色半透明主体），配合原有品牌色 `#1976d2` 作为强调色。
- 毛玻璃参数：模糊程度采用中度，建议 `backdrop-filter: blur(12px)`；主体背景透明度建议在 `rgba(255,255,255,0.6)` 左右。
- 场景一致性：弹窗与侧边栏使用相同的容器类（`.glass-panel`），确保样式复用与一致性。
- 边框与阴影：使用轻微边框与柔和阴影以提升分层感—例如 `border: 1px solid rgba(255,255,255,0.6)` 与 `box-shadow: 0 6px 18px rgba(0,0,0,0.08)`。
- 圆角：统一使用 `8px` 圆角（与现有元素一致或略微调整为 8px）。

## 技术实现细节

1. 新增 CSS 类 `.glass-panel`，并把现有 `header`、`settings-panel`、`chat-container`、`input-area` 的背景替换为毛玻璃风格（通过在这些容器上添加 `.glass-panel` 或继承该样式）。

示例关键样式（概要）：
- `background: rgba(255,255,255,0.6);`
- `backdrop-filter: blur(12px);`
- `-webkit-backdrop-filter: blur(12px);`（兼容 WebKit）
- `border: 1px solid rgba(255,255,255,0.6);`
- `box-shadow: 0 6px 18px rgba(0,0,0,0.08);`

2. 降级方案：检测不支持 `backdrop-filter` 的环境时，采用纯半透明背景与更强的边框/阴影来维持对比。实现方式为：
- 在 CSS 中使用 `@supports (backdrop-filter: blur(12px))` 来应用带模糊的规则；在不支持时，默认规则使用 `background: rgba(255,255,255,0.9);` 和更明显的 `box-shadow`。

3. 交互元素（按钮、下拉等）将保留原有颜色与 hover 效果，但在半透明背景上调整对比度（例如 `.btn.primary` 使用 `background-color: rgba(25,118,210,0.95)` 以确保可见性）。

4. 复用性：新增 CSS 放在 `popup.css` 的顶部或靠近变量区域，并通过 `.glass-panel` 统一应用。侧边栏 `sidebar.html` 将继续复用 `popup.css`，并通过类名调整适配高度。

## 兼容性与降级策略

- Chrome 内核（支持 `backdrop-filter` 的现代版本）将呈现真实模糊效果。
- 若浏览器/平台不支持 `backdrop-filter`，使用半透明纯色背景（`rgba(255,255,255,0.9)`）并提升 `box-shadow` 强度以替代视觉深度。
- 保留无障碍对比：确保文字在半透明背景下的对比度满足可读性（强制按钮与消息气泡使用不透明或更高对比颜色）。

## 可访问性

- 保证文本对比度，尤其是消息泡、按钮、占位文本的对比。若必要，按钮使用几乎不透明的背景色（alpha >= 0.9）。
- 维持焦点环与键盘可访问性，不改变现有交互逻辑。

## 验收标准

- 弹窗与侧边栏的主要面板呈现浅色毛玻璃效果（在支持环境中有模糊），视觉统一且不影响功能。
- 在不支持 `backdrop-filter` 的环境下，页面仍能良好显示，文字可读性不低于修改前。
- 所有改动记录已写入 `CURSOR.md` 与 `README_zh.md` / `README.md` 的更新日志部分。

## 实施清单（原子任务）

1. 在 `popup.css` 顶部添加 `.glass-panel` 与降级 `@supports` 样式。
2. 将 `popup.html` 中顶级容器 `.container` 或各个分区（`.header`、`.settings-panel`、`.chat-container`、`.input-area`）添加 `.glass-panel` 类（或在 CSS 中改写选择器以作用于这些元素）。
3. 调整 `.btn.primary` 的背景色为半不透明方案以保证在玻璃背景上可见。
4. 在 `sidebar.html` 中确保使用相同 `.glass-panel` 类/结构（已复用 `popup.css`，但需在必要位置确保类名存在）。
5. 更新 `CURSOR.md`：在变更记录中追加“添加浅色毛玻璃界面”条目，记录变更文件与实现说明。
6. 更新 `README_zh.md` 与 `README.md`：在变更日志或功能更新中追加说明。
7. 执行样式回归检查并报告潜在可视问题（不自动提交代码，仅报告 linter/样式问题）。


---

我将现在创建该 PRD 文件（已准备好写入）。创建完成后，我会把当前任务 `1-create-prd` 标记为已完成，并把下一个任务 `2-add-glass-css` 标记为 in_progress，然后开始实现 CSS 修改（会先在 `popup.css` 中添加 `.glass-panel` 和降级规则）。
