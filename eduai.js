/* ═══════════════════════════════════════════════════════════
 *  EduAI 橋接層 — 把 IECS 前端接上本地 EduAI AI 後端
 *
 *  架構：
 *    IECS 前端 (3000)  ──┬──►  IECS 後端 (4000)  使用者/登入/論壇
 *                        └──►  EduAI 後端 (8000) 簡報/測驗/問答  ← 本檔負責
 *
 *  EduAI 後端啟動方式（在 eduai/api/ 資料夾）：
 *    python -m uvicorn app:app --host 127.0.0.1 --port 8000
 * ═══════════════════════════════════════════════════════════ */

const EDUAI_BASE_URL = 'http://localhost:8000';

/* EduAI 對「12 字以內、又沒有問號」的輸入會回一句反問（那是教材生成情境的引導設計），
 * 但日常對話希望「什麼是遞迴」這種短問句直接得到答案，所以送出前補上問號。
 * 只影響送給後端的字串；畫面顯示與對話脈絡仍用使用者原文。 */
function _asQuestion(msg) {
  return (msg.length <= 12 && !/[?？\n]/.test(msg)) ? msg + '？' : msg;
}

const EduAI = {
  baseUrl: EDUAI_BASE_URL,

  /** 後端是否活著（頁面載入時檢查，好給使用者明確提示）。 */
  /** 探測後端狀態。
   *  後端是單一 worker + 同步呼叫模型，重任務進行中會卡住整個服務、
   *  連健康檢查都不回應。必須區分「沒啟動」與「忙碌中」，否則會誤報成沒啟動。 */
  _lastProbe: 'down',
  async probe() {
    try {
      const r = await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(4000) });
      this._lastProbe = r.ok ? 'ok' : 'down';
    } catch (e) {
      // 逾時＝服務活著但被前一個生成任務卡住；連線被拒＝真的沒啟動
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      this._lastProbe = timedOut ? 'busy' : 'down';
    }
    return this._lastProbe;
  },

  /** 後端是否可立即服務。 */
  async isOnline() {
    return (await this.probe()) === 'ok';
  },

  /** 輪詢生成進度：EduAI 生成需數分鐘，沒有進度提示使用者會以為當機。 */
  _startProgress(onProgress) {
    if (!onProgress) return null;
    const t0 = Date.now();
    return setInterval(async () => {
      try {
        const r = await fetch(`${this.baseUrl}/slide_progress`);
        const j = await r.json();
        const s = Math.floor((Date.now() - t0) / 1000);
        const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        // 第二個參數是後端估的百分比，頁面用它畫進度條
        if (j.stage && j.stage !== '完成') onProgress(`${j.stage}（已經過 ${mmss}）`, j.pct || 0);
      } catch { /* 進度拿不到不影響生成本身 */ }
    }, 2000);
  },

  async _postForBlob(path, form, onProgress) {
    const timer = this._startProgress(onProgress);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { method: 'POST', body: form });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch { /* 非 JSON 錯誤 */ }
        throw new Error(msg);
      }
      const presId = res.headers.get('X-Presentation-Id');
      const blob = await res.blob();
      return { url: URL.createObjectURL(blob), presId, blob, headers: res.headers };
    } finally {
      if (timer) clearInterval(timer);
    }
  },

  /** 主題（＋可選教材）→ 互動簡報 HTML。 */
  generateSlides(topic, content = '', theme = '瑞士國際', onProgress) {
    const form = new FormData();
    form.append('topic', topic);
    form.append('content', content);
    form.append('theme', theme);
    return this._postForBlob('/make_html_slide', form, onProgress);
  },

  /** YouTube 連結 → 互動簡報（自動抓字幕、長片會分段摘要）。 */
  generateFromYouTube(url, theme = '瑞士國際', onProgress) {
    const form = new FormData();
    form.append('url', url);
    form.append('theme', theme);
    return this._postForBlob('/youtube_slide', form, onProgress);
  },

  /** 主題（＋可選教材）→ 互動測驗 HTML。 */
  generateQuiz(topic, content = '', numMc = 5, numSa = 3, onProgress) {
    const form = new FormData();
    form.append('topic', topic);
    form.append('content', content);
    form.append('title', topic || '課程測驗');
    form.append('num_mc', numMc);
    form.append('num_sa', numSa);
    return this._postForBlob('/make_quiz_html', form, onProgress);
  },

  /** 主題（＋可選教材）→ 結構化測驗題目（可存進資料庫）。
   *  回傳 { title, questions:[{questionType, questionText, options, correctAnswer, explanation, orderIndex}] }
   *  舊的 generateQuiz 只回一份 HTML，關掉分頁就沒了、也記不了成績。 */
  async generateQuizJson(topic, content = '', numMc = 5, numSa = 3, onProgress) {
    const form = new FormData();
    form.append('topic', topic);
    form.append('content', content);
    form.append('title', topic || '課程測驗');
    form.append('num_mc', numMc);
    form.append('num_sa', numSa);
    const timer = this._startProgress(onProgress);
    try {
      const res = await fetch(`${this.baseUrl}/make_quiz_json`, { method: 'POST', body: form });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    } finally {
      if (timer) clearInterval(timer);
    }
  },

  /** 上傳 PDF，回傳抽出的純文字（可當教材內容用）。 */
  async uploadPdf(file) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${this.baseUrl}/upload_pdf`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`PDF 讀取失敗（HTTP ${res.status}）`);
    return res.json();
  },

  /** 一般問答（文字轉譯 / 講義生成用）。
   *  history：[{role:'user'|'assistant', content:'…'}]，帶入才能接續前文追問。 */
  async chat(message, content = '', history = []) {
    const form = new FormData();
    form.append('message', _asQuestion(message));
    if (content) form.append('content', content);
    if (history.length) form.append('history', JSON.stringify(history));
    const res = await fetch(`${this.baseUrl}/chat`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return j.reply || '';
  },

  /** 串流版問答：文字邊產生邊回傳，日常對話體感快很多。
   *  onChunk(片段) 逐段呼叫；回傳完整回覆字串。 */
  async chatStream(message, content = '', history = [], onChunk) {
    const form = new FormData();
    form.append('message', _asQuestion(message));
    if (content) form.append('content', content);
    if (history.length) form.append('history', JSON.stringify(history));

    const res = await fetch(`${this.baseUrl}/chat_stream`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE：以空行分隔的 data: {...} 區塊
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        let data;
        try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (data.error) throw new Error(data.error);
        if (data.chunk) { full += data.chunk; onChunk?.(data.chunk); }
        if (data.reply) { full += data.reply; onChunk?.(data.reply); }  // 模糊輸入時一次送完
      }
    }
    return full;
  },

  /** 主題（＋可選教材）→ 教學影片 MP4。
   *  回傳 { url, timeline }；timeline 為 [{start, title, text}]，供字幕時間軸顯示。 */
  async generateVideo(topic, content = '', voiceName = 'zh-TW 女聲（曉臻）', onProgress) {
    const form = new FormData();
    form.append('topic', topic);
    form.append('content', content);
    form.append('voice_name', voiceName);
    const r = await this._postForBlob('/make_teaching_video', form, onProgress);
    let timeline = [];
    try {
      const raw = r.headers?.get('X-Video-Timeline');
      if (raw) timeline = JSON.parse(raw);
    } catch { /* 沒有時間軸不影響影片播放 */ }
    return { url: r.url, timeline };
  },

  /** 取得簡報各頁標題（給大綱側欄用）。 */
  async presentationInfo(presId) {
    const res = await fetch(`${this.baseUrl}/presentation_info?pres_id=${presId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** 匯出 PPTX 檔：直接用伺服器上已生成的簡報，內文不會掉。
   *  （舊做法是把標題轉成文字送回後端再解析，格式對不上時整份只剩封面。）
   *  匯出的 .pptx 可直接匯入 Canva 再套版。 */
  async exportPptxById(presId) {
    const form = new FormData();
    form.append('pres_id', presId);
    const res = await fetch(`${this.baseUrl}/export_pptx`, { method: 'POST', body: form });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch { /* 非 JSON */ }
      throw new Error(msg);
    }
    return res.blob();
  },

  /** 舊版：由文字大綱產生 PPTX（後端沒有該簡報時的退路）。 */
  async exportPptx(outline, title) {
    const form = new FormData();
    form.append('outline', outline);
    form.append('title', title);
    const res = await fetch(`${this.baseUrl}/make_pptx`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },
};

/* ── 首頁引導流程 → 各功能頁的資料傳遞 ──
 * index.js 收集主題／程度／格式後存入，功能頁載入時讀出並自動生成。 */
const EduAIGuide = {
  KEY: 'eduai_guide',
  save(data) { sessionStorage.setItem(this.KEY, JSON.stringify(data)); },
  load() {
    try { return JSON.parse(sessionStorage.getItem(this.KEY) || 'null'); }
    catch { return null; }
  },
  clear() { sessionStorage.removeItem(this.KEY); },
};

/** 後端沒開時顯示明確提示，而不是讓使用者對著轉圈圈猜。 */
function eduaiOfflineMessage() {
  if (EduAI._lastProbe === 'busy') {
    return `AI 引擎正在忙（${EDUAI_BASE_URL}）。` + String.fromCharCode(10, 10) +
           `它一次只能處理一個請求，目前可能正在生成簡報或影片。` + String.fromCharCode(10) +
           `請等前一個任務完成後再試一次。`;
  }
  return `無法連線到 EduAI（${EDUAI_BASE_URL}）。` + String.fromCharCode(10, 10) +
         `請先啟動 AI 後端：` + String.fromCharCode(10) +
         `1. 開啟終端機，進到 ai-engine/api 資料夾` + String.fromCharCode(10) +
         `2. 執行：python -m uvicorn app:app --host 127.0.0.1 --port 8000`;
}
