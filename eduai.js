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

// AI 引擎位址：本機開發直接打 8000；從外面（通道／其他裝置）進來時走 Express 的 /ai 轉接，
// 這樣對外只需要一個網址，也不用處理跨域。
const EDUAI_BASE_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:8000'
  : '/ai';

/* EduAI 對「12 字以內、又沒有問號」的輸入會回一句反問（那是教材生成情境的引導設計），
 * 但日常對話希望「什麼是遞迴」這種短問句直接得到答案，所以送出前補上問號。
 * 只影響送給後端的字串；畫面顯示與對話脈絡仍用使用者原文。 */
function _asQuestion(msg) {
  return (msg.length <= 12 && !/[?？\n]/.test(msg)) ? msg + '？' : msg;
}

/* ── 上傳講義的圖片：存在瀏覽器的 IndexedDB ──
 * 主頁讀完講義後存起來，跳到簡報頁生成時再拿出來一起送出。
 * 圖片可能好幾 MB，sessionStorage 放不下，所以用 IndexedDB。
 * 記錄上「這批圖屬於哪個主題」，避免之後生成別的主題時誤用舊圖。 */
const EduAIMaterial = {
  _db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('eduai', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('material');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async _put(value) {
    const db = await this._db();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('material', 'readwrite');
      tx.objectStore('material').put(value, 'images');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  async _get() {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const req = db.transaction('material').objectStore('material').get('images');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },
  save(images) { return this._put({ topic: '', images }).catch(() => {}); },
  async setTopic(topic) {
    try { const r = await this._get(); if (r) await this._put({ ...r, topic }); } catch { /* 存不了就不帶圖 */ }
  },
  /** 只回傳屬於這個主題的圖。 */
  async load(topic) {
    try { const r = await this._get(); return r && r.topic === topic ? r.images || [] : []; }
    catch { return []; }
  },
  clear() { return this._put(null).catch(() => {}); },
};

/** 把文字轉成可安全放進 innerHTML 的字串。標題、主題可能來自 AI 或資料庫，
 *  而資料庫可以被任何人寫入，不跳脫就會變成 XSS。 */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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

  /** 送出長時間的生成請求（或接上已經在跑的那份），等到完成後回傳一般的 Response。
   *
   *  一律交給網站伺服器排隊：伺服器立刻回工作編號，瀏覽器每 3 秒問一次狀態。
   *  原本瀏覽器直接等 AI 引擎回應，從外面連進來的請求撐不過 5 分鐘就被切斷，
   *  簡報卻要跑 8～15 分鐘；切到別頁再回來也只能從頭生成。
   *  onProgress(文字, 百分比)：輪到自己時顯示引擎進度，還沒輪到就顯示排第幾。 */
  async _runJob(path, form, onProgress, jobId) {
    const store = 'eduai_job:' + path;
    const key = form ? this._jobKey(form) : '';
    let resumed = !!jobId;
    if (!jobId && form) {
      // 同一頁、同樣的輸入已經有工作在跑（使用者離開後又回來）→ 接上它，不重新生成
      const saved = this._loadJob(path);
      if (saved && saved.key === key) { jobId = saved.jobId; resumed = true; }
    }
    if (!jobId) {
      const u = EduAIStore._user();
      const start = await fetch(`${API_BASE_URL}/ai-jobs${path}`, {
        method: 'POST', body: form,
        headers: { 'X-Job-Topic': encodeURIComponent(form.get('topic') || form.get('url') || ''),
                   'X-User-Id': u ? String(u.id) : '' },
      });
      if (!start.ok) throw new Error(`HTTP ${start.status}`);
      jobId = (await start.json()).jobId;
      try {
        localStorage.setItem(store, JSON.stringify(
          { jobId, key, topic: form.get('topic') || '', t: Date.now() }));
      } catch { /* 無痕模式存不了就算了，只是不能接續 */ }
    }
    const forget = () => {
      try { if ((this._loadJob(path) || {}).jobId === jobId) localStorage.removeItem(store); } catch { /* 同上 */ }
    };
    const t0 = Date.now();
    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    for (let misses = 0, first = true; ; first = false) {
      if (!first) await new Promise(r => setTimeout(r, 3000));
      let r = null, j = null;
      try {
        r = await fetch(`${API_BASE_URL}/ai-jobs/${jobId}/status`, { signal: AbortSignal.timeout(8000) });
        j = await r.json();
      } catch { /* 下面當作這次沒問到 */ }
      if (r && r.status === 404) {
        forget();
        // 要接的舊工作已經不在（伺服器重啟過）→ 重新送一次
        if (resumed && form) return this._runJob(path, form, onProgress);
        throw new Error((j && j.error) || '找不到這個生成工作。');
      }
      if (!j) {
        // 網路短暫不穩就再試，連續失敗一分鐘才放棄
        if (++misses > 20) throw new Error('連線中斷，請稍後重新整理頁面，生成會自動接續。');
        continue;
      }
      misses = 0;
      if (j.status !== 'running' && j.status !== 'queued') {
        const res = await fetch(`${API_BASE_URL}/ai-jobs/${jobId}/result`);
        forget();
        return res;
      }
      if (onProgress) {
        if (j.cancelRequested) {
          onProgress('正在停止…', 0);
        } else if (j.status === 'queued') {
          onProgress(`排隊中，前面還有 ${j.position} 份工作（AI 引擎一次只能做一份）`, 1);
        } else {
          const p = j.progress || {};
          // 經過時間以引擎實際開始算，切頁回來不會歸零
          const sec = p.elapsed || Math.round((Date.now() - (j.startedAt || t0)) / 1000);
          onProgress(`${p.stage && p.busy ? p.stage : 'AI 生成中…'}（已經過 ${fmt(sec)}）`, p.busy ? p.pct : 2);
        }
      }
    }
  },

  /** 同一份工作的判斷依據：送出的主要欄位都一樣。 */
  _jobKey(form) {
    return ['topic', 'url', 'pres_id', 'index', 'instruction', 'voice_name', 'content']
      .map(k => form.get(k) || '').join('|');
  },

  _loadJob(path) {
    try {
      const j = JSON.parse(localStorage.getItem('eduai_job:' + path) || 'null');
      // 伺服器只保留完成後 30 分鐘；生成最久十幾分鐘，超過 3 小時一定拿不到了
      if (j && Date.now() - j.t < 3 * 3600 * 1000) return j;
    } catch { /* 讀不到當作沒有 */ }
    return null;
  },

  /** 這一頁、這個主題是否有還沒拿回結果的生成工作。
   *  有的話不必先檢查引擎：引擎正忙著做的就是這份，檢查只會誤報「無法連線」。 */
  hasPendingJob(path, topic) {
    const j = this._loadJob(path);
    return !!(j && j.topic === topic);
  },

  /** 停止自己的生成工作（排隊中直接取消；進行中請引擎停下來）。 */
  async cancelJob(jobId) {
    const u = EduAIStore._user();
    const r = await fetch(`${API_BASE_URL}/ai-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST', headers: { 'X-User-Id': u ? String(u.id) : '' },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },

  /** 查一個工作的狀態（背景工作區的「開啟」連結用）。 */
  async jobStatus(jobId) {
    const r = await fetch(`${API_BASE_URL}/ai-jobs/${encodeURIComponent(jobId)}/status`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },

  async _postForBlob(path, form, onProgress, jobId) {
    const res = await this._runJob(path, form, onProgress, jobId);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch { /* 非 JSON 錯誤 */ }
      throw new Error(msg);
    }
    const presId = res.headers.get('X-Presentation-Id');
    const blob = await res.blob();
    return { url: URL.createObjectURL(blob), presId, blob, headers: res.headers };
  },

  /** 接上已經在背景跑的簡報工作（從背景工作區點進來）。 */
  resumeSlides(jobId, onProgress) {
    return this._postForBlob('/make_html_slide', null, onProgress, jobId);
  },

  /** 主題（＋可選教材）→ 互動簡報 HTML。 */
  /** images：上傳講義裡取出的圖 [{blob, caption}]，AI 會把它們放到內容相關的投影片。 */
  generateSlides(topic, content = '', theme = '瑞士國際', onProgress, images = []) {
    const form = new FormData();
    form.append('topic', topic);
    form.append('content', content);
    form.append('theme', theme);
    if (images.length) {
      images.forEach((im, k) => form.append('images', im.blob, `material-${k + 1}.jpg`));
      form.append('image_captions', JSON.stringify(images.map(im => im.caption || '')));
    }
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
  /** numOpen：開放題總數，簡答／問答的比例由 AI 依教材深淺決定。 */
  async generateQuizJson(topic, content = '', numMc = 5, numOpen = 5, onProgress) {
    const form = new FormData();
    form.append('topic', topic);
    form.append('content', content);
    form.append('title', topic || '課程測驗');
    form.append('num_mc', numMc);
    form.append('num_sa', numOpen);
    const res = await this._runJob('/make_quiz_json', form, onProgress);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  },

  /** 只抽出 PDF 的文字（不叫模型整理，幾秒就好），給「上傳講義後生成」用。 */
  async extractPdf(file) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${this.baseUrl}/extract_pdf`, { method: 'POST', body: form });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
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
    return this._videoResult(await this._postForBlob('/make_teaching_video', form, onProgress));
  },

  /** 接上已經在背景跑的影片工作（從背景工作區點進來）。 */
  async resumeVideo(jobId, onProgress) {
    return this._videoResult(await this._postForBlob('/make_teaching_video', null, onProgress, jobId));
  },

  _videoResult(r) {
    let timeline = [];
    try {
      const raw = r.headers?.get('X-Video-Timeline');
      if (raw) timeline = JSON.parse(raw);
    } catch { /* 沒有時間軸不影響影片播放 */ }
    return { url: r.url, timeline, blob: r.blob };
  },

  /** 用自然語言修改簡報的某一頁（其他頁不動）。
   *  後端只重寫那一張，再把整份重新組裝，pres_id 維持不變，所以可以一直改。
   *  回傳 { url, presId }，url 是新版本的簡報。 */
  editSlide(presId, index, instruction, onProgress) {
    const form = new FormData();
    form.append('pres_id', presId);
    form.append('index', index);
    form.append('instruction', instruction);
    return this._postForBlob('/edit_slide', form, onProgress);
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

/* ── 生成結果寫入資料庫 ──
 * 資料表 materials / material_outputs / presentation_slides / video_captions 早就在
 * schema 裡，這裡把 AI 產出的東西真正寫進去。同一次頁面載入、同一主題只建一筆
 * material，之後每次生成或修改都新增一筆 output（等於保留每個版本）。
 * 沒登入或後端沒開就靜靜略過：留不留紀錄不該擋住使用者看結果。 */
const EduAIStore = {
  _materialId: null,
  _materialKey: '',

  _user() {
    try { return JSON.parse(localStorage.getItem('iecs_user') || 'null'); }
    catch { return null; }
  },

  async _ensureMaterial(topic, level, sourceType) {
    const key = `${topic}|${level || ''}`;
    if (this._materialId && this._materialKey === key) return this._materialId;
    const u = this._user();
    if (!u) return null;
    const r = await fetch(`${API_BASE_URL}/api/materials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id, title: topic, sourceType: sourceType || 'topic_guide',
                             topic, level: level || null }),
    });
    if (!r.ok) return null;
    const m = await r.json();
    this._materialId = m.id;
    this._materialKey = key;
    return m.id;
  },

  /** 儲存一份生成結果。
   *  opts: { topic, level, formatType:'text'|'presentation'|'video', contentText, slides, captions }
   *  回傳 { materialId, outputId } 或 null（未登入／失敗）。 */
  async saveOutput(opts) {
    try {
      const materialId = await this._ensureMaterial(opts.topic, opts.level, opts.sourceType);
      if (!materialId) return null;
      const r = await fetch(`${API_BASE_URL}/api/materials/${materialId}/outputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formatType: opts.formatType,
          contentText: opts.contentText || null,
          fileUrl: opts.fileUrl || null,
          slides: opts.slides || [],
          captions: opts.captions || [],
        }),
      });
      if (!r.ok) return null;
      const o = await r.json();
      // 有檔案本體（簡報 HTML／影片 MP4）就一併存到伺服器，之後才重開得了
      if (opts.blob && opts.filename) {
        const fd = new FormData();
        fd.append('file', opts.blob, opts.filename);
        await fetch(`${API_BASE_URL}/api/outputs/${o.id}/file`, { method: 'POST', body: fd }).catch(() => {});
      }
      return { materialId, outputId: o.id };
    } catch {
      return null;   // 留紀錄失敗不影響畫面
    }
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

/* ── 側欄「最近活動」：真實紀錄、依日期分組、點了重開 ──
 * 原本每頁側欄是寫死的三筆假資料。這裡在頁面載入後把它換成資料庫裡的紀錄；
 * 只動 section-title 是「最近活動」的那個區塊，簡報大綱／影片章節那些不碰。 */
const EduAIHistory = {
  PAGE: { text: 'text-page.html', presentation: 'presentation.html', video: 'video-page.html', quiz: 'quiz.html', chat: 'chat.html' },
  ICON: { text: 'description', presentation: 'slideshow', video: 'video_library', quiz: 'quiz', chat: 'chat' },

  _dayLabel(iso) {
    const d = new Date(iso), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff < 7) return `${diff} 天前`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  },

  _link(it) {
    if (it.kind === 'quiz') return `${this.PAGE.quiz}?quiz=${it.quizId}`;
    if (it.kind === 'chat') return `${this.PAGE.chat}?session=${it.sessionId}`;
    return `${this.PAGE[it.kind] || 'index.html'}?output=${it.outputId}`;
  },

  async render() {
    const section = [...document.querySelectorAll('.history-section')]
      .find(s => (s.querySelector('.section-title') || {}).textContent.trim() === '最近活動');
    const list = section && section.querySelector('.history-list');
    if (!list) return;
    if (!document.getElementById('eduai-history-css')) {
      const st = document.createElement('style');
      st.id = 'eduai-history-css';
      st.textContent = '.history-day{font-size:.72rem;letter-spacing:1px;opacity:.5;margin:12px 0 4px 8px}' +
        '.history-item .h-ico{font-size:16px;vertical-align:-3px;margin-right:6px;opacity:.7}' +
        '.history-item.h-empty{opacity:.6;cursor:default}';
      document.head.appendChild(st);
    }
    let user = null;
    try { user = JSON.parse(localStorage.getItem('iecs_user') || 'null'); } catch {}
    list.textContent = '';
    const empty = (msg) => { const li = document.createElement('li'); li.className = 'history-item h-empty'; li.textContent = msg; list.appendChild(li); };
    if (!user) { empty('登入後這裡會列出你生成過的教材'); return; }
    let items = [];
    try {
      const r = await fetch(`${API_BASE_URL}/api/history?userId=${user.id}`);
      if (r.ok) items = await r.json();
    } catch { empty('無法載入紀錄（後端未啟動）'); return; }
    if (!items.length) { empty('尚無紀錄，生成第一份教材吧'); return; }
    let lastDay = '';
    items.slice(0, 30).forEach(it => {
      const day = this._dayLabel(it.createdAt);
      if (day !== lastDay) {
        const h = document.createElement('div'); h.className = 'history-day'; h.textContent = day; list.appendChild(h); lastDay = day;
      }
      const li = document.createElement('li');
      li.className = 'history-item';
      li.dataset.page = this._link(it);
      const ico = document.createElement('span');
      ico.className = 'material-symbols-outlined h-ico';
      ico.textContent = this.ICON[it.kind] || 'description';
      li.appendChild(ico);
      li.appendChild(document.createTextNode(it.title));
      li.title = new Date(it.createdAt).toLocaleString('zh-TW');
      li.addEventListener('click', () => { location.href = li.dataset.page; });
      list.appendChild(li);
    });
  },
};
document.addEventListener('DOMContentLoaded', () => EduAIHistory.render());

/* ── 背景工作區：右下角的按鈕，看目前在生成什麼、進度、排隊 ──
 * AI 引擎一次只做一份，多人使用時常常要等。原本看不到前面有幾份、也不知道自己那份跑到哪，
 * 切到別頁更是完全沒消息。資料來自網站伺服器的 /api/ai-jobs（引擎再忙也問得到）。 */
const EduAIWorkspace = {
  PAGE: { '/make_html_slide': 'presentation.html', '/make_teaching_video': 'video-page.html' },
  ICON: { '簡報': 'slideshow', '簡報（YouTube）': 'slideshow', '修改簡報': 'edit_note',
          '影片': 'video_library', '測驗': 'quiz', '匯出 PPTX': 'download' },
  _open: false,
  _timer: null,

  init() {
    if (document.getElementById('eduai-ws')) return;
    const st = document.createElement('style');
    st.textContent = `
#eduai-ws{position:fixed;right:20px;bottom:20px;z-index:900;font-family:inherit}
#eduai-ws .ws-btn{display:flex;align-items:center;gap:6px;border:0;cursor:pointer;
  background:var(--bg-primary,#2C3E50);color:#fff;border-radius:22px;padding:9px 16px;
  font-size:.88rem;box-shadow:0 6px 18px rgba(0,0,0,.18)}
#eduai-ws .ws-btn .material-symbols-outlined{font-size:19px}
#eduai-ws .ws-badge{background:var(--accent-color,#D4AF37);color:#2C3E50;border-radius:10px;
  padding:0 7px;font-weight:700;font-size:.78rem;line-height:18px}
#eduai-ws .ws-badge[hidden]{display:none}
#eduai-ws .ws-panel{display:none;position:absolute;right:0;bottom:50px;width:340px;max-width:calc(100vw - 40px);
  max-height:min(460px,70vh);overflow:auto;background:var(--bg-card,#fff);color:var(--text-primary,#2C3E50);
  border:1px solid var(--divider-color,#E0DDD5);border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.18);padding:14px}
#eduai-ws.open .ws-panel{display:block}
#eduai-ws h4{margin:0 0 10px;font-size:.95rem;display:flex;justify-content:space-between;align-items:center}
#eduai-ws h4 small{font-weight:400;color:var(--text-muted,#9BA3AF);font-size:.75rem}
#eduai-ws .ws-engine{font-size:.8rem;color:var(--text-secondary,#606F7B);margin-bottom:10px}
#eduai-ws .ws-item{border-top:1px solid var(--divider-color,#E0DDD5);padding:10px 0}
#eduai-ws .ws-row{display:flex;align-items:center;gap:8px;font-size:.86rem}
#eduai-ws .ws-row .material-symbols-outlined{font-size:18px;opacity:.75}
#eduai-ws .ws-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#eduai-ws .ws-other .ws-title{color:var(--text-muted,#9BA3AF)}
#eduai-ws .ws-state{font-size:.76rem;color:var(--text-secondary,#606F7B);margin:4px 0 0 26px}
#eduai-ws .ws-bar{height:5px;border-radius:3px;background:var(--bg-card-hover,#EAE7E0);margin:6px 0 0 26px;overflow:hidden}
#eduai-ws .ws-bar>span{display:block;height:100%;background:var(--accent-color,#D4AF37);transition:width .6s}
#eduai-ws .ws-open{font-size:.78rem;color:#fff;background:var(--bg-primary,#2C3E50);border-radius:6px;
  padding:3px 9px;text-decoration:none;white-space:nowrap}
#eduai-ws .ws-stop{font-size:.78rem;color:#9b2c2c;background:#fbeaea;border:0;border-radius:6px;
  padding:3px 9px;cursor:pointer;white-space:nowrap}
#eduai-ws .ws-stop:disabled{opacity:.5;cursor:default}
#eduai-ws .ws-empty{font-size:.84rem;color:var(--text-muted,#9BA3AF);padding:6px 0}`;
    document.head.appendChild(st);

    const root = document.createElement('div');
    root.id = 'eduai-ws';
    root.innerHTML =
      '<div class="ws-panel" role="dialog" aria-label="背景工作區">' +
        '<h4>背景工作區 <small>每 5 秒更新</small></h4>' +
        '<div class="ws-engine"></div><div class="ws-list"></div>' +
      '</div>' +
      '<button class="ws-btn" type="button" title="看目前的生成工作與進度">' +
        '<span class="material-symbols-outlined">pending_actions</span>背景工作' +
        '<span class="ws-badge" hidden></span></button>';
    document.body.appendChild(root);
    root.querySelector('.ws-btn').addEventListener('click', () => {
      this._open = !this._open;
      root.classList.toggle('open', this._open);
      this.refresh();
    });
    this.refresh();
  },

  _fmt(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  },

  async refresh() {
    clearTimeout(this._timer);
    // 面板開著時勤快一點；關著只需要更新按鈕上的數字
    this._timer = setTimeout(() => this.refresh(), this._open ? 5000 : 15000);
    const root = document.getElementById('eduai-ws');
    if (!root) return;
    const u = EduAIStore._user();
    let data;
    try {
      const r = await fetch(`${API_BASE_URL}/api/ai-jobs?userId=${u ? u.id : ''}`,
        { signal: AbortSignal.timeout(8000) });
      data = await r.json();
    } catch {
      root.querySelector('.ws-engine').textContent = '無法取得工作狀態（網站伺服器沒有回應）。';
      return;
    }
    const jobs = data.jobs || [];
    const running = jobs.filter(j => j.status === 'running' || j.status === 'queued');
    const badge = root.querySelector('.ws-badge');
    badge.hidden = !running.length;
    badge.textContent = running.length;
    if (!this._open) return;

    const p = data.progress || {};
    root.querySelector('.ws-engine').textContent = p.busy
      ? `AI 引擎：${p.stage}（${p.pct}%，已經過 ${this._fmt((p.elapsed || 0) * 1000)}）`
      : (running.length ? 'AI 引擎：準備中…' : 'AI 引擎：空閒，可以直接生成。');

    const list = root.querySelector('.ws-list');
    list.textContent = '';
    // 自己的全部列出；別人的只列還在跑的（讓你知道前面有幾份）
    const shown = jobs.filter(j => j.mine || j.status === 'running' || j.status === 'queued').reverse();
    if (!shown.length) {
      const d = document.createElement('div');
      d.className = 'ws-empty';
      d.textContent = u ? '目前沒有工作。生成的簡報、影片、測驗會出現在這裡。' : '登入後可以看到自己的生成工作。';
      list.appendChild(d);
      return;
    }
    const now = Date.now();
    for (const j of shown) {
      const item = document.createElement('div');
      item.className = 'ws-item' + (j.mine ? '' : ' ws-other');
      const row = document.createElement('div');
      row.className = 'ws-row';
      const ico = document.createElement('span');
      ico.className = 'material-symbols-outlined';
      ico.textContent = this.ICON[j.kind] || 'auto_awesome';
      const title = document.createElement('span');
      title.className = 'ws-title';
      title.textContent = j.mine ? `${j.kind}：${j.topic || '（未命名）'}` : `其他使用者的${j.kind}`;
      row.append(ico, title);

      let state = '', pct = null;
      if (j.cancelRequested && j.status === 'running') {
        state = '正在停止…（模型停下來需要幾秒）';
      } else if (j.status === 'running') {
        pct = p.busy ? p.pct : 2;
        state = `正在生成${p.busy ? `・${p.stage}` : ''}・已經過 ${this._fmt(now - (j.startedAt || now))}`;
      } else if (j.status === 'queued') {
        pct = 0;
        state = `排隊中，前面還有 ${j.position} 份・已等 ${this._fmt(now - j.createdAt)}`;
      } else if (j.status === 'cancelled') {
        state = '已停止';
      } else if (j.status === 'done') {
        state = j.fetched ? `已完成${j.path in this.PAGE || j.kind === '測驗' ? '，已存到左側「最近活動」' : ''}` : '已完成，還沒打開';
        const page = this.PAGE[j.path];
        if (j.mine && !j.fetched && page && j.id) {
          const a = document.createElement('a');
          a.className = 'ws-open';
          a.href = `${page}?job=${encodeURIComponent(j.id)}`;
          a.textContent = '開啟';
          row.appendChild(a);
        }
      } else {
        state = '生成失敗';
      }
      if (j.mine && j.id && !j.cancelRequested && (j.status === 'running' || j.status === 'queued')) {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'ws-stop';
        stop.textContent = j.status === 'queued' ? '取消' : '停止';
        stop.addEventListener('click', async () => {
          const what = `${j.kind}「${j.topic || '未命名'}」`;
          if (!confirm(j.status === 'queued' ? `取消排隊中的${what}？` : `停止正在生成的${what}？已經生成的部分不會保留。`)) return;
          stop.disabled = true;
          try { await EduAI.cancelJob(j.id); } catch (e) { alert('停止失敗：' + e.message); }
          this.refresh();
        });
        row.appendChild(stop);
      }
      item.appendChild(row);
      const stEl = document.createElement('div');
      stEl.className = 'ws-state';
      stEl.textContent = state;
      item.appendChild(stEl);
      if (pct !== null) {
        const bar = document.createElement('div');
        bar.className = 'ws-bar';
        const fill = document.createElement('span');
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        item.appendChild(bar);
      }
      list.appendChild(item);
    }
  },
};
document.addEventListener('DOMContentLoaded', () => EduAIWorkspace.init());

/** 後端沒開時顯示明確提示，而不是讓使用者對著轉圈圈猜。 */
function eduaiOfflineMessage() {
  if (EduAI._lastProbe === 'busy') {
    return `AI 引擎正在忙。` + String.fromCharCode(10, 10) +
           `它一次只能處理一個請求，目前可能正在生成簡報或影片。` + String.fromCharCode(10) +
           `請等前一個任務完成後再試一次。`;
  }
  return `無法連線到 EduAI。` + String.fromCharCode(10, 10) +
         `請先啟動 AI 後端：` + String.fromCharCode(10) +
         `1. 開啟終端機，進到 ai-engine/api 資料夾` + String.fromCharCode(10) +
         `2. 執行：python -m uvicorn app:app --host 127.0.0.1 --port 8000`;
}
