const crypto = require('crypto');

const accessKey = process.env.VOLC_ACCESS_KEY;
const secretKey = process.env.VOLC_SECRET_KEY;
if (!accessKey || !secretKey) {
  console.error('Missing VOLC_ACCESS_KEY or VOLC_SECRET_KEY');
  process.exit(1);
}

const region = 'cn-north-1';
const service = 'cv';
const usePresign = process.env.VOLC_PRESIGN === '1';
const presignExpires = process.env.VOLC_PRESIGN_EXPIRES || '3600';
const host = process.env.VOLC_HOST || (usePresign ? 'open.volcengineapi.com' : 'visual.volcengineapi.com');
const endpoint = `https://${host}/`;
const sessionToken = process.env.VOLC_SESSION_TOKEN;

const hash = (str) => crypto.createHash('sha256').update(str, 'utf8').digest('hex');
const hmac = (key, str) => crypto.createHmac('sha256', key).update(str, 'utf8').digest();

const keyPrefix = process.env.VOLC_KEY_PREFIX !== undefined ? process.env.VOLC_KEY_PREFIX : 'VOLC';
const debug = process.env.VOLC_DEBUG === '1';
const noContentSha = process.env.VOLC_NO_CONTENT_SHA === '1';
const noContentType = process.env.VOLC_NO_CONTENT_TYPE === '1';
const unsignedPayload = process.env.VOLC_UNSIGNED_PAYLOAD === '1';

const toAmzDate = (date) =>
  date
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '');

const buildCanonicalQuery = (params) =>
  Object.keys(params)
    .sort()
    .map((k) => {
      const value = params[k] === undefined || params[k] === null ? '' : String(params[k]);
      return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`;
    })
    .join('&');

const signRequest = ({ method, queryParams, body, amzDate, dateStamp }) => {
  const payload = body || '';
  const payloadHash = usePresign ? 'UNSIGNED-PAYLOAD' : (unsignedPayload ? 'UNSIGNED-PAYLOAD' : hash(payload));

  const canonicalUri = '/';
  const canonicalQuery = buildCanonicalQuery(queryParams);
  const extraHeader = sessionToken ? `x-security-token:${sessionToken}\n` : '';
  const canonicalHeaders = usePresign
    ? ''
    : (noContentType ? '' : `content-type:application/json\n`) +
      `host:${host}\n` +
      extraHeader +
      (noContentSha ? '' : `x-content-sha256:${payloadHash}\n`) +
      `x-date:${amzDate}\n`;
  const signedHeadersBase = sessionToken
    ? `${noContentType ? '' : 'content-type;'}host;x-security-token;`
    : `${noContentType ? '' : 'content-type;'}host;`;
  const signedHeaders = usePresign
    ? ''
    : (noContentSha ? `${signedHeadersBase}x-date` : `${signedHeadersBase}x-content-sha256;x-date`);
  const canonicalRequest =
    `${method}\n` +
    `${canonicalUri}\n` +
    `${canonicalQuery}\n` +
    `${canonicalHeaders}\n` +
    `${signedHeaders}\n` +
    `${payloadHash}`;

  const credentialScope = `${dateStamp}/${region}/${service}/request`;
  const stringToSign =
    `HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hash(canonicalRequest)}`;

  const kDate = hmac(`${keyPrefix}${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  if (debug) {
    console.log('canonicalQuery:', canonicalQuery);
    console.log('canonicalRequest:\n', canonicalRequest);
    console.log('stringToSign:\n', stringToSign);
  }

  return { authorization, payloadHash, canonicalQuery, signature };
};

const request = async ({ action, version, body }) => {
  const method = 'POST';
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const bodyText = body ? JSON.stringify(body) : '';
  const credentialScope = `${dateStamp}/${region}/${service}/request`;
  const queryParams = usePresign
    ? {
        Action: action,
        Version: version,
        'X-Algorithm': 'HMAC-SHA256',
        'X-Credential': `${accessKey}/${credentialScope}`,
        'X-Date': amzDate,
        'X-Expires': presignExpires,
        'X-NotSignBody': '1',
        ...(sessionToken ? { 'X-Security-Token': sessionToken } : {}),
        'X-SignedHeaders': '',
      }
    : { Action: action, Version: version };

  if (usePresign) {
    const signedQueries = Object.keys(queryParams)
      .concat(['X-SignedQueries'])
      .sort()
      .join(';');
    queryParams['X-SignedQueries'] = signedQueries;
  }

  const { authorization, payloadHash, canonicalQuery, signature } = signRequest({
    method,
    queryParams,
    body: bodyText,
    amzDate,
    dateStamp,
  });
  const url = `${endpoint}?${canonicalQuery}${usePresign ? `&X-Signature=${signature}` : ''}`;

  const headers = usePresign
    ? {
        ...(noContentType ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      }
    : {
        ...(noContentType ? {} : { 'Content-Type': 'application/json' }),
        Host: host,
        'X-Date': amzDate,
        ...(noContentSha ? {} : { 'X-Content-Sha256': payloadHash }),
        ...(sessionToken ? { 'X-Security-Token': sessionToken } : {}),
        Authorization: authorization,
      };

  const res = await fetch(url, {
    method,
    headers,
    body: bodyText,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return JSON.parse(text);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prompt = process.env.JIMENG_PROMPT || '一辆极简的四轮小车外壳，工业设计草图风格';
const reqKey = process.env.JIMENG_REQ_KEY || 'jimeng_t2i_v40';
const submitAction = process.env.JIMENG_SUBMIT_ACTION || 'JimengT2IV40SubmitTask';
const submitVersion = process.env.JIMENG_SUBMIT_VERSION || '2024-06-06';
const resultAction = process.env.JIMENG_RESULT_ACTION || 'CVSync2AsyncGetResult';
const resultVersion = process.env.JIMENG_RESULT_VERSION || '2022-08-31';
const minimalBody = process.env.JIMENG_MINIMAL_BODY === '1';
const sizeOverride = process.env.JIMENG_SIZE ? Number(process.env.JIMENG_SIZE) : null;
const forceSingle = process.env.JIMENG_FORCE_SINGLE === '1';

const main = async () => {
  console.log('Submit task...');
  const submitBody = minimalBody
    ? { req_key: reqKey, prompt }
    : {
        req_key: reqKey,
        prompt,
        size: sizeOverride || 1024 * 1024,
        ...(forceSingle ? { force_single: true } : {}),
        seed: -1,
      };

  const submit = await request({
    action: submitAction,
    version: submitVersion,
    body: submitBody,
  });
  console.log('submit response:', submit);
  if (submit.code !== 10000 || !submit.data || !submit.data.task_id) {
    throw new Error('Submit failed: ' + JSON.stringify(submit));
  }
  const taskId = submit.data.task_id;

  console.log('Polling task:', taskId);
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000);
    const result = await request({
      action: resultAction,
      version: resultVersion,
      body: {
        req_key: reqKey,
        task_id: taskId,
      },
    });
    const status = result?.data?.status;
    console.log(`status[${i}]`, status);
    if (status === 'done') {
      console.log('image_urls:', result?.data?.image_urls || []);
      return;
    }
    if (status === 'not_found' || status === 'expired') {
      throw new Error('Task not found or expired');
    }
  }
  throw new Error('Timed out waiting for image');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
