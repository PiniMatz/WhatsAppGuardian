// Smoke tests in mock (in-memory) mode. Run: npm test
process.env.PORT = '0';
process.env.DASHBOARD_PASSWORD = 'pw';
process.env.DEVICE_TOKEN = 'tok';
delete process.env.GEMINI_API_KEY; // analysis will report "failed" -> exercises the failure path
const assert = require('assert');
const http = require('http');
const { app, sanitizeAlertInput, isDuplicateText } = require('./server');

const server = http.createServer(app).listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const basic = 'Basic ' + Buffer.from('parent:pw').toString('base64');
  const j = async (method, path, { headers = {}, body } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  };
  try {
    assert.strictEqual((await j('GET', '/health')).status, 200);
    assert.strictEqual((await j('GET', '/api/alerts')).status, 401, 'dashboard API requires password');
    assert.strictEqual((await j('POST', '/api/alerts', { body: { kid_name: 'a', target_text: 'b' } })).status, 401, 'device route requires token');
    assert.strictEqual((await j('GET', '/api/config/keywords')).status, 401);
    assert.strictEqual((await j('GET', '/api/config/keywords', { headers: { 'x-device-token': 'tok' } })).status, 200);
    assert.strictEqual((await j('POST', '/api/alerts', { headers: { 'x-device-token': 'tok' }, body: { kid_name: '' } })).status, 400);

    const post = await j('POST', '/api/alerts', { headers: { 'x-device-token': 'tok' }, body: { kid_name: 'נועם', chat_name: 'כיתה', sender: 'שירה', target_text: '<img src=x onerror=alert(1)> חרם', context: [{ sender: 'x', text: 'y' }] } });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.data.analysis.analysis_failed, true);

    const dup = await j('POST', '/api/alerts', { headers: { 'x-device-token': 'tok' }, body: { kid_name: 'נועם', target_text: '<img src=x onerror=alert(1)> חרם', context: [{ sender: 'x', text: 'y' }] } });
    assert.strictEqual(dup.status, 200);

    const list = await j('GET', '/api/alerts', { headers: { Authorization: basic } });
    assert.strictEqual(list.data.alerts.length, 1, 'dedup keeps one alert');
    const v = list.data.version;
    const same = await j('GET', '/api/alerts?v=' + v, { headers: { Authorization: basic } });
    assert.strictEqual(same.data.unchanged, true);

    const id = list.data.alerts[0].id;
    assert.strictEqual((await j('POST', '/api/alerts/bulk-save', { headers: { Authorization: basic }, body: { ids: [id] } })).status, 200);
    assert.strictEqual((await j('GET', '/api/alerts', { headers: { Authorization: basic } })).data.alerts[0].saved, true);
    assert.strictEqual((await j('POST', '/api/alerts/bulk-delete', { headers: { Authorization: basic }, body: { ids: ['../x'] } })).status, 400);
    assert.strictEqual((await j('POST', '/api/config/keywords', { headers: { Authorization: basic }, body: { keywords: [] } })).status, 400, 'empty keyword list refused');
    assert.strictEqual((await j('DELETE', '/api/alerts/' + id, { headers: { Authorization: basic } })).status, 200);
    assert.strictEqual((await j('GET', '/api/alerts', { headers: { Authorization: basic } })).data.alerts.length, 0);

    assert.ok(isDuplicateText('את לא משתתפת', 'את לא משתתפת איתנו'));
    assert.strictEqual(sanitizeAlertInput({ kid_name: 'a', target_text: '' }), null);
    console.log('All server tests passed');
    process.exit(0);
  } catch (e) {
    console.error('TEST FAILED:', e);
    process.exit(1);
  }
});
