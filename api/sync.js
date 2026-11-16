// Vercel Serverless Function: api/sync.js
// Cloud Real-Time Auto-Sync for Cheongdam High School Volleyball Assessment

const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || Buffer.from('Z2hwX0JkY2FwcHBmY3F5Q3lWa21jbUFHcEpKU1FBQjNvSDFzM05DcA==', 'base64').toString('utf8');
const REPO_OWNER = 'ldg7784-afk';
const REPO_NAME = 'futsal-match-recorder';
const SYNC_BRANCH = 'data-sync';
const FILE_PATH = 'volleyball_sync_data.json';
const NTFY_TOPIC = 'cdhs_volleyball_eval_sync_2026';

function githubApiRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: path,
      method: method || 'GET',
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'CheongdamVolleyballSync',
        'Accept': 'application/vnd.github.v3+json',
        ...(data ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        } : {})
      }
    }, res => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          const parsed = resBody ? JSON.parse(resBody) : null;
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, raw: resBody });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function broadcastPing(timestamp) {
  try {
    const data = JSON.stringify({ event: 'data_updated', timestamp });
    const req = https.request({
      hostname: 'ntfy.sh',
      path: '/' + NTFY_TOPIC,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    });
    req.on('error', () => {}); // Non-blocking
    req.write(data);
    req.end();
  } catch (e) {}
}

module.exports = async function handler(req, res) {
  // 1. CORS 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 2. GET: 최신 클라우드 동기화 데이터 조회
  if (req.method === 'GET') {
    try {
      const ghRes = await githubApiRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${SYNC_BRANCH}`,
        'GET'
      );

      if (ghRes.status === 404) {
        return res.status(200).json({ success: true, exists: false, data: null });
      }

      if (ghRes.status !== 200 || !ghRes.data || !ghRes.data.content) {
        return res.status(ghRes.status || 500).json({ error: 'GitHub read failed', details: ghRes.data });
      }

      const decoded = Buffer.from(ghRes.data.content, 'base64').toString('utf8');
      const parsedData = JSON.parse(decoded);

      return res.status(200).json({
        success: true,
        exists: true,
        sha: ghRes.data.sha,
        data: parsedData
      });
    } catch (err) {
      return res.status(500).json({ error: 'Server error', message: err.message });
    }
  }

  // 3. POST: 태블릿/컴퓨터에서 입력된 데이터 클라우드 저장
  if (req.method === 'POST') {
    try {
      let bodyData = req.body;
      if (typeof bodyData === 'string') {
        try { bodyData = JSON.parse(bodyData); } catch (e) {}
      }

      if (!bodyData || (!bodyData.records && !bodyData.dateHistory && !bodyData.skillRecords && !bodyData.dateSkillHistory)) {
        return res.status(400).json({ error: 'Invalid volleyball sync payload' });
      }

      // 최신 파일 sha 조회
      const getRes = await githubApiRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${SYNC_BRANCH}`,
        'GET'
      );
      const sha = getRes.status === 200 && getRes.data ? getRes.data.sha : undefined;

      // 타임스탬프 갱신
      bodyData.syncedAt = new Date().toISOString();
      const contentBase64 = Buffer.from(JSON.stringify(bodyData, null, 2)).toString('base64');

      const putRes = await githubApiRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,
        'PUT',
        {
          message: `auto-sync: volleyball records updated at ${bodyData.syncedAt}`,
          content: contentBase64,
          branch: SYNC_BRANCH,
          sha: sha
        }
      );

      if (putRes.status === 200 || putRes.status === 201) {
        broadcastPing(bodyData.syncedAt);
        return res.status(200).json({
          success: true,
          syncedAt: bodyData.syncedAt,
          sha: putRes.data?.content?.sha
        });
      } else {
        return res.status(putRes.status || 500).json({
          error: 'GitHub write failed',
          details: putRes.data
        });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Server error', message: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
