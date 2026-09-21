// Run against an isolated local dev browser:
// playwright-cli -s=rh-test open http://127.0.0.1:5178
// playwright-cli -s=rh-test run-code --filename tests/multitask.browser.js
async page => {
  await page.addInitScript(() => {
    localStorage.setItem('rh_terms_agreed', 'true');
    localStorage.setItem('rh_startup_view', 'multitask');
    localStorage.setItem('rh_runninghub_region_mode', 'cn');
    localStorage.setItem('rh_api_keys_v2', JSON.stringify([
      { id: 'a', apiKey: 'test-account-a', concurrency: 1 },
      { id: 'b', apiKey: 'test-account-b', concurrency: 1 }
    ]));
    window.rhMock = { submissions: [], finished: {}, occupied: {}, errors: {}, rejectNext: {} };
    const realFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!url.hostname.includes('runninghub.')) return realFetch(input, init);
      const mock = window.rhMock;
      const key = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') || '';
      let data;
      if (url.pathname.endsWith('/queue/status')) {
        if (mock.errors[key]) return new Response('{}', { status: mock.errors[key] });
        const count = mock.submissions.filter(t => t.key === key && !mock.finished[t.taskId]).length + (mock.occupied[key] || 0);
        data = { code: 0, data: { concurrentLimit: 1, runningCount: String(count), queuedCount: '0', totalCurrentTasks: String(count), apiKeyType: 'NORMAL' } };
      } else if (url.pathname.endsWith('/apiCallDemo')) {
        const app = url.searchParams.get('webappId');
        data = { code: 0, data: { webappName: `测试应用 ${app}`, nodeInfoList: [{ nodeId: '1', fieldName: 'prompt', fieldType: 'STRING', fieldValue: 'test', nodeName: '提示词' }] } };
      } else if (url.pathname.endsWith('/ai-app/run')) {
        if (mock.rejectNext[key]) {
          mock.rejectNext[key]--;
          return new Response(JSON.stringify({ code: 421, msg: 'TASK_QUEUE_MAXED' }), { status: 200 });
        }
        const body = JSON.parse(init.body);
        const taskId = `task-${mock.submissions.length + 1}`;
        mock.submissions.push({ key, taskId, body, time: Date.now() });
        data = { code: 0, data: { taskId, taskStatus: 'RUNNING' } };
      } else if (url.pathname.endsWith('/v2/query')) {
        const { taskId } = JSON.parse(init.body);
        data = { taskId, status: mock.finished[taskId] ? 'SUCCESS' : 'RUNNING', results: [] };
      } else if (url.pathname.endsWith('/outputs')) {
        data = { code: 0, data: [] };
      } else {
        data = { code: 0, data: { list: [], records: [] } };
      }
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
  await page.reload();
  await page.getByRole('textbox', { name: '请输入 WebApp ID，或粘贴应用详情页链接' }).fill('111');
  await page.getByRole('button', { name: '加载', exact: true }).click();
  await page.getByRole('button', { name: '运行', exact: true }).waitFor();
  await page.getByRole('button', { name: '复制卡片', exact: true }).click();
  await page.getByRole('button', { name: '运行', exact: true }).first().click();
  await page.waitForFunction(() => window.rhMock.submissions.length === 1);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.waitForFunction(() => window.rhMock.submissions.length === 2);
  const keys = await page.evaluate(() => window.rhMock.submissions.map(t => t.key));
  if (new Set(keys).size !== 2) throw new Error('Second card did not use the second account');
  await page.getByRole('button', { name: '复制卡片', exact: true }).first().click();
  const check = (value, message) => { if (!value) throw new Error(message); };
  // Third card can queue while both accounts are busy, then cancel without submitting.
  await page.getByRole('button', { name: '运行', exact: true }).click();
  check((await page.evaluate(() => window.rhMock.submissions.length)) === 2, 'exceeded two-account capacity');
  await page.getByRole('button', { name: '取消运行', exact: true }).nth(2).click();
  await page.getByRole('button', { name: '运行', exact: true }).waitFor();
  check((await page.evaluate(() => window.rhMock.submissions.length)) === 2, 'cancelled queued card was submitted');
  // A completed card becomes runnable while the other card still runs.
  await page.evaluate(() => { window.rhMock.finished['task-1'] = true; });
  await page.getByRole('button', { name: '运行', exact: true }).first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '运行').length === 2);
  await page.getByText('应用运行选项', { exact: true }).first().click();
  await page.getByLabel('应用访问密码（可选）').first().fill('mock-access-password');
  await page.getByLabel('实例保留时长（秒，仅企业共享）').first().fill('30');
  await page.getByRole('button', { name: '运行', exact: true }).first().click();
  await page.waitForFunction(() => window.rhMock.submissions.length === 3);
  const third = await page.evaluate(() => window.rhMock.submissions[2]);
  check(third.key === 'test-account-a', 'rerun failed to use freed account');
  check(third.body.accessPassword === 'mock-access-password' && third.body.retainSeconds === 30, 'run options were not propagated');
  check(!(await page.evaluate(() => window.rhMock.finished['task-2'])), 'other card unexpectedly completed');
  // Cancel only the first card: tracking the second must continue.
  await page.getByRole('button', { name: '取消运行', exact: true }).first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '取消运行').length === 1);
  await page.evaluate(() => { window.rhMock.finished['task-2'] = true; });
  await page.getByRole('button', { name: '全部运行', exact: true }).waitFor();
  await page.evaluate(() => {
    window.rhMock.submissions.forEach(t => { window.rhMock.finished[t.taskId] = true; });
    window.rhMock.errors['test-account-a'] = 401;
  });
  await page.getByRole('button', { name: '运行', exact: true }).first().click();
  await page.waitForFunction(() => window.rhMock.submissions.length === 4);
  check((await page.evaluate(() => window.rhMock.submissions[3].key)) === 'test-account-b', 'invalid account blocked the healthy account');
  await page.evaluate(() => { window.rhMock.finished['task-4'] = true; });
  await page.getByRole('button', { name: '全部运行', exact: true }).waitFor();
  // Capacity held by another client must be polled and recovered automatically.
  await page.evaluate(() => { window.rhMock.occupied['test-account-b'] = 1; });
  await page.getByRole('button', { name: '运行', exact: true }).first().click();
  await page.getByRole('button', { name: '取消运行', exact: true }).waitFor();
  check((await page.evaluate(() => window.rhMock.submissions.length)) === 4, 'external capacity was ignored');
  await page.evaluate(() => { window.rhMock.occupied['test-account-b'] = 0; });
  await page.waitForFunction(() => window.rhMock.submissions.length === 5);
  await page.evaluate(() => { window.rhMock.finished['task-5'] = true; });
  await page.getByRole('button', { name: '全部运行', exact: true }).waitFor();
  // A full-account rejection is requeued and may use the other account.
  await page.evaluate(() => {
    window.rhMock.errors = {};
    window.rhMock.rejectNext['test-account-a'] = 1;
  });
  await page.getByRole('button', { name: '运行', exact: true }).first().click();
  await page.waitForFunction(() => window.rhMock.submissions.length === 6);
  check((await page.evaluate(() => window.rhMock.submissions[5].key)) === 'test-account-b', 'capacity rejection did not use another free account');
  await page.evaluate(() => { window.rhMock.finished['task-6'] = true; });
  await page.getByRole('button', { name: '全部运行', exact: true }).waitFor();
  console.log('PASS: multi-account concurrency, append/rerun, cancellation, invalid account isolation, remote capacity recovery, capacity rejection retry, run options');
}
