// 启动入口：确保用量看板服务在跑，然后打开浏览器
// 服务已活 → 直接开页面；没活 → 后台拉起（隐藏窗口）再开。仅用 Node 内置模块
const http = require('http');
const { spawn, exec } = require('child_process');
const path = require('path');

const PORT = +(process.env.USAGE_PORT || 4620);
const URL = 'http://127.0.0.1:' + PORT;
function alive() {
  return new Promise((res) => {
    const req = http.get(URL + '/api/data', { timeout: 1200 }, (r) => { r.resume(); res(true); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}
(async () => {
  if (await alive()) {
    // 已在运行
  } else {
    const child = spawn(process.execPath, [path.join(__dirname, 'usage-server.js')], {
      cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true,
      env: Object.assign({}, process.env, { USAGE_IDLE_MS: process.env.USAGE_IDLE_MS || '180000' }),
    });
    child.on('error', () => {});
    child.unref();
    for (let i = 0; i < 20 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 500));
  }
  exec('start "" "' + URL + '"', () => {});
})();
