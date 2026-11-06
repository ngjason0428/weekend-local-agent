// Browser check of the deployed public sample UI. Usage: node verify_browser.mjs <siteUrl> <commitSha> <outJson> <screenshotDir>
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const [siteUrl, commit, outJson, shotDir] = process.argv.slice(2);
const report = { checked_at: new Date().toISOString(), site_url: siteUrl, tested_application_commit: commit, passed: false,
  scope: 'Deployed public sample UI; not a live activity-provider test.', checks: [], errors: [], api_calls: [],
  viewports: [{ width: 1440, height: 1000 }, { width: 390, height: 844 }],
  screenshots: ['public-home.png', 'public-routes.png', 'public-invitation.png', 'public-mobile.png'] };
const check = (name, passed, detail) => { report.checks.push({ name, passed: !!passed, detail }); console.log(passed ? 'PASS' : 'FAIL', name, detail); };
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
const watch = page => {
  page.on('pageerror', e => report.errors.push(String(e)));
  page.on('request', r => { const p = new URL(r.url()).pathname; if (/\/turn$|\/api\//.test(p)) report.api_calls.push(r.url()); });
};
const overflows = [];
try {
  const page = await ctx.newPage(); watch(page);
  const res = await page.goto(siteUrl, { waitUntil: 'networkidle' });
  const banner = await page.locator('.static-preview-banner').innerText();
  const city = await page.getByLabel('常住城市').inputValue();
  overflows.push(['desktop-home', await overflow(page)]);
  await page.screenshot({ path: path.join(shotDir, 'public-home.png') });
  check('homepage', res.status() === 200 && siteUrl.startsWith('https://') && city === '' && banner.includes('非实时活动'),
    `HTTPS 首页 ${res.status()}；城市输入框为空（未预设城市）；顶部标注「${banner.split(' · ').slice(0, 2).join(' · ')}」。`);

  // Non-Hangzhou resident: Chengdu must be kept, no Hangzhou routes substituted.
  await page.getByLabel('常住城市').fill('成都');
  await page.getByRole('button', { name: '确认居住地 ↗' }).click();
  await page.getByLabel('告诉我你的周末期待').fill('我住在成都，两个人这周六想看展、吃火锅');
  await page.getByRole('button', { name: '发送并进入工作台' }).click();
  await page.locator('.message.assistant .bubble').last().filter({ hasText: '尚未接通' }).waitFor();
  const summary = await page.locator('.summary-card').innerText();
  const routeBadge = await page.locator('nav button', { hasText: '路线方案' }).locator('i').count();
  check('unsupported_live_request', summary.includes('成都') && routeBadge === 0,
    `成都请求后，条件栏保留「成都」，回复提示真实活动检索尚未接通；路线数 ${routeBadge}，没有自动替换为杭州推荐。`);

  // Actively choose the Hangzhou sample.
  await page.getByRole('button', { name: /体验杭州示例/ }).click();
  await page.locator('.chat-plan-preview button').first().waitFor();
  const previewCount = await page.locator('.chat-plan-preview button').count();
  await page.locator('nav button', { hasText: '路线方案' }).click();
  const cards = page.locator('.route-card');
  const n = await cards.count();
  const cityLine = await page.locator('.panel-heading p').first().innerText();
  check('sample_entry', previewCount === 3 && n === 3 && cityLine.startsWith('杭州'), `主动点击「体验杭州示例」后载入 ${n} 套杭州样例（${cityLine}）。`);

  const titles = [];
  for (let i = 0; i < n; i++) { await cards.nth(i).click(); titles.push(await page.locator('.route-detail h3').innerText()); }
  const note = await page.locator('.result-data-label').innerText();
  check('routes', new Set(titles).size === 3 && note.includes('历史示意日期'), `依次选择三套路线，详情标题随之切换：${titles.join(' / ')}；页面标注历史示意日期。`);

  await cards.nth(1).click();
  await page.locator('.toast').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
  await page.screenshot({ path: path.join(shotDir, 'public-routes.png'), fullPage: false });
  overflows.push(['desktop-routes', await overflow(page)]);

  // JSON export
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '↓ 导出完整 JSON' }).click()]);
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  const plans = exported.next_step?.result?.plans || [];
  check('json_export', exported.schema_version === '1.0' && plans.length === 3, `导出 ${download.suggestedFilename()}，可解析，schema_version=${exported.schema_version}，包含 ${plans.length} 套样例路线。`);

  // Invitation for the canal route + copy
  const target = '运河边的松弛感';
  await cards.filter({ hasText: target }).click();
  await page.getByRole('button', { name: '为这条路线写邀请函 ↗' }).click();
  await page.locator('#invitation-copy').waitFor();
  const tab = await page.locator('.invitation-tabs button.current').innerText();
  const invitation = await page.locator('#invitation-copy').innerText();
  const expected = plans.find(p => p.title === target)?.invitation || '';
  await page.getByRole('button', { name: '复制邀请函 ↗' }).click();
  const toastNode = page.locator('.toast', { hasText: '已复制' });
  await toastNode.waitFor({ timeout: 5000 }).catch(() => {});
  const toast = await page.locator('.toast').innerText();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  overflows.push(['desktop-invitation', await overflow(page)]);
  await page.screenshot({ path: path.join(shotDir, 'public-invitation.png') });
  check('invitation', tab === target && invitation.trim() === expected.trim() && toast.includes('已复制') && clip.trim() === expected.trim(),
    `为选中的「${tab}」生成邀请函，内容与该路线一致；点击复制后提示「${toast}」，剪贴板内容一致。`);
  await page.close();

  // Mobile
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const m = await mctx.newPage(); watch(m);
  await m.goto(siteUrl, { waitUntil: 'networkidle' });
  overflows.push(['mobile-home', await overflow(m)]);
  await m.getByRole('button', { name: /先拆一个样例盲盒/ }).click();
  await m.locator('.chat-plan-preview button').first().waitFor();
  overflows.push(['mobile-chat', await overflow(m)]);
  await m.locator('nav button', { hasText: '路线方案' }).click();
  const mCards = await m.locator('.route-card').count();
  overflows.push(['mobile-routes', await overflow(m)]);
  await m.evaluate(() => window.scrollTo(0, 0));
  await m.screenshot({ path: path.join(shotDir, 'public-mobile.png') });
  await mctx.close();
  const worst = Math.max(...overflows.map(o => o[1]));
  check('responsive', worst <= 0 && mCards === 3, `1440px 桌面与 390px 手机流程共 ${overflows.length} 个页面状态，最大横向溢出 ${worst}px；手机端可看到 ${mCards} 套路线。`);

  check('network_boundary', report.api_calls.length === 0, `样例交互未请求 /turn 或 /api/*（记录到 ${report.api_calls.length} 次），没有冒充实时搜索。`);
  check('javascript', report.errors.length === 0, `页面脚本错误为 ${report.errors.length}。`);
} catch (e) {
  report.errors.push(String(e)); check('run', false, String(e));
} finally {
  await browser.close();
}
report.passed = report.checks.length > 0 && report.checks.every(c => c.passed);
fs.writeFileSync(outJson, JSON.stringify(report, null, 2) + '\n');
console.log('passed =', report.passed);
process.exit(report.passed ? 0 : 1);
