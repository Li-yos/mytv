import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  password: process.env.PASSWORD || '',
  adminpassword: process.env.ADMINPASSWORD || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function sha256Hash(input) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    hash.update(input);
    resolve(hash.digest('hex'));
  });
}

async function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (password !== '') {
    const sha256 = await sha256Hash(password);
    content = content.replace('{{PASSWORD}}', sha256);
  }
  // 添加ADMINPASSWORD注入
  if (config.adminpassword !== '') {
      const adminSha256 = await sha256Hash(config.adminpassword);
      content = content.replace('{{ADMINPASSWORD}}', adminSha256);
  } 
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }
    
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    
    // 从环境变量获取阻止的 IP 前缀
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;
    
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

// 修复反向代理处理过的路径
app.use('/proxy', (req, res, next) => {
  const targetUrl = req.url.replace(/^\//, '').replace(/(https?:)\/([^/])/, '$1//$2');
  req.url = '/' + encodeURIComponent(targetUrl);
  next();
});

// 代理路由
app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    // 安全验证
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的 URL');
    }

    log(`代理请求: ${targetUrl}`);

    // 判断是否为API请求
    const isApi = targetUrl.includes('/api.php/provide/vod') || req.headers.accept?.includes('application/json');

    const maxRetries = config.maxRetries;
    let retries = 0;

    const makeRequest = async () => {
      try {
        return await axios({
          method: 'get',
          url: targetUrl,
          responseType: isApi ? 'json' : 'stream',
          timeout: config.timeout,
          headers: {
            'User-Agent': config.userAgent,
            'Accept': req.headers.accept || (isApi ? 'application/json' : '*/*')
          }
        });
      } catch (error) {
        if (retries < maxRetries) {
          retries++;
          log(`重试请求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();
    const headers = { ...response.headers };
    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS ||
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');
    sensitiveHeaders.forEach(header => delete headers[header]);
    res.set(headers);

    if (isApi) {
      res.json(response.data);
    } else {
      response.data.pipe(res);
    }
  } catch (error) {
    console.error('代理请求错误:', error.message);
    if (error.response) {
      if (error.response.data && error.response.data.pipe) {
        res.status(error.response.status || 500);
        error.response.data.pipe(res);
      } else {
        res.status(error.response.status || 500).send(error.response.data || '代理请求失败');
      }
    } else {
      res.status(500).send(`请求失败: ${error.message}`);
    }
  }
});

// ========== 聚合API路由补全开始 ==========
// 由于 config.js 不是模块导出，直接读取和解析
import vm from 'vm';
const configJsPath = path.join(__dirname, 'js', 'config.js');
const configJsContent = fs.readFileSync(configJsPath, 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(configJsContent + '\nAPI_SITES = API_SITES; API_CONFIG = API_CONFIG;', sandbox);
const API_SITES = sandbox.API_SITES;
const API_CONFIG = sandbox.API_CONFIG;

// 聚合搜索接口
app.get('/api/search', async (req, res) => {
  try {
    const { wd = '', source, customApi } = req.query;
    let apiUrl = '';
    if (customApi) {
      apiUrl = `${customApi}${API_CONFIG.search.path}${encodeURIComponent(wd)}`;
    } else if (source && API_SITES[source]) {
      apiUrl = `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(wd)}`;
    } else {
      // 默认用 heimuer
      apiUrl = `${API_SITES.heimuer.api}${API_CONFIG.search.path}${encodeURIComponent(wd)}`;
    }
    // 通过本地代理
    const proxyUrl = `/proxy/${encodeURIComponent(apiUrl)}`;
    const response = await axios.get(`http://localhost:${config.port}${proxyUrl}`, {
      headers: API_CONFIG.search.headers,
      timeout: config.timeout
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ code: 500, msg: 'API聚合失败', error: error.message });
  }
});

// 详情接口
app.get('/api/detail', async (req, res) => {
  try {
    const { id = '', source, customApi } = req.query;
    let apiUrl = '';
    if (customApi) {
      apiUrl = `${customApi}${API_CONFIG.detail.path}${id}`;
    } else if (source && API_SITES[source]) {
      apiUrl = `${API_SITES[source].api}${API_CONFIG.detail.path}${id}`;
    } else {
      apiUrl = `${API_SITES.heimuer.api}${API_CONFIG.detail.path}${id}`;
    }
    // 通过本地代理
    const proxyUrl = `/proxy/${encodeURIComponent(apiUrl)}`;
    const response = await axios.get(`http://localhost:${config.port}${proxyUrl}`, {
      headers: API_CONFIG.detail.headers,
      timeout: config.timeout
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ code: 500, msg: '详情API失败', error: error.message });
  }
});
// ========== 聚合API路由补全结束 ==========

app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// 启动服务器
app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.password !== '') {
    console.log('用户登录密码已设置');
  }
  if (config.adminpassword !== '') {
    console.log('管理员登录密码已设置');
  }
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config, password: config.password ? '******' : '', adminpassword: config.adminpassword? '******' : '' });
  }
});
