// proxy.js
// 本地开发代理：将 /api/* 转发到本地 Ollama 服务，并添加 CORS 响应头
// 仅用于本地开发调试，请勿公开部署或长期使用

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const APP_PORT = process.env.PROXY_PORT || 41111;
const OLLAMA_TARGET = process.env.OLLAMA_TARGET || 'http://localhost:11434';

const app = express();

// CORS 中间件：允许所有来源，方便本地开发调试
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  // 记录传入请求，便于调试 404/403 问题
  try {
    console.log(`[proxy] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
    // 只打印常用头，避免泄露敏感信息
    const headersToLog = ['origin', 'content-type', 'user-agent', 'referer'];
    const logged = {};
    headersToLog.forEach(h => { if (req.headers[h]) logged[h] = req.headers[h]; });
    console.log('[proxy] headers:', JSON.stringify(logged));
  } catch (e) {
    console.warn('[proxy] log error', e);
  }
  // 追加写入文件，便于在后台查看历史请求（不会记录请求体以避免敏感信息泄露）
  try {
    const fs = require('fs');
    const logLine = `${new Date().toISOString()} ${req.method} ${req.originalUrl} HEADERS ${JSON.stringify(logged)}\n`;
    fs.appendFileSync('proxy_internal.log', logLine);
  } catch (e) {
    console.warn('[proxy] write file error', e);
  }
  next();
});

// 转发 /api 到 Ollama
app.use('/api', createProxyMiddleware({
  target: OLLAMA_TARGET,
  changeOrigin: true,
  pathRewrite: { '^/api': '/api' },
  onProxyReq(proxyReq, req, res) {
    // 确保 Content-Type 被设置
    if (req.headers['content-type']) {
      proxyReq.setHeader('Content-Type', req.headers['content-type']);
    }
  },
  onProxyRes(proxyRes, req, res) {
    try {
      console.log(`[proxy] proxied ${req.method} ${req.originalUrl} -> ${proxyRes.statusCode}`);
    } catch (e) {
      console.warn('[proxy] onProxyRes log error', e);
    }
  },
  onError(err, req, res) {
    console.error('Proxy error:', err && err.message);
    res.status(502).send('Bad gateway');
  }
}));

app.listen(APP_PORT, () => {
  console.log(`Local proxy running: http://localhost:${APP_PORT} -> ${OLLAMA_TARGET}`);
});


