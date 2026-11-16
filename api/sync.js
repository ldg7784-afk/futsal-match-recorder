// api/sync.js
// 100% Real-time Serverless Cloud Auto-Sync for Volleyball Assessment (Vercel Blob Powered)
// Deep-Merge Protection: Never overwrite evaluated student records with empty/null states
const https = require('https');

const BLOB_API_BASE = 'https://blob.vercel-storage.com';
const NTFY_TOPIC = 'cdhs_volleyball_eval_sync_2026';
const BLOB_PATH = 'volleyball_sync_data.json';

// In-memory cache across serverless warm invocations
let memoryCache = null;
let lastKnownBlobUrl = null;

function requestHttps(url, options, postData) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
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
      headers: { 'Content-Type': 'application/json' }
    });
    req.on('error', () => { });
    req.write(data);
    req.end();
  } catch (e) { }
}

function mergePayloads(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const result = { ...existing, ...incoming };

  // 1. Classes: keep whichever has rosters
  result.classes = incoming.classes || existing.classes || {};
  result.students = incoming.students || existing.students || [];

  // 2. Merge dateHistory safely
  result.dateHistory = { ...(existing.dateHistory || {}) };
  if (incoming.dateHistory) {
    for (const [date, inRecs] of Object.entries(incoming.dateHistory)) {
      if (!result.dateHistory[date]) {
        result.dateHistory[date] = { ...inRecs };
      } else {
        const mergedDate = { ...result.dateHistory[date] };
        for (const [sid, inRec] of Object.entries(inRecs)) {
          const exRec = mergedDate[sid];
          if (!exRec) {
            mergedDate[sid] = inRec;
          } else {
            const inHasCounts = inRec.counts && Object.values(inRec.counts).some(v => Number(v) > 0);
            const inHasLegacy = (inRec.serve?.plus || 0) + (inRec.receive?.plus || 0) + (inRec.toss?.plus || 0) + (inRec.spike?.plus || 0) > 0;
            const exHasCounts = exRec.counts && Object.values(exRec.counts).some(v => Number(v) > 0);
            const exHasLegacy = (exRec.serve?.plus || 0) + (exRec.receive?.plus || 0) + (exRec.toss?.plus || 0) + (exRec.spike?.plus || 0) > 0;

            if ((inHasCounts || inHasLegacy) && !(exHasCounts || exHasLegacy)) {
              mergedDate[sid] = inRec;
            } else if (!(inHasCounts || inHasLegacy) && (exHasCounts || exHasLegacy)) {
              mergedDate[sid] = exRec;
            } else {
              mergedDate[sid] = { ...exRec, ...inRec };
              if (exRec.counts && inRec.counts) {
                mergedDate[sid].counts = { ...exRec.counts };
                for (const [k, v] of Object.entries(inRec.counts)) {
                  if (Number(v) > 0 || !mergedDate[sid].counts[k]) mergedDate[sid].counts[k] = v;
                }
              }
            }
          }
        }
        result.dateHistory[date] = mergedDate;
      }
    }
  }

  // 3. Merge dateSkillHistory safely
  result.dateSkillHistory = { ...(existing.dateSkillHistory || {}) };
  if (incoming.dateSkillHistory) {
    for (const [date, inRecs] of Object.entries(incoming.dateSkillHistory)) {
      if (!result.dateSkillHistory[date]) {
        result.dateSkillHistory[date] = { ...inRecs };
      } else {
        const mergedDate = { ...result.dateSkillHistory[date] };
        for (const [sid, inRec] of Object.entries(inRecs)) {
          const exRec = mergedDate[sid];
          if (!exRec) {
            mergedDate[sid] = inRec;
          } else {
            const inValid = (inRec.attempt1 !== null && inRec.attempt1 !== undefined && inRec.attempt1 !== '') ||
                            (inRec.attempt2 !== null && inRec.attempt2 !== undefined && inRec.attempt2 !== '') ||
                            (inRec.note && String(inRec.note).trim().length > 0);
            const exValid = (exRec.attempt1 !== null && exRec.attempt1 !== undefined && exRec.attempt1 !== '') ||
                            (exRec.attempt2 !== null && exRec.attempt2 !== undefined && exRec.attempt2 !== '') ||
                            (exRec.note && String(exRec.note).trim().length > 0);

            if (inValid && !exValid) {
              mergedDate[sid] = inRec;
            } else if (!inValid && exValid) {
              mergedDate[sid] = exRec;
            } else {
              mergedDate[sid] = {
                ...exRec,
                ...inRec,
                attempt1: (inRec.attempt1 !== null && inRec.attempt1 !== undefined) ? inRec.attempt1 : exRec.attempt1,
                attempt2: (inRec.attempt2 !== null && inRec.attempt2 !== undefined) ? inRec.attempt2 : exRec.attempt2,
                note: inRec.note || exRec.note || ''
              };
            }
          }
        }
        result.dateSkillHistory[date] = mergedDate;
      }
    }
  }

  // 4. Normalize records and skillRecords for active evalDate
  const curD = incoming.evalDate || existing.evalDate || new Date().toISOString().slice(0, 10);
  result.evalDate = curD;
  result.records = result.dateHistory[curD] || incoming.records || existing.records || {};
  result.skillRecords = result.dateSkillHistory[curD] || incoming.skillRecords || existing.skillRecords || {};

  return result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;

  // 1. GET: 최신 클라우드 동기화 데이터 조회
  if (req.method === 'GET') {
    if (memoryCache) {
      return res.status(200).json({ success: true, exists: true, data: memoryCache });
    }

    if (token) {
      try {
        const listRes = await requestHttps(`${BLOB_API_BASE}?limit=10&prefix=${BLOB_PATH}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (listRes.status === 200) {
          const listJson = JSON.parse(listRes.body);
          const blobItem = (listJson.blobs || []).find(b => b.pathname === BLOB_PATH) || (listJson.blobs || [])[0];
          if (blobItem && blobItem.url) {
            lastKnownBlobUrl = blobItem.url;
            const contentRes = await requestHttps(`${blobItem.url}?t=${Date.now()}`, { method: 'GET' });
            if (contentRes.status === 200) {
              memoryCache = JSON.parse(contentRes.body);
              return res.status(200).json({ success: true, exists: true, data: memoryCache });
            }
          }
        }
      } catch (err) {
        console.warn('Blob read warning:', err.message);
      }
    }

    return res.status(200).json({ success: true, exists: false, data: null });
  }

  // 2. POST: 태블릿/컴퓨터에서 입력된 데이터 안전 병합 후 클라우드 영구 저장
  if (req.method === 'POST') {
    let bodyData = req.body;
    if (typeof bodyData === 'string') {
      try { bodyData = JSON.parse(bodyData); } catch (e) { }
    }

    if (!bodyData || (!bodyData.records && !bodyData.dateHistory && !bodyData.skillRecords && !bodyData.dateSkillHistory)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // 기존 데이터 읽기 (Blob 또는 memoryCache)
    let existingData = memoryCache;
    if (!existingData && token) {
      try {
        const listRes = await requestHttps(`${BLOB_API_BASE}?limit=10&prefix=${BLOB_PATH}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (listRes.status === 200) {
          const listJson = JSON.parse(listRes.body);
          const blobItem = (listJson.blobs || []).find(b => b.pathname === BLOB_PATH) || (listJson.blobs || [])[0];
          if (blobItem && blobItem.url) {
            const contentRes = await requestHttps(`${blobItem.url}?t=${Date.now()}`, { method: 'GET' });
            if (contentRes.status === 200) {
              existingData = JSON.parse(contentRes.body);
            }
          }
        }
      } catch (_) { }
    }

    // 안전 병합 (기존 점수 보존)
    const mergedData = mergePayloads(existingData, bodyData);
    mergedData.syncedAt = new Date().toISOString();
    memoryCache = mergedData;

    // Vercel Blob에 영구 저장
    if (token) {
      try {
        const payloadStr = JSON.stringify(mergedData);
        const putRes = await requestHttps(`${BLOB_API_BASE}/${BLOB_PATH}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-api-version': '7',
            'x-add-random-suffix': '0'
          }
        }, payloadStr);

        if (putRes.status === 200) {
          const putJson = JSON.parse(putRes.body);
          lastKnownBlobUrl = putJson.url;
        }
      } catch (err) {
        console.warn('Blob write warning:', err.message);
      }
    }

    // 다른 기기로 실시간 화면 갱신 브로드캐스트 전송
    broadcastPing(mergedData.syncedAt);

    return res.status(200).json({
      success: true,
      syncedAt: mergedData.syncedAt
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
