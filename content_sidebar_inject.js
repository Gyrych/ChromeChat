// 注入或切换侧边栏到当前页面
(function() {
    // 防止重复注入导致多个监听器
    if (window.__ollama_sidebar_injected) return;
    window.__ollama_sidebar_injected = true;

    const SIDEBAR_IFRAME_ID = 'ollama-assistant-sidebar-root';
    const SIDEBAR_CONTAINER_ID = 'ollama-assistant-sidebar-container';
    const STORAGE_KEY = 'ollama_sidebar_size';

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

        // 拖拽逻辑
        let dragging = false;
        let startX = 0, startY = 0, startW = 0, startH = 0;
        function onPointerDown(e) {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = container.getBoundingClientRect();
            startW = rect.width;
            startH = rect.height;
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
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

        function onPointerUp() {
            dragging = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
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

})();


