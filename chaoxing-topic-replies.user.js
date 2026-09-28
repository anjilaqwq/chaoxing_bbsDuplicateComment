// ==UserScript==
// @name         学习通讨论话题回复队列
// @namespace    local.chaoxing.topic-replies
// @version      0.4.3
// @description  仅在当前话题页回复；遇到平台频率冷却时等待并自动继续。
// @match        https://groupweb.chaoxing.com/course/topic/v3/bbs/*/replysList*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (!/\/course\/topic\/v3\/bbs\/.*\/replysList$/.test(location.pathname)) return;

  const STORAGE_KEY = 'cx-topic-replies-per-page-v2';
  const PRESENCE_PREFIX = 'cx-topic-replies-detail-presence-v1:';
  const topicKey = location.pathname;
  const defaults = () => ({
    text: '', total: 1, done: 0, delay: 2, cooldownMinutes: 1,
    cooldownUntil: 0, cooldownAttempts: 0, pending: false,
  });
  let running = false;
  let status = '';
  let checkingTabs = false;
  const tabId = crypto.randomUUID();
  const presenceKey = PRESENCE_PREFIX + tabId;
  const updatePresence = () => localStorage.setItem(presenceKey, String(Date.now()));
  updatePresence();
  const presenceTimer = setInterval(updatePresence, 2000);
  window.addEventListener('pagehide', () => {
    clearInterval(presenceTimer);
    localStorage.removeItem(presenceKey);
  });

  function anotherDetailTabOpen() {
    const now = Date.now();
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(PRESENCE_PREFIX) && key !== presenceKey) {
        if (now - Number(localStorage.getItem(key)) < 6000) return true;
      }
    }
    return false;
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')[topicKey];
      return { ...defaults(), ...saved };
    } catch (_) {
      return defaults();
    }
  }

  function save(value) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { /* 损坏的数据由新记录替代。 */ }
    all[topicKey] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    render();
  }

  function validInteger(value, min, max) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
  }

  const host = document.createElement('div');
  host.id = 'cx-topic-reply-panel';
  host.dataset.scriptVersion = '0.4.3';
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; position: fixed; z-index: 2147483647; right: 16px; top: 16px; width: 330px; color: #182431; font: 14px/1.45 system-ui, sans-serif; }
      * { box-sizing: border-box; }
      .panel { max-height: calc(100vh - 32px); overflow: auto; background: #fff; border: 1px solid #bccbd8; border-radius: 12px; box-shadow: 0 8px 28px #0003; padding: 14px; }
      h2 { margin: 0 0 8px; font-size: 17px; }
      label { display: block; margin: 9px 0 4px; }
      textarea, input { border: 1px solid #aab9c6; border-radius: 6px; padding: 7px; font: inherit; background: #fff; color: #182431; }
      textarea { width: 100%; min-height: 90px; resize: vertical; }
      input[type=number] { width: 90px; }
      button { border: 1px solid #2474b5; border-radius: 6px; background: #2474b5; color: #fff; padding: 6px 9px; font: inherit; cursor: pointer; }
      button.secondary { background: #fff; color: #205d8b; }
      button.danger { border-color: #b5473e; color: #a8372e; background: #fff; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      .row { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
      .title { overflow-wrap: anywhere; font-weight: 600; }
      .muted { color: #566473; font-size: 12px; }
      .message { margin-top: 10px; padding: 7px; border-radius: 6px; background: #edf4fa; overflow-wrap: anywhere; }
      .header { display: flex; justify-content: space-between; align-items: start; gap: 8px; }
      .header button { padding: 2px 7px; }
      .minimized .content { display: none; }
    </style>
    <div class="panel">
      <div class="header"><h2>当前话题回复</h2><button id="toggle" class="secondary" type="button">收起</button></div>
      <div class="content">
        <div id="title" class="title"></div>
        <label for="text">这道题的回复文字</label>
        <textarea id="text" placeholder="输入与你阅读的话题相关的回复"></textarea>
        <div class="row"><label for="total">计划回复数</label><input id="total" type="number" min="1" max="1000" step="1"></div>
        <div class="row"><label for="delay">每条间隔（秒）</label><input id="delay" type="number" min="1" max="3600" step="1"></div>
        <div class="row"><label for="cooldown">限流后先等（分钟）</label><input id="cooldown" type="number" min="1" max="60" step="1"></div>
        <div id="progress" class="muted"></div>
        <div class="row"><button id="start" type="button">开始或继续</button><button id="pause" class="secondary" type="button">暂停</button><button id="clear" class="danger" type="button">清除本题设置</button></div>
        <div id="message" class="message" role="status"></div>
      </div>
    </div>`;

  const $ = (selector) => shadow.querySelector(selector);
  const initial = load();
  $('#text').value = initial.text;
  $('#total').value = initial.total;
  $('#delay').value = initial.delay;
  $('#cooldown').value = initial.cooldownMinutes;

  function remainingCooldown(state) {
    return Math.max(0, Number(state.cooldownUntil || 0) - Date.now());
  }

  function formatDuration(milliseconds) {
    const seconds = Math.ceil(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}分${String(seconds % 60).padStart(2, '0')}秒`;
  }

  function render() {
    const state = load();
    $('#title').textContent = document.querySelector('.topicDetail_title span')?.textContent?.trim() || '当前话题';
    $('#progress').textContent = `已确认提交 ${state.done} / ${state.total} 条。输入内容和进度已保存在本浏览器。`;
    $('#text').disabled = running;
    $('#total').disabled = running;
    $('#delay').disabled = running;
    $('#cooldown').disabled = running;
    $('#start').disabled = running || checkingTabs;
    $('#start').textContent = state.pending ? '核实后继续' : '开始或继续';
    $('#pause').disabled = !running;
    $('#clear').disabled = running;
    const remaining = remainingCooldown(state);
    $('#message').textContent = state.pending && !running
      ? '上一条回复的结果尚未确认。请先在网页核实，再点击“核实后继续”按提示处理。'
      : remaining > 0
        ? `平台提示操作过于频繁；冷却剩余 ${formatDuration(remaining)}。${running ? '结束后自动续发。' : '点击开始后会先等完冷却。'}`
        : status || (running ? '正在提交当前话题。' : '只处理当前话题，不会跳转或打开其他页面。');
  }

  function saveFields() {
    const state = load();
    state.text = $('#text').value;
    state.total = validInteger($('#total').value, 1, 1000) || state.total;
    state.delay = validInteger($('#delay').value, 1, 3600) || state.delay;
    state.cooldownMinutes = validInteger($('#cooldown').value, 1, 60) || state.cooldownMinutes;
    save(state);
  }

  for (const selector of ['#text', '#total', '#delay', '#cooldown']) {
    $(selector).addEventListener('input', () => { if (!running) saveFields(); });
  }
  $('#toggle').addEventListener('click', () => {
    $('.panel').classList.toggle('minimized');
    $('#toggle').textContent = $('.panel').classList.contains('minimized') ? '展开' : '收起';
  });
  $('#pause').addEventListener('click', () => {
    running = false;
    status = '已暂停；若当前请求已发出，它仍可能完成。';
    render();
  });
  $('#clear').addEventListener('click', () => {
    if (!confirm('清除此话题已保存的回复文字和脚本进度？')) return;
    save(defaults());
    const state = load();
    $('#text').value = state.text;
    $('#total').value = state.total;
    $('#delay').value = state.delay;
    $('#cooldown').value = state.cooldownMinutes;
    status = '已清除本题设置。';
    render();
  });
  function waitForReplyForm(timeout = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const box = document.querySelector('.topicDetail_editContainer .replyEdit');
        const input = box?.querySelector('textarea[placeholder="回复话题"]');
        const button = box?.querySelector('.addReply');
        if (input && button && window.jQuery) {
          clearInterval(timer);
          resolve({ input, button });
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          const error = new Error('未找到可用的回复框或页面脚本。');
          error.definite = true;
          reject(error);
        }
      }, 250);
    });
  }

  async function submitOnce(text) {
    const form = await waitForReplyForm();
    if (form.input.value.trim() && form.input.value.trim() !== text) {
      const error = new Error('网页回复框已有与本题设置不同的文字，请先核对，避免误发。');
      error.definite = true;
      throw error;
    }
    return new Promise((resolve, reject) => {
      const jq = window.jQuery;
      let finished = false;
      const cleanup = () => { jq(document).off('ajaxComplete.cxTopicReplies', onComplete); clearTimeout(timer); };
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const onComplete = (_event, xhr, settings) => {
        if (!/\/pc\/invitation\/[^/]+\/addReplys(?:\?|$)/.test(settings.url || '')) return;
        let data = xhr.responseJSON;
        if (!data) {
          try { data = JSON.parse(xhr.responseText); } catch (_) { /* 结果不明确 */ }
        }
        if (!data) return finish(new Error(`回复结果不明确（HTTP ${xhr.status}）。`));
        if (!data.status) {
          const error = new Error(data.msg || '页面拒绝了本次回复。');
          error.definite = true;
          error.rateLimited = /操作过于频繁/.test(data.msg || '');
          return finish(error);
        }
        finish(null, data.datas ? '发布成功' : '已提交，等待审核');
      };
      const timer = setTimeout(() => finish(new Error('回复请求超时，结果不明确。')), 30000);
      jq(document).on('ajaxComplete.cxTopicReplies', onComplete);
      form.input.value = text;
      form.input.dispatchEvent(new Event('input', { bubbles: true }));
      try { form.button.click(); } catch (error) { finish(error); }
    });
  }

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  setInterval(() => { if (remainingCooldown(load()) > 0) render(); }, 1000);

  async function run() {
    while (running) {
      let state = load();
      if (state.done >= state.total) {
        running = false;
        status = '已达到本题计划回复数。';
        render();
        return;
      }
      if (remainingCooldown(state) > 0) {
        await sleep(Math.min(1000, remainingCooldown(state)));
        continue;
      }
      if (state.cooldownUntil) {
        state.cooldownUntil = 0;
        save(state);
      }
      state.pending = true;
      save(state);
      let result;
      try { result = await submitOnce(state.text); }
      catch (error) {
        state = load();
        if (error.definite) state.pending = false;
        if (error.rateLimited) {
          state.cooldownAttempts += 1;
          const minutes = Math.min(state.cooldownMinutes * 2 ** Math.min(state.cooldownAttempts - 1, 10), 60);
          state.cooldownUntil = Date.now() + minutes * 60_000;
          document.querySelector('.topicDetail_editContainer .cancleReplyBtn')?.click();
          save(state);
          status = `操作过于频繁；等待 ${minutes} 分钟后再试。`;
          render();
          continue;
        }
        save(state);
        running = false;
        status = `已停止：${error.message}`;
        render();
        return;
      }
      state = load();
      state.pending = false;
      state.done += 1;
      state.cooldownAttempts = 0;
      state.cooldownUntil = 0;
      save(state);
      status = `${result}；${state.done} / ${state.total}`;
      render();
      if (!running) return;
      await sleep(state.delay * 1000);
    }
  }

  $('#start').addEventListener('click', async () => {
    if (running || checkingTabs) return;
    checkingTabs = true;
    render();
    try {
      if (await anotherDetailTabOpen()) {
        status = '检测到另一张话题详情页。请只保留本页，再刷新本页后开始。';
        return;
      }
    const text = $('#text').value.trim();
    const total = validInteger($('#total').value, 1, 1000);
    const delay = validInteger($('#delay').value, 1, 3600);
    const cooldownMinutes = validInteger($('#cooldown').value, 1, 60);
    const state = load();
    if (state.pending) {
      const answer = prompt('请先在网页核实上一条回复。确认已发布或待审核请输入 1；确认未发布请输入 0；其他输入或取消则保持暂停。');
      if (answer !== '1' && answer !== '0') {
        status = '结果尚未确认，未继续发送。';
        return;
      }
      if (answer === '1') state.done += 1;
      state.pending = false;
      save(state);
    }
    if (!text || !total || !delay || !cooldownMinutes) {
      status = '请填写回复文字，并设置有效的回复数、间隔和冷却分钟数。';
      render();
      return;
    }
    if (state.done >= total) {
      status = '已达到计划数；如需继续，请增加“计划回复数”。';
      render();
      return;
    }
    state.text = text;
    state.total = total;
    state.delay = delay;
    state.cooldownMinutes = cooldownMinutes;
    save(state);
    running = true;
    status = '正在处理当前话题。';
    render();
    run();
    } finally {
      checkingTabs = false;
      render();
    }
  });

  render();
})();

