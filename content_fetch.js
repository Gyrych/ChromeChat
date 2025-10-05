(function() {
    // 尝试提取页面主体的文本块
    function normalizeText(s) {
        return s.replace(/\s+/g, ' ').trim();
    }

    function isVisible(el) {
        try {
            const style = window.getComputedStyle(el);
            if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            return true;
        } catch (e) { return false; }
    }

    // 更稳健的抓取流程：复制 body 并移除非正文元素（button/label/form/nav/header/footer/aside/input/textarea/select 等），
    // 然后在副本中按标签收集正文块，避免按钮、标签等元素的文本干扰。
    const candidateTexts = [];
    try {
        const bodyClone = document.body ? document.body.cloneNode(true) : null;
        if (bodyClone) {
            const removeSelectors = [
                'button', 'label', 'nav', 'header', 'footer', 'aside', 'form', 'input', 'textarea', 'select',
                'script', 'style', 'noscript', 'svg', '.nav', '.sidebar', '.advert', '.ads', '.ad', '[role="navigation"]',
                '.cookie', '.cookie-banner', '.consent', '.breadcrumb'
            ];
            for (const sel of removeSelectors) {
                try {
                    const els = Array.from(bodyClone.querySelectorAll(sel));
                    for (const e of els) {
                        e.remove();
                    }
                } catch (e) { /* ignore selector errors */ }
            }

            // 收集候选节点并计算文本长度与 link density，优先选择文本多且链接密度低的节点
            const selectors = ['article', 'main', 'section', 'div', 'p', 'td'];
            const nodeSet = new Set();
            for (const sel of selectors) {
                const nodes = Array.from(bodyClone.querySelectorAll(sel));
                for (const n of nodes) nodeSet.add(n);
            }

            function textLengthOf(node) {
                try { return normalizeText(node.innerText || node.textContent || '').length; } catch (e) { return 0; }
            }

            function wordsCount(node) {
                try { return normalizeText(node.innerText || node.textContent || '').split(/\s+/).filter(Boolean).length; } catch (e) { return 0; }
            }

            function linkDensity(node) {
                try {
                    const text = normalizeText(node.innerText || node.textContent || '');
                    if (!text) return 0;
                    const linkTexts = Array.from(node.querySelectorAll('a')).map(a => normalizeText(a.innerText || a.textContent || '')).filter(Boolean);
                    const linkLen = linkTexts.join(' ').length;
                    return Math.min(1, linkLen / Math.max(1, text.length));
                } catch (e) { return 1; }
            }

            const candidates = [];
            for (const n of nodeSet) {
                try {
                    const text = normalizeText(n.innerText || n.textContent || '');
                    if (!text) continue;
                    const words = text.split(/\s+/).filter(Boolean).length;
                    const MIN_WORDS = 60;
                    if (words < MIN_WORDS) continue;
                    const ld = linkDensity(n);
                    // 排除链接密度过高的导航类块
                    if (ld > 0.25) continue;
                    const score = words * (1 - ld);
                    candidates.push({ node: n, text, words, len: text.length, ld, score });
                } catch (e) { /* ignore */ }
            }

            // 按 score 降序，去重并取前几个大的段落
            candidates.sort((a, b) => b.score - a.score);
            const seen = new Set();
            for (const c of candidates) {
                const s = c.text.slice(0, 200);
                if (seen.has(s)) continue;
                seen.add(s);
                candidateTexts.push({ text: c.text, len: c.len, words: c.words });
                if (candidateTexts.length >= 6) break;
            }
        }
    } catch (e) {
        // 回退：如果复制/移除过程失败，仍然尝试从 document 抽取较大段落
        const nodes = Array.from(document.querySelectorAll('p,article,main,section,div'));
        for (const n of nodes) {
            try {
                if (!isVisible(n)) continue;
                const tag = (n.tagName || '').toLowerCase();
                if (['nav','header','footer','aside','script','style','noscript'].includes(tag)) continue;
                const text = normalizeText(n.innerText || n.textContent || '');
                if (!text) continue;
                if (text.split(' ').length < 40) continue;
                candidateTexts.push({ text, len: text.length, words: text.split(' ').length });
            } catch (er) { /* ignore */ }
        }
    }

    // 按长度降序，去重并限制最大块数
    const unique = [];
    const seen = new Set();
    candidateTexts.sort((a,b) => b.len - a.len);
    for (const t of candidateTexts) {
        const key = t.text.slice(0, 200);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(t.text);
        if (unique.length >= 10) break;
    }

    // 如果没有足够的段落，回退到 document.body.innerText 的前若干段
    if (unique.length === 0) {
        const bodyText = normalizeText(document.body ? document.body.innerText : (document.body && document.body.textContent) || '');
        // 按换行拆分并选取长度较大的前几项
        const parts = bodyText.split(/\n{2,}|\r\n{2,}/).map(s => normalizeText(s)).filter(Boolean);
        const MIN_WORDS = 60; // 与上面一致的最小词数阈值
        for (const p of parts) {
            if (p.split(' ').length < MIN_WORDS) continue;
            unique.push(p);
            if (unique.length >= 10) break;
        }
        if (unique.length === 0 && bodyText) {
            // 最后回退：按字符分段
            const chunkSize = 12000;
            for (let i = 0; i < bodyText.length; i += chunkSize) unique.push(bodyText.slice(i, i + chunkSize));
        }
    }

    const result = {
        title: document.title || '',
        url: window.location.href || '',
        textBlocks: unique
    };

    // 将结果挂载到 page window，供注入脚本之后通过 executeScript 读取
    try { window.__chrome_fetch_result = result; } catch (e) { /* ignore */ }
    // 返回结果，确保 chrome.scripting.executeScript 能够接收到执行结果
    return result;
})();
