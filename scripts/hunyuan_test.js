const apiKey = process.env.HUNYUAN_API_KEY;
if (!apiKey) {
  console.error('Missing HUNYUAN_API_KEY');
  process.exit(1);
}

const baseUrl = process.env.HUNYUAN_BASE_URL || 'https://api.ai3d.cloud.tencent.com';
const imageUrl = process.env.HUNYUAN_IMAGE_URL;

if (!imageUrl) {
  console.error('Missing HUNYUAN_IMAGE_URL');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return JSON.parse(text);
};

const main = async () => {
  console.log('Submit 3D job...');
  const submit = await post('/v1/ai3d/submit', {
    ImageUrl: imageUrl,
    GenerateType: 'Normal',
    EnablePBR: false,
    FaceCount: 400000,
  });
  console.log('submit response:', submit);
  const jobId = submit?.Response?.JobId || submit?.JobId;
  if (!jobId) {
    throw new Error('Missing JobId in response');
  }

  console.log('Polling job:', jobId);
  for (let i = 0; i < 60; i += 1) {
    await sleep(5000);
    const query = await post('/v1/ai3d/query', { JobId: jobId });
    const resp = query?.Response || query;
    const status = resp?.Status;
    console.log(`status[${i}]`, status);
    if (status === 'DONE') {
      console.log('ResultFile3Ds:', JSON.stringify(resp?.ResultFile3Ds || [], null, 2));
      return;
    }
    if (status === 'FAIL') {
      throw new Error(resp?.ErrorMessage || 'Job failed');
    }
  }
  throw new Error('Timed out waiting for 3D result');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
