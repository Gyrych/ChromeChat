// 注入或切换侧边栏到当前页面
(function() {
    // 防止重复注入导致多个监听器
    if (window.__ollama_sidebar_injected) return;
    window.__ollama_sidebar_injected = true;

    const SIDEBAR_IFRAME_ID = 'ollama-assistant-sidebar-root';
    const SIDEBAR_CONTAINER_ID = 'ollama-assistant-sidebar-container';
    const STORAGE_KEY = 'ollama_sidebar_size';
    const HANDLE_POS_KEY = 'ollama_sidebar_handle_pos';

    // 读取/保存上次尺寸
    function readSize() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { return null; }
    }
    function saveSize(obj) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }

    function createSidebar() {
        // 防止重复注入
        if (document.getElementById(SIDEBAR_CONTAINER_ID)) return;

        const saved = readSize();

        // 容器，用于实现可拖拽的分隔条
        const container = document.createElement('div');
        container.id = SIDEBAR_CONTAINER_ID;
        container.style.position = 'fixed';
        container.style.top = '0';
        container.style.right = '0';
        container.style.height = '100vh';
        container.style.zIndex = '2147483647';
        container.style.boxSizing = 'border-box';
        container.style.display = 'flex';
        container.style.flexDirection = 'row';
        container.style.alignItems = 'stretch';

        const isNarrowViewport = window.innerWidth <= 520;

        // 初始尺寸与响应式策略
        if (isNarrowViewport) {
            // 底部模式：使用百分比高度（默认 50%）
            const defaultHPercent = 50;
            const hPercent = saved && saved.mode === 'bottom' && saved.hPercent ? saved.hPercent : defaultHPercent;
            const hPx = Math.max(120, Math.min(window.innerHeight - 80, Math.floor(window.innerHeight * (hPercent / 100))));
            container.style.width = '100%';
            container.style.height = hPx + 'px';
            container.style.left = '0';
            container.style.right = '0';
            container.style.bottom = '0';
            container.style.top = 'auto';
            container.style.flexDirection = 'column';
            // 将页面内容向上推
            pushPageByBottom(hPx + 'px');
        } else {
            // 侧栏模式：使用百分比宽度（默认 30%），并限制最小/最大
            const defaultWPercent = 30; // 百分比
            const wPercent = saved && saved.mode === 'side' && typeof saved.wPercent === 'number' ? saved.wPercent : defaultWPercent;
            const calcW = Math.max(240, Math.min(Math.floor(window.innerWidth * 0.8), Math.floor(window.innerWidth * (wPercent / 100))));
            container.style.width = calcW + 'px';
            container.style.right = '0';
            // 将页面内容向左推以给出侧边栏空间
            pushPageByRight(calcW + 'px');
        }

        // 分隔条（左侧）用于水平调整宽度；在窄屏时变为顶部用于垂直调整高度
        const resizer = document.createElement('div');
        resizer.className = 'ollama-sidebar-resizer';
        resizer.style.background = 'transparent';
        resizer.style.flex = '0 0 auto';
        resizer.style.width = isNarrowViewport ? '100%' : '8px';
        resizer.style.height = isNarrowViewport ? '8px' : '100%';
        resizer.style.cursor = isNarrowViewport ? 'row-resize' : 'col-resize';
        resizer.style.position = 'relative';

        // 可视化提示条（细线）
        const handle = document.createElement('div');
        handle.style.width = isNarrowViewport ? '100%' : '2px';
        handle.style.height = isNarrowViewport ? '2px' : '100%';
        handle.style.background = 'rgba(0,0,0,0.08)';
        handle.style.margin = isNarrowViewport ? '3px 0' : '0 3px';
        handle.style.borderRadius = '2px';
        handle.style.alignSelf = 'center';
        resizer.appendChild(handle);

        // iframe
        const iframe = document.createElement('iframe');
        iframe.id = SIDEBAR_IFRAME_ID;
        iframe.src = chrome.runtime.getURL('sidebar.html');
        iframe.style.flex = '1 1 auto';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = '0';
        iframe.style.background = 'white';
        iframe.style.boxShadow = '0 0 12px rgba(0,0,0,0.12)';
        // 确保 iframe 加载后，将 body 标记为 sidebar 模式，以便 CSS 中的
        // `body:not(.sidebar)` 规则不会限制其宽度，从而允许注入容器调整大小
        iframe.addEventListener('load', () => {
            try {
                const docBody = iframe.contentDocument && iframe.contentDocument.body;
                if (docBody && !docBody.classList.contains('sidebar')) docBody.classList.add('sidebar');
            } catch (e) {
                // 跨域或其它原因无法访问 iframe 内容时不抛出错误，仅记录
                console.warn('Could not set sidebar class on iframe body', e);
            }
        });

        // 组装
        if (isNarrowViewport) {
            // 窄屏：顶部为 resizer（调整高度），iframe 在下方
            container.appendChild(resizer);
            container.appendChild(iframe);
        } else {
            // 宽屏：resizer 在左，iframe 在右
            container.appendChild(resizer);
            container.appendChild(iframe);
        }

        document.documentElement.appendChild(container);

        // 拖拽逻辑（改进以防止在向右拖拽时被 iframe 或页面元素中断）
        let dragging = false;
        let startX = 0, startY = 0, startW = 0, startH = 0, startPointerId = null;
        function onPointerDown(e) {
            e.preventDefault();
            dragging = true;
            startPointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            const rect = container.getBoundingClientRect();
            startW = rect.width;
            startH = rect.height;

            // 使 resizer 捕获指针，保证在 pointer 移动到 iframe 或其它元素上时仍能接收事件
            try { if (resizer.setPointerCapture) resizer.setPointerCapture(startPointerId); } catch (err) { /* ignore */ }

            // 在拖拽期间禁用 iframe 的 pointer events，避免 iframe 拦截指针导致移动中断
            try { iframe.style.pointerEvents = 'none'; } catch (err) { /* ignore */ }

            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
        }

        function onPointerMove(e) {
            if (!dragging) return;
            if (isNarrowViewport) {
                // 调整高度（向上拖拽使栏更高）
                const dy = startY - e.clientY;
                let nh = Math.max(120, Math.min(window.innerHeight - 80, startH + dy));
                container.style.height = nh + 'px';
                // 保存为百分比，便于响应式恢复
                const hPercent = Math.round((nh / window.innerHeight) * 100);
                saveSize({ mode: 'bottom', hPercent: hPercent });
                pushPageByBottom(nh + 'px');
            } else {
                const dx = startX - e.clientX;
                let nw = Math.max(240, Math.min(Math.floor(window.innerWidth * 0.8), startW + dx));
                container.style.width = nw + 'px';
                const wPercent = Math.round((nw / window.innerWidth) * 100);
                saveSize({ mode: 'side', wPercent: wPercent });
                pushPageByRight(nw + 'px');
            }
        }

        function onPointerUp(e) {
            dragging = false;
            // 恢复 iframe 的 pointer events
            try { iframe.style.pointerEvents = ''; } catch (err) { /* ignore */ }

            // 释放指针捕获
            try { if (startPointerId !== null && resizer.releasePointerCapture) resizer.releasePointerCapture(startPointerId); } catch (err) { /* ignore */ }
            startPointerId = null;

            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);
        }

        resizer.addEventListener('pointerdown', onPointerDown);

        // 双击重置为默认尺寸
        resizer.addEventListener('dblclick', () => {
            if (isNarrowViewport) {
                container.style.height = '50vh';
                saveSize({ mode: 'bottom', h: Math.floor(window.innerHeight * 0.5) });
            } else {
                container.style.width = '360px';
                saveSize({ mode: 'side', w: 360 });
            }
        });
    }

    function removeSidebar() {
        const cont = document.getElementById(SIDEBAR_CONTAINER_ID);
        if (cont) cont.remove();
        // 恢复页面 margin
        restorePagePush();
    }

    // 接收来自 background 的消息以切换侧边栏
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || !msg.action) return;
        if (msg.action === 'toggleSidebarInPage') {
            const present = !!document.getElementById(SIDEBAR_CONTAINER_ID);
            if (present) removeSidebar(); else createSidebar();
            sendResponse({ success: true, present: !present });
        }
    });

    // 将页面主体向左推以给侧边栏留出空间（右侧）
    function pushPageByRight(px) {
        try {
            const body = document.body || document.documentElement;
            // 保存原始 margin-right
            if (window.__ollama_sidebar_prev_marginRight === undefined) window.__ollama_sidebar_prev_marginRight = body.style.marginRight || '';
            body.style.transition = 'margin-right 0.2s ease';
            body.style.marginRight = px;
        } catch (e) { console.warn('pushPageByRight failed', e); }
    }

    // 将页面主体向上推以给底部面板留出空间
    function pushPageByBottom(px) {
        try {
            const body = document.body || document.documentElement;
            if (window.__ollama_sidebar_prev_marginBottom === undefined) window.__ollama_sidebar_prev_marginBottom = body.style.marginBottom || '';
            body.style.transition = 'margin-bottom 0.2s ease';
            body.style.marginBottom = px;
        } catch (e) { console.warn('pushPageByBottom failed', e); }
    }

    function restorePagePush() {
        try {
            const body = document.body || document.documentElement;
            if (window.__ollama_sidebar_prev_marginRight !== undefined) body.style.marginRight = window.__ollama_sidebar_prev_marginRight || '';
            if (window.__ollama_sidebar_prev_marginBottom !== undefined) body.style.marginBottom = window.__ollama_sidebar_prev_marginBottom || '';
            // 清理临时保存
            window.__ollama_sidebar_prev_marginRight = undefined;
            window.__ollama_sidebar_prev_marginBottom = undefined;
        } catch (e) { console.warn('restorePagePush failed', e); }
    }

    // 右侧把手：半露胶囊样式，hover 滑出并支持键盘操作
    function createSidebarHandle() {
        try {
            if (document.getElementById('ollama-sidebar-handle')) return;
            const handle = document.createElement('div');
            handle.id = 'ollama-sidebar-handle';
            // 半露胶囊样式：默认一半隐藏在页面右侧，hover/聚焦时滑出
            handle.style.position = 'fixed';
            // 默认向右偏移一半宽度，使其半露在页面边缘
            handle.style.right = '-24px';
            // 优先恢复之前保存的位置（百分比 vh），否则默认居中
            const savedHandlePos = (function(){ try { const v = localStorage.getItem(HANDLE_POS_KEY); return v !== null ? parseFloat(v) : null; } catch(e) { return null; } })();
            if (savedHandlePos !== null && !Number.isNaN(savedHandlePos)) {
                handle.style.top = savedHandlePos + 'vh';
            } else {
                handle.style.top = '50%';
            }
            handle.style.transform = 'translateY(-50%)';
            // 胶囊尺寸（高保持圆形）——适配 32px 图标
            handle.style.width = '48px';
            handle.style.height = '48px';
            handle.style.display = 'flex';
            handle.style.alignItems = 'center';
            handle.style.justifyContent = 'flex-start';
            handle.style.paddingLeft = '6px';
            handle.style.background = 'white';
            handle.style.border = '1px solid rgba(0,0,0,0.12)';
            handle.style.borderRadius = '24px 0 0 24px';
            handle.style.boxShadow = '0 6px 18px rgba(0,0,0,0.18)';
            handle.style.cursor = 'pointer';
            handle.style.zIndex = '2147483647';
            handle.style.transition = 'right 180ms cubic-bezier(.2,.8,.2,1), box-shadow 180ms ease, transform 180ms ease, opacity 180ms ease';
            handle.style.opacity = '0.98';

            const img = document.createElement('img');
            img.src = chrome.runtime.getURL('icons/icon32.png');
            img.style.width = '32px';
            img.style.height = '32px';
            img.style.display = 'block';
            img.style.opacity = '1';
            img.style.marginRight = '4px';
            img.alt = 'ChromeChat';
            handle.appendChild(img);

            // 标签：默认隐藏，hover/展开时显示文本
            const label = document.createElement('span');
            label.textContent = 'ChromeChat';
            label.style.fontFamily = 'sans-serif';
            label.style.fontSize = '14px';
            label.style.color = '#111';
            label.style.marginLeft = '6px';
            label.style.opacity = '0';
            label.style.maxWidth = '0px';
            label.style.whiteSpace = 'nowrap';
            label.style.overflow = 'hidden';
            label.style.transition = 'opacity 160ms ease, max-width 160ms ease';
            handle.appendChild(label);

            handle.title = '打开/关闭 ChromeChat 侧边栏';
            // 鼠标进入时滑出，离开时收回
            // 鼠标进入时滑出，离开时收回（若未在拖拽中）
            let isHandleDragging = false;
            handle.addEventListener('pointerenter', (ev) => {
                if (isHandleDragging) return;
                try {
                    handle.style.right = '8px';
                    handle.style.boxShadow = '0 8px 28px rgba(0,0,0,0.24)';
                    // 显示标签
                    label.style.maxWidth = '160px';
                    label.style.opacity = '1';
                } catch (e) {}
            });
            handle.addEventListener('pointerleave', (ev) => {
                if (isHandleDragging) return;
                try {
                    handle.style.right = '-24px';
                    handle.style.boxShadow = '0 6px 18px rgba(0,0,0,0.18)';
                    // 隐藏标签
                    label.style.opacity = '0';
                    label.style.maxWidth = '0px';
                } catch (e) {}
            });
            // 支持键盘操作（Enter/Space）
            handle.tabIndex = 0;
            handle.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const present = !!document.getElementById(SIDEBAR_CONTAINER_ID);
                    if (present) removeSidebar(); else createSidebar();
                }
            });

            // 拖拽逻辑：上下拖动以改变位置并保存为 vh 百分比
            let handleDragActive = false;
            let handleDragStartY = 0;
            let handleDragStartCenter = 0;
            function onHandlePointerMove(ev) {
                if (!handleDragActive) return;
                ev.preventDefault();
                const dy = ev.clientY - handleDragStartY;
                let newCenter = handleDragStartCenter + dy;
                const half = handle.offsetHeight / 2;
                const minCenter = 8 + half;
                const maxCenter = Math.max(half + 8, window.innerHeight - 8 - half);
                newCenter = Math.max(minCenter, Math.min(maxCenter, newCenter));
                // 以 px 设置 center top，保留 translateY(-50%) 以居中对齐
                handle.style.top = newCenter + 'px';
                // 持久化为视口高度百分比（vh），便于不同分辨率恢复
                try { localStorage.setItem(HANDLE_POS_KEY, String(Math.round((newCenter / window.innerHeight) * 100))); } catch (e) {}
                isHandleDragging = true;
            }
            function onHandlePointerUp(ev) {
                if (!handleDragActive) return;
                handleDragActive = false;
                try { if (ev && ev.pointerId && handle.releasePointerCapture) handle.releasePointerCapture(ev.pointerId); } catch (e) {}
                document.removeEventListener('pointermove', onHandlePointerMove);
                document.removeEventListener('pointerup', onHandlePointerUp);
                // 结束拖拽后短暂显示滑出效果然后收回
                try {
                    handle.style.right = '-24px';
                    handle.style.boxShadow = '0 6px 18px rgba(0,0,0,0.18)';
                    // 拖拽结束时隐藏标签
                    label.style.opacity = '0';
                    label.style.maxWidth = '0px';
                } catch (e) {}
                // 延迟清除标志，避免与 click 冲突
                setTimeout(() => { isHandleDragging = false; }, 50);
            }
            handle.addEventListener('pointerdown', (ev) => {
                // 仅响应主键
                if (ev.button !== 0) return;
                try { handle.setPointerCapture && handle.setPointerCapture(ev.pointerId); } catch (e) {}
                handleDragActive = true;
                handleDragStartY = ev.clientY;
                const rect = handle.getBoundingClientRect();
                handleDragStartCenter = rect.top + rect.height / 2;
                document.addEventListener('pointermove', onHandlePointerMove);
                document.addEventListener('pointerup', onHandlePointerUp);
            });

            // 点击切换侧边栏（如果不是拖拽引发的点击）
            handle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isHandleDragging) return; // 拖拽后不要触发点击
                const present = !!document.getElementById(SIDEBAR_CONTAINER_ID);
                if (present) removeSidebar(); else createSidebar();
            });

            // 避免在某些页面样式中被遮挡或截断，挂载到 documentElement
            document.documentElement.appendChild(handle);
        } catch (err) { console.warn('createSidebarHandle failed', err); }
    }

    // 尝试创建把手（如果注入脚本已运行，则立即创建）
    try { createSidebarHandle(); } catch (e) { /* ignore */ }
})();


