const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const unzipper = require('unzipper');
const { spawn } = require('child_process');

const app = express();
const PORT = 3000;
const ASSET_DIR = path.join(__dirname, 'shell-assets');

// Render/Vercel sit behind proxies; respect x-forwarded-* for absolute URL building.
app.set('trust proxy', true);

app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(
  '/assets/shell',
  express.static(ASSET_DIR, {
    setHeaders: (res, filePath) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const lower = String(filePath || '').toLowerCase();
      if (lower.endsWith('.glb')) {
        res.setHeader('Content-Type', 'model/gltf-binary');
        res.setHeader('Content-Disposition', 'attachment; filename="shell.glb"');
      } else if (lower.endsWith('.gltf')) {
        res.setHeader('Content-Type', 'model/gltf+json');
        res.setHeader('Content-Disposition', 'attachment; filename="shell.gltf"');
      } else if (lower.endsWith('.obj')) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="shell.obj"');
      }
    },
  })
);

app.get('/', (_req, res) => {
  res.status(200).send('AUTO-GEN API running');
});

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

const logError = (label, err, extra) => {
  const message = err && err.message ? err.message : String(err);
  const payload = extra ? ` | extra=${JSON.stringify(extra)}` : '';
  console.error(`[${new Date().toISOString()}] ${label} :: ${message}${payload}`);
};

const ensureAssetsDir = async () => {
  try {
    await fsp.mkdir(ASSET_DIR, { recursive: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] asset_dir :: ${err.message || err}`);
  }
};

ensureAssetsDir();

const getPublicBase = (req) => {
  if (process.env.API_PUBLIC_BASE) return process.env.API_PUBLIC_BASE;
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwarded || 'https';
  return `${proto}://${req.get('host')}`;
};

const normalizePath = (rawPath) => rawPath.split(path.sep).join('/');
const stripQuery = (rawUrl) => rawUrl.split('?')[0].split('#')[0];
const getUrlExt = (rawUrl) => {
  const clean = stripQuery(String(rawUrl || '')).toLowerCase();
  const idx = clean.lastIndexOf('.');
  return idx >= 0 ? clean.slice(idx + 1) : '';
};

const downloadToFile = async (rawUrl, destPath) => {
  const parsed = new URL(rawUrl);
  const client = parsed.protocol === 'http:' ? http : https;
  await new Promise((resolve, reject) => {
    const req = client.get(parsed, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`download failed: ${res.statusCode}`));
        return;
      }
      const fileStream = fs.createWriteStream(destPath);
      pipeline(res, fileStream).then(resolve).catch(reject);
    });
    req.on('error', reject);
  });
};

const collectFiles = async (dir, acc = []) => {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
};

const findModelFile = async (dir) => {
  const files = await collectFiles(dir);
  const lower = files.map((file) => ({ file, lower: file.toLowerCase() }));
  const pickByExt = (ext) => {
    const match = lower.find((item) => item.lower.endsWith(ext));
    return match ? match.file : '';
  };
  return pickByExt('.glb') || pickByExt('.gltf') || pickByExt('.obj') || '';
};

const extractZipToAssets = async (zipUrl, jobId) => {
  const safeId = String(jobId || 'seed3d').replace(/[^a-zA-Z0-9_-]/g, '');
  const destDir = path.join(ASSET_DIR, safeId);
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  const zipPath = path.join(destDir, 'source.zip');
  await downloadToFile(zipUrl, zipPath);
  await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: destDir })).promise();
  await fsp.unlink(zipPath).catch(() => {});
  const modelPath = await findModelFile(destDir);
  if (!modelPath) {
    throw new Error('ZIP unpacked but model file not found');
  }
  const rel = normalizePath(path.relative(ASSET_DIR, modelPath));
  return { modelPath, relUrl: `/assets/shell/${rel}` };
};

const cacheRemoteModelToAssets = async (remoteUrl, jobId) => {
  const ext = getUrlExt(remoteUrl);
  const safeId = String(jobId || 'seed3d').replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName = `${safeId}.${ext || 'glb'}`;
  const destPath = path.join(ASSET_DIR, fileName);
  await downloadToFile(remoteUrl, destPath);
  return { filePath: destPath, relUrl: `/assets/shell/${fileName}` };
};

const cleanBase64 = (raw) => {
  if (!raw) return '';
  let value = String(raw);
  if (value.startsWith('data:')) {
    value = value.split(',', 2)[1] || '';
  }
  return value.replace(/\s+/g, '');
};

const saveBase64ImageToAssets = async (rawBase64, prefix = 'shell') => {
  const base64 = cleanBase64(rawBase64);
  if (!base64) throw new Error('Empty imageBase64');
  const safeId = `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`.replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName = `${safeId}.jpg`;
  const filePath = path.join(ASSET_DIR, fileName);
  const buf = Buffer.from(base64, 'base64');
  await fsp.writeFile(filePath, buf);
  return { filePath, relUrl: `/assets/shell/${fileName}` };
};

app.get('/api/shell/fetch', (req, res) => {
  const allowed = [
    'tencentcos.cn',
    'volces.com',
    'volcengine.com',
    'volcengineapi.com',
    'bytedance.com',
    'bytedance.net',
    'byteimg.com',
    'bytecdn.cn',
    'onrender.com',
  ];

  const isAllowed = (rawUrl) => {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const selfHost = String(req.get('host') || '').split(':')[0].toLowerCase();
    if (hostname === selfHost) return true;
    return allowed.some((suffix) => hostname.endsWith(suffix));
  };

  const proxyUrl = (rawUrl, depth = 0) => {
    if (depth > 3) {
      res.status(502).json({ error: 'too many redirects' });
      return;
    }
    if (!isAllowed(rawUrl)) {
      res.status(403).json({ error: 'host not allowed' });
      return;
    }
    const parsed = new URL(rawUrl);
    const client = parsed.protocol === 'http:' ? http : https;
    client
      .get(parsed, (remote) => {
        if ([301, 302, 307, 308].includes(remote.statusCode)) {
          const location = remote.headers.location;
          if (!location) {
            res.status(502).json({ error: 'redirect without location' });
            return;
          }
          proxyUrl(location, depth + 1);
          return;
        }
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (remote.headers['content-type']) {
          res.setHeader('Content-Type', remote.headers['content-type']);
        }
        remote.pipe(res);
      })
      .on('error', (err) => {
        res.status(502).json({ error: err.message || String(err) });
      });
  };

  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    proxyUrl(rawUrl, 0);
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

const runJimeng = (payload) =>
  new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'scripts', 'jimeng_api.py');
    const venvPython = '/opt/venv/bin/python';
    const pythonBin = fs.existsSync(venvPython)
        ? venvPython
        : (process.env.PYTHON_BIN || 'python');
    const proc = spawn(pythonBin, [script], {
      env: {
        ...process.env,
        JIMENG_USE_RAW: '0',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    proc.stdout.on('data', (data) => {
      out += data.toString();
    });
    proc.stderr.on('data', (data) => {
      err += data.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err || `jimeng_api.py exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()));
      } catch (e) {
        reject(new Error(`Jimeng output is not JSON: ${out}`));
      }
    });
    proc.stdin.write(JSON.stringify(payload || {}));
    proc.stdin.end();
  });

const callSeed3d = async (pathUrl, body, method = 'POST') => {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) throw new Error('Missing ARK_API_KEY');
  const baseUrl = process.env.SEED3D_BASE_URL || 'https://ark.cn-beijing.volces.com';
  const timeoutMs = Number(process.env.ARK_TIMEOUT_MS || 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${pathUrl}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Seed3D API error ${res.status}: ${text}`);
    return JSON.parse(text);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Seed3D request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

const callArkImages = async (prompt) => {
  // Default to a widely-available Seedream model on Ark.
  // Model ids are versioned (e.g. doubao-seedream-4-0-250828).
  const model = process.env.SHELL_IMAGE_MODEL || 'doubao-seedream-4-0-250828';
  const size = process.env.SHELL_IMAGE_SIZE || '1024x576'; // 16:9
  const payload = {
    model,
    prompt,
    n: 1,
    size,
    response_format: 'url',
  };
  return callSeed3d('/api/v3/images/generations', payload, 'POST');
};

const pickUrlFromValue = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = pickUrlFromValue(item);
      if (url) return url;
    }
    return '';
  }
  if (typeof value === 'object') {
    return value.url || value.Url || value.file_url || value.fileUrl || '';
  }
  return '';
};

const pickModelFileUrl = (content) => {
  if (!content || typeof content !== 'object') return '';
  const candidates = [
    content.file_url,
    content.fileUrl,
    content.file_urls,
    content.files,
    content.outputs,
    content.result_files,
    content.data,
    content.result,
    content.output,
  ];
  let fallback = '';
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const url = pickUrlFromValue(entry);
        if (!url) continue;
        if (url.toLowerCase().includes('.glb') || url.toLowerCase().includes('.gltf')) {
          return url;
        }
        if (!fallback) fallback = url;
      }
      continue;
    }
    const url = pickUrlFromValue(candidate);
    if (!url) continue;
    if (url.toLowerCase().includes('.glb') || url.toLowerCase().includes('.gltf')) {
      return url;
    }
    if (!fallback) fallback = url;
  }
  return fallback;
};

const pickPreviewUrl = (content) => {
  if (!content || typeof content !== 'object') return '';
  const candidates = [
    content.last_frame_url,
    content.preview_url,
    content.previewUrl,
    content.preview_image_url,
    content.previewImageUrl,
    content.cover_url,
    content.coverUrl,
    content.data,
  ];
  for (const candidate of candidates) {
    const url = pickUrlFromValue(candidate);
    if (url) return url;
  }
  return '';
};

const callDeepSeek = (payload) =>
  new Promise((resolve, reject) => {
    const apiKey = process.env.SILICONFLOW_API_KEY;
    if (!apiKey) {
      reject(new Error('Missing SILICONFLOW_API_KEY'));
      return;
    }

    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.siliconflow.cn',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: `Bearer ${apiKey}`,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`DeepSeek API error ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(180000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.write(data);
    req.end();
  });

app.post('/api/chat', async (req, res) => {
  try {
    const message = String(req.body.message || '').trim();
    const params = req.body.params || {};
    const history = Array.isArray(req.body.history) ? req.body.history : [];

    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const systemPrompt = [
      '你是车辆参数化设计助手（面向非专业用户）。',
      '语气友好简洁，先给结论或建议，再用1-2句说明理由。',
      '需要用户操作时，给出明确的参数方向或范围。',
      '问题不清楚时，先问1个关键问题。',
      '结合当前参数做判断（单位以M为准）。',
      '当前参数:',
      JSON.stringify(params)
    ].join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role === 'ai' ? 'assistant' : 'user',
        content: String(m.content || ''),
      })),
      { role: 'user', content: message },
    ];

    const payload = {
      model: process.env.SILICONFLOW_CHAT_MODEL || 'deepseek-ai/DeepSeek-V3',
      messages,
      temperature: 0.6,
      max_tokens: 1000
    };

    const data = await callDeepSeek(payload);
    const reply =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
        ? data.choices[0].message.content.trim()
        : '未获取到有效回复';

    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/shell/image', async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const provider = (process.env.SHELL_IMAGE_PROVIDER || 'jimeng').toLowerCase();
    // Default to Jimeng only; enable fallback explicitly via env when needed.
    const allowFallback = String(process.env.SHELL_IMAGE_FALLBACK || '0') === '1';

    if (provider === 'ark') {
      const data = await callArkImages(prompt);
      const url = data?.data?.[0]?.url;
      if (!url) throw new Error(`ARK image response missing url: ${JSON.stringify(data)}`);
      res.json({ ok: true, imageUrls: [url], raw: data });
      return;
    }

    try {
      const result = await runJimeng({
        prompt,
        req_key: req.body.req_key,
        poll_interval: req.body.poll_interval || 5,
        poll_limit: req.body.poll_limit || 24,
        return_base64: true,
        extra: { force_single: true, ...(req.body.extra || {}) },
      });
      res.json(result);
      return;
    } catch (jimengErr) {
      if (!allowFallback) throw jimengErr;
      if (!process.env.ARK_API_KEY) throw jimengErr;
      const data = await callArkImages(prompt);
      const url = data?.data?.[0]?.url;
      if (!url) throw new Error(`ARK image response missing url: ${JSON.stringify(data)}`);
      res.json({ ok: true, imageUrls: [url], raw: { fallback: 'ark', jimengError: String(jimengErr), ark: data } });
    }
  } catch (err) {
    logError('shell_image', err, {
      hasPrompt: Boolean(req.body && req.body.prompt),
      reqKey: req.body && req.body.req_key ? String(req.body.req_key) : undefined,
    });
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/shell/model', async (req, res) => {
  try {
    // Backwards-compatible endpoint. This can take a long time and may hit
    // hosting request timeouts. Prefer /api/shell/model/submit + /status.
    const imageUrl = req.body.imageUrl;
    const imageBase64 = req.body.imageBase64;
    if (!imageUrl && !imageBase64) {
      res.status(400).json({ error: 'imageUrl or imageBase64 is required' });
      return;
    }
    const imagePayload = imageUrl
      ? { type: 'image_url', image_url: { url: imageUrl } }
      : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } };

    const submit = await callSeed3d('/api/v3/contents/generations/tasks', {
      model: req.body.model || 'doubao-seed3d-1-0-250928',
      content: [
        { type: 'text', text: '--subdivisionlevel medium --fileformat glb' },
        imagePayload,
      ],
    });
    const jobId = submit?.id || submit?.task_id || submit?.result?.id;
    if (!jobId) throw new Error('Missing task id in response');

    const maxPoll = req.body.poll_limit || 60;
    const pollInterval = req.body.poll_interval || 10;
    for (let i = 0; i < maxPoll; i += 1) {
      await new Promise((r) => setTimeout(r, pollInterval * 1000));
      const query = await callSeed3d(`/api/v3/contents/generations/tasks/${jobId}`, null, 'GET');
      const status = query?.status || query?.result?.status;
      const content = query?.content || query?.result?.content || {};
      if (String(status).toLowerCase() === 'succeeded') {
        let fileUrl = pickModelFileUrl(content);
        const previewUrl = pickPreviewUrl(content);
        if (!fileUrl) {
          throw new Error('Seed3D succeeded but file url is missing');
        }
        const publicBase = getPublicBase(req);
        const ext = getUrlExt(fileUrl);
        if (ext === 'zip') {
          const extracted = await extractZipToAssets(fileUrl, jobId);
          fileUrl = `${publicBase}${extracted.relUrl}`;
        }
        res.json({
          jobId,
          status,
          fileUrl,
          previewUrl,
          raw: query,
        });
        return;
      }
      if (String(status).toLowerCase() === 'failed') {
        throw new Error(query?.error?.message || 'Seed3D job failed');
      }
    }
    throw new Error('Seed3D generation timed out');
  } catch (err) {
    logError('shell_model', err, {
      hasImageUrl: Boolean(req.body && req.body.imageUrl),
      hasImageBase64: Boolean(req.body && req.body.imageBase64),
      model: req.body && req.body.model ? String(req.body.model) : undefined,
      baseUrl: process.env.SEED3D_BASE_URL || 'https://ark.cn-beijing.volces.com',
    });
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/shell/model/submit', async (req, res) => {
  try {
    const imageUrl = req.body.imageUrl;
    const imageBase64 = req.body.imageBase64;
    if (!imageUrl && !imageBase64) {
      res.status(400).json({ error: 'imageUrl or imageBase64 is required' });
      return;
    }

    const publicBase = getPublicBase(req);
    let resolvedUrl = imageUrl ? String(imageUrl) : '';
    if (!resolvedUrl && imageBase64) {
      const saved = await saveBase64ImageToAssets(imageBase64, 'seed3d_input');
      resolvedUrl = `${publicBase}${saved.relUrl}`;
    }
    const imagePayload = { type: 'image_url', image_url: { url: resolvedUrl } };

    const submit = await callSeed3d('/api/v3/contents/generations/tasks', {
      model: req.body.model || 'doubao-seed3d-1-0-250928',
      content: [
        { type: 'text', text: '--subdivisionlevel medium --fileformat glb' },
        imagePayload,
      ],
    });
    const jobId = submit?.id || submit?.task_id || submit?.result?.id;
    if (!jobId) throw new Error(`Missing task id in response: ${JSON.stringify(submit)}`);
    res.json({ ok: true, jobId, raw: submit });
  } catch (err) {
    logError('shell_model_submit', err, {
      hasImageUrl: Boolean(req.body && req.body.imageUrl),
      hasImageBase64: Boolean(req.body && req.body.imageBase64),
      model: req.body && req.body.model ? String(req.body.model) : undefined,
      baseUrl: process.env.SEED3D_BASE_URL || 'https://ark.cn-beijing.volces.com',
    });
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/shell/model/status', async (req, res) => {
  try {
    const jobId = String(req.query.jobId || '').trim();
    if (!jobId) {
      res.status(400).json({ error: 'jobId is required' });
      return;
    }
    const query = await callSeed3d(`/api/v3/contents/generations/tasks/${jobId}`, null, 'GET');
    const status = query?.status || query?.result?.status || 'unknown';
    const content = query?.content || query?.result?.content || {};
    const lower = String(status).toLowerCase();

    if (lower === 'succeeded') {
      let fileUrl = pickModelFileUrl(content);
      const previewUrl = pickPreviewUrl(content);
      if (!fileUrl) {
        throw new Error('Seed3D succeeded but file url is missing');
      }
      const publicBase = getPublicBase(req);
      const ext = getUrlExt(fileUrl);
      if (ext === 'zip') {
        const extracted = await extractZipToAssets(fileUrl, jobId);
        fileUrl = `${publicBase}${extracted.relUrl}`;
      } else if (ext === 'glb' || ext === 'gltf' || ext === 'obj') {
        const cached = await cacheRemoteModelToAssets(fileUrl, jobId);
        fileUrl = `${publicBase}${cached.relUrl}`;
      }
      res.json({ ok: true, jobId, status, fileUrl, previewUrl, raw: query });
      return;
    }

    if (lower === 'failed') {
      res.json({ ok: false, jobId, status, error: query?.error?.message || 'Seed3D job failed', raw: query });
      return;
    }

    res.json({ ok: true, jobId, status, raw: query });
  } catch (err) {
    logError('shell_model_status', err, {
      jobId: req.query && req.query.jobId ? String(req.query.jobId) : undefined,
      baseUrl: process.env.SEED3D_BASE_URL || 'https://ark.cn-beijing.volces.com',
    });
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/recommend', async (req, res) => {
  try {
    const userIntent = String(req.body.userIntent || '').trim();
    const params = req.body.params || {};
    const keys = Array.isArray(req.body.keys) ? req.body.keys : [];

    const clamp = (v, min, max) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return v;
      return Math.max(min, Math.min(max, n));
    };

    // Server-side fallback for when the model does not follow JSON-only requirements.
    const localRecommend = (intentText, baseParams) => {
      const intent = String(intentText || '');
      const next = { ...(baseParams || {}) };
      if (/校园|学校|运输|配送|货物|载重/.test(intent)) {
        if (typeof next.payloadCapacity === 'number') next.payloadCapacity = clamp(next.payloadCapacity + 30, 0, 200);
        if (typeof next.vehicleWidth === 'number') next.vehicleWidth = clamp(next.vehicleWidth + 0.08, 0.6, 1.4);
        if (typeof next.vehicleLength === 'number') next.vehicleLength = clamp(next.vehicleLength + 0.15, 1.0, 3.0);
      }
      if (/越野|崎岖|爬坡|复杂|户外/.test(intent)) {
        if (typeof next.chassisHeight === 'number') next.chassisHeight = clamp(next.chassisHeight + 0.08, 0.1, 0.55);
        if (typeof next.tireWidth === 'number') next.tireWidth = clamp(next.tireWidth + 0.04, 0.12, 0.38);
      }
      if (/速度|竞速|高速|灵活/.test(intent)) {
        if (typeof next.vehicleLength === 'number') next.vehicleLength = clamp(next.vehicleLength - 0.1, 1.0, 3.0);
        if (typeof next.wheelbase === 'number') next.wheelbase = clamp(next.wheelbase + 0.08, 0.7, 2.0);
      }
      if (/续航|电池|里程/.test(intent)) {
        if (typeof next.batteryCapacity === 'number') next.batteryCapacity = clamp(next.batteryCapacity + 10, 0, 90);
      }
      return next;
    };

    const systemPrompt = [
      '你是车辆参数化设计助手（面向非专业用户）。',
      '任务：根据用户设计意图与当前参数，输出“推荐参数预填”。',
      '输出必须是严格 JSON，且只输出 JSON，不要任何额外文字、不要 Markdown、不要代码块。',
      'JSON 格式如下：{"result":{...},"reason":"..."}',
      'result 只包含你要修改/建议的参数键；其余键可以不输出。',
      'reason 用 1-3 句中文说明推荐逻辑，避免冗长。',
      '单位：所有长度单位为 m（米）。',
      '当前参数（JSON）：',
      JSON.stringify(params),
      '允许输出的键（JSON 数组）：',
      JSON.stringify(keys)
    ].join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ userIntent, params }) }
    ];

    const payload = {
      model: process.env.SILICONFLOW_RECOMMEND_MODEL || 'deepseek-ai/DeepSeek-V3',
      messages,
      temperature: 0.2,
      max_tokens: 800
    };

    const data = await callDeepSeek(payload);
    const reply =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
        ? data.choices[0].message.content.trim()
        : '未获取到有效回复';

    let jsonText = reply;
    const match = reply.match(/\{[\s\S]*\}/);
    if (match) jsonText = match[0];
    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      logError('recommend_parse', err, {
        rawPreview: reply.slice(0, 200),
        model: payload.model,
      });
      // Do not hard-fail: fall back to deterministic rule-based recommendation
      // so the UI can keep working even if the LLM replies with plain text.
      const fallback = localRecommend(userIntent, params);
      const filteredFallback = {};
      keys.forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(fallback, k)) {
          filteredFallback[k] = fallback[k];
        }
      });
      res.json({
        result: filteredFallback,
        reason: `AI 返回非 JSON，已使用规则生成预填。`,
        raw: reply,
      });
      return;
    }
    let result = {};
    let reason = '';
    if (parsed && typeof parsed === 'object' && parsed.result) {
      result = parsed.result;
      reason = parsed.reason || '';
    } else if (parsed && typeof parsed === 'object') {
      result = parsed;
    }
    const filtered = {};
    keys.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(result, k)) {
        filtered[k] = result[k];
      }
    });
    res.json({ result: filtered, reason });
  } catch (err) {
    logError('recommend', err, {
      hasKey: Boolean(process.env.SILICONFLOW_API_KEY),
      model: process.env.SILICONFLOW_RECOMMEND_MODEL || 'deepseek-ai/DeepSeek-V3',
      keysCount: Array.isArray(req.body && req.body.keys) ? req.body.keys.length : 0,
    });
    res.status(500).json({ error: err.message || String(err) });
  }
});

const coerceNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const auditFallback = (p) => {
  const issues = [];
  const suggestions = [];

  const vehicleLength = coerceNumber(p && p.vehicleLength);
  const vehicleWidth = coerceNumber(p && p.vehicleWidth);
  const wheelbase = coerceNumber(p && p.wheelbase);
  const tireWidth = coerceNumber(p && p.tireWidth);
  const tireOuterDiameter = coerceNumber(p && p.tireOuterDiameter);
  const chassisHeight = coerceNumber(p && p.chassisHeight);

  if (tireOuterDiameter != null && chassisHeight != null) {
    if (chassisHeight > tireOuterDiameter * 0.45) {
      issues.push('底盘高度偏高，可能超过轮胎高度范围。');
      suggestions.push('降低底盘高度，保持在轮胎高度以内。');
    }
  }

  if (tireWidth != null) {
    if (tireWidth < 0.2 || tireWidth > 0.4) {
      issues.push('轮胎宽度超出常规范围。');
      suggestions.push('将轮胎宽度调整到 0.2m - 0.4m。');
    }
  }

  if (vehicleLength != null && wheelbase != null) {
    const wbMin = vehicleLength * 0.55;
    const wbMax = vehicleLength * 0.7;
    if (wheelbase < wbMin || wheelbase > wbMax) {
      issues.push('轴距与车身总长比例不协调。');
      suggestions.push('建议将轴距控制在车身总长的 55%–70%。');
    }
  }

  if (vehicleLength != null && vehicleWidth != null) {
    const widthMin = vehicleLength * 0.35;
    const widthMax = vehicleLength * 0.55;
    if (vehicleWidth < widthMin || vehicleWidth > widthMax) {
      issues.push('载物台宽度与车身总长比例不协调。');
      suggestions.push('建议将载物台宽度控制在车身总长的 35%–55%。');
    }
  }

  return { ok: issues.length === 0, issues, suggestions, source: 'fallback' };
};

const tryParseJsonFromText = (rawText) => {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const tryParse = (candidate) => {
    try {
      return JSON.parse(candidate);
    } catch (_err) {
      return null;
    }
  };

  const direct = tryParse(text);
  if (direct) return direct;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }

  const scanFor = (openCh, closeCh) => {
    const starts = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === openCh) starts.push(i);
    }
    for (const start of starts) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === openCh) depth += 1;
        if (ch === closeCh) depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          const parsed = tryParse(candidate);
          if (parsed) return parsed;
          break;
        }
        if (depth < 0) break;
      }
    }
    return null;
  };

  return scanFor('{', '}') || scanFor('[', ']');
};

const normalizeAuditResult = (obj) => {
  if (!obj || typeof obj !== 'object') return null;
  const root = obj.result && typeof obj.result === 'object' ? obj.result : obj;
  const issues = Array.isArray(root.issues) ? root.issues : [];
  const suggestions = Array.isArray(root.suggestions) ? root.suggestions : [];
  const okVal = typeof root.ok === 'boolean' ? root.ok : issues.length === 0;
  return {
    ok: okVal,
    issues: issues.map((v) => String(v)),
    suggestions: suggestions.map((v) => String(v)),
    source: 'ai',
  };
};

app.post('/api/audit', async (req, res) => {
  try {
    const params = req.body.params || {};
    const labels = req.body.labels || {};

    const systemPrompt = [
      '你是车辆参数化设计助手（面向非专业用户）。',
      '任务：对“当前车辆参数”做合理性核验，指出明显不合理点，并给出可执行的调整建议。',
      '输出必须是严格 JSON，且只输出 JSON：不要任何额外文字、不要 Markdown、不要代码块。',
      'JSON 结构固定为：{"ok":true/false,"issues":["..."],"suggestions":["..."]}',
      'issues/suggestions 用中文短句，每条 8-30 字，最多各 8 条。',
      '判断时使用的单位：所有长度单位为 m（米）。',
      '当前参数（JSON）：',
      JSON.stringify(params),
    ].join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ params, labels }) }
    ];

    const payload = {
      model: process.env.SILICONFLOW_AUDIT_MODEL || 'deepseek-ai/DeepSeek-V2.5',
      messages,
      temperature: 0.3,
      max_tokens: 600
    };

    const data = await callDeepSeek(payload);
    const reply =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
        ? data.choices[0].message.content.trim()
        : '未获取到有效回复';

    const parsedAny = tryParseJsonFromText(reply);
    const normalized = normalizeAuditResult(parsedAny);
    if (!normalized) {
      logError('audit_parse', new Error('audit JSON parse failed'), {
        rawPreview: reply.slice(0, 200),
        model: payload.model,
      });
      // Do not hard-fail: return deterministic fallback so the UI keeps working.
      res.json({ ...auditFallback(params), raw: reply });
      return;
    }

    res.json(normalized);
  } catch (err) {
    logError('audit', err, {
      hasKey: Boolean(process.env.SILICONFLOW_API_KEY),
      model: process.env.SILICONFLOW_AUDIT_MODEL || 'deepseek-ai/DeepSeek-V2.5',
    });
    // Do not hard-fail: return fallback for reliability.
    const p = (req && req.body && req.body.params) ? req.body.params : {};
    res.json(auditFallback(p));
  }
});

app.listen(PORT, () => {
  console.log(`DeepSeek proxy running at http://localhost:${PORT}`);
});




