const express = require('express');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (_req, res) => {
  res.status(200).send('AUTO-GEN API running');
});

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

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
      '结合当前参数做判断（单位以UI为准）。',
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

app.post('/api/recommend', async (req, res) => {
  try {
    const userIntent = String(req.body.userIntent || '').trim();
    const params = req.body.params || {};
    const keys = Array.isArray(req.body.keys) ? req.body.keys : [];

    const systemPrompt = [
      '你是车辆参数推荐器。',
      '只输出严格JSON对象，不要任何解释或代码块。',
      '格式：{"result":{...},"reason":"..."}。',
      'result 的键必须来自给定键列表。',
      'reason 用1-2句中文说明推荐逻辑。',
      '值需合理，单位以前端为准。',
      `键列表:${JSON.stringify(keys)}`
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
        : '';

    let jsonText = reply;
    const match = reply.match(/\{[\s\S]*\}/);
    if (match) jsonText = match[0];
    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      res.status(500).json({ error: 'AI返回内容无法解析为JSON', raw: reply });
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
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/audit', async (req, res) => {
  try {
    const params = req.body.params || {};
    const labels = req.body.labels || {};

    const systemPrompt = [
      '你是车辆参数核验助手。',
      '只输出严格JSON对象，不要任何解释或代码块。',
      '格式：{"ok":true/false,"issues":[...],"suggestions":[...]}。',
      'issues 列出明显不合理之处，suggestions 给出简短改进建议。',
      '如无明显问题，ok 为 true，issues 为空。',
      '必须使用中文描述，并尽量引用参数中文名称。'
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
        : '';

    let jsonText = reply;
    const match = reply.match(/\{[\s\S]*\}/);
    if (match) jsonText = match[0];
    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      res.status(500).json({ error: 'AI返回内容无法解析为JSON', raw: reply });
      return;
    }
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`DeepSeek proxy running at http://localhost:${PORT}`);
});
