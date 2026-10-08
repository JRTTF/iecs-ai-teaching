// 引導問答流程

let guideData = { topic: '', level: '', formats: [] };

function selectMode(mode) {
    document.getElementById('block-mode-select').classList.add('js-hidden');
    if (mode === 'upload') {
        document.getElementById('block-input').classList.remove('js-hidden');
        const uf = document.getElementById('upload-formats');
        if (uf) uf.hidden = false;
    } else {
        document.getElementById('block-guide').classList.remove('js-hidden');
        goToStep(1);
    }
}

function goToModeSelect() {
    document.getElementById('block-mode-select').classList.remove('js-hidden');
    document.getElementById('block-guide').classList.add('js-hidden');
    document.getElementById('block-input').classList.add('js-hidden');
    guideData = { topic: '', level: '', formats: [] };
}

function goToStep(step) {
    if (step === 2) {
        const topic = document.getElementById('input-topic').value.trim();
        if (!topic) {
            const el = document.getElementById('input-topic');
            el.focus();
            el.classList.add('input-error');
            setTimeout(() => el.classList.remove('input-error'), 800);
            return;
        }
        guideData.topic = topic;
    }
    if (step === 3 && !guideData.level) {
        document.querySelectorAll('.level-card').forEach(c => {
            c.classList.add('shake');
            setTimeout(() => c.classList.remove('shake'), 500);
        });
        return;
    }
    [1, 2, 3].forEach(i => {
        document.getElementById(`guide-step-${i}`).classList.toggle('js-hidden', i !== step);
        const dot = document.getElementById(`step-dot-${i}`);
        dot.classList.toggle('active', i === step);
        dot.classList.toggle('completed', i < step);
    });
}

function fillSuggestion(text) {
    document.getElementById('input-topic').value = text;
}

function selectLevel(el, level) {
    document.querySelectorAll('.level-card').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
    guideData.level = level;
}

function toggleFormat(el, format) {
    el.classList.toggle('selected');
    if (el.classList.contains('selected')) {
        if (!guideData.formats.includes(format)) guideData.formats.push(format);
    } else {
        guideData.formats = guideData.formats.filter(f => f !== format);
    }
}

function finishGuide() {
    if (guideData.formats.length === 0) {
        document.querySelectorAll('.format-card').forEach(c => {
            c.classList.add('shake');
            setTimeout(() => c.classList.remove('shake'), 500);
        });
        return;
    }
    const prompt = `我想學習「${guideData.topic}」，我的程度是${guideData.level}，希望生成：${guideData.formats.join('、')}。`;
    document.getElementById('block-guide').classList.add('js-hidden');
    document.getElementById('block-input').classList.remove('js-hidden');
    const ta = document.getElementById('main-textarea');
    ta.value = prompt;
    ta.focus();
    const uf = document.getElementById('upload-formats');
    if (uf) uf.hidden = true;
}

// ── 上傳講義：PPTX／PDF／純文字 → 當作教材內容生成 ──
// PPTX 在瀏覽器裡直接拆開讀（它其實是 zip 檔），不佔用 AI 引擎；PDF 請引擎抽文字。
let uploadedMaterial = null;   // { name, title, text, pages }

async function readZipEntries(buf) {
    const dv = new DataView(buf);
    // 從檔尾找「中央目錄結尾」記錄
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('這不是有效的 PPTX 檔');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const entries = {};
    for (let k = 0; k < count; k++) {
        if (dv.getUint32(p, true) !== 0x02014b50) break;
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
        const local = dv.getUint32(p + 42, true);
        const name = dec.decode(new Uint8Array(buf, p + 46, nlen));
        entries[name] = { method, csize, local };
        p += 46 + nlen + elen + clen;
    }
    return {
        names: Object.keys(entries),
        async blob(name) {
            const e = entries[name];
            if (!e) return null;
            const off = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
            const data = new Uint8Array(buf, off, e.csize);
            if (e.method === 0) return new Blob([data]);
            return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
        },
        async text(name) {
            const e = entries[name];
            if (!e) return '';
            const off = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
            const data = new Uint8Array(buf, off, e.csize);
            if (e.method === 0) return dec.decode(data);
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            return new Response(stream).text();
        },
    };
}

async function extractPptx(file) {
    const zip = await readZipEntries(await file.arrayBuffer());
    const slideNo = (n) => Number((n.match(/slide(\d+)\.xml$/) || [])[1]);
    const slides = zip.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => slideNo(a) - slideNo(b));
    if (!slides.length) throw new Error('這份 PPTX 裡沒有投影片');
    const parser = new DOMParser();
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const out = [];
    const mediaUse = {};   // 圖檔 → 用到它的投影片 [{page, text}]
    let title = '';
    for (let i = 0; i < slides.length; i++) {
        const doc = parser.parseFromString(await zip.text(slides[i]), 'application/xml');
        const lines = [...doc.getElementsByTagNameNS(A, 'p')]
            .map(pa => [...pa.getElementsByTagNameNS(A, 't')].map(t => t.textContent).join('').trim())
            .filter(Boolean);
        // 這頁引用了哪些圖（寫在 _rels/slideN.xml.rels）
        const rels = await zip.text(slides[i].replace('slides/', 'slides/_rels/') + '.rels');
        for (const m of rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)) {
            (mediaUse[m[1]] = mediaUse[m[1]] || []).push({ page: i + 1, text: lines.join(' ') });
        }
        if (!lines.length) continue;
        if (!title) title = lines[0];
        out.push(`【第 ${i + 1} 頁】${lines[0]}\n` + lines.slice(1).map(l => '・' + l).join('\n'));
    }
    if (!out.length) throw new Error('投影片裡讀不到文字（可能都是圖片）');
    const images = await pickPptxImages(zip, mediaUse);
    return { title, text: out.join('\n\n'), pages: slides.length, images };
}

// 從 PPTX 挑出值得放進簡報的圖：
// - 只要網頁能顯示的格式（png/jpg/gif/webp），EMF 之類的向量圖跳過
// - 出現在 3 頁以上的多半是樣板裝飾或 Logo，跳過
// - 太小的（圖示）跳過；大的縮到 1280px 內、轉 JPEG，傳送和存檔都比較輕
// 每張圖附上它原本那頁的文字，AI 用來判斷該配到哪一頁。最多 12 張，挑面積大的。
async function pickPptxImages(zip, mediaUse) {
    const picked = [];
    for (const [name, uses] of Object.entries(mediaUse)) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(name) || uses.length >= 3) continue;
        const blob = await zip.blob('ppt/media/' + name);
        if (!blob) continue;
        const shrunk = await shrinkImage(blob);
        if (!shrunk) continue;
        picked.push({ blob: shrunk.blob, area: shrunk.area,
                      caption: uses.map(u => u.text).join(' ').slice(0, 300), page: uses[0].page });
    }
    return picked.sort((a, b) => b.area - a.area).slice(0, 12)
        .sort((a, b) => a.page - b.page)
        .map(({ blob, caption }) => ({ blob, caption }));
}

async function shrinkImage(blob, max = 1280) {
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch { return null; }
    if (bmp.width < 300 || bmp.height < 200) return null;
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';            // 透明背景的 PNG 轉 JPEG 時墊白底
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return out ? { blob: out, area: bmp.width * bmp.height } : null;
}

function showUploadChip(html, isError) {
    const chip = document.getElementById('upload-chip');
    if (!chip) return;
    chip.hidden = false;
    chip.classList.toggle('is-error', !!isError);
    chip.innerHTML = html;
    const x = chip.querySelector('button');
    if (x) x.addEventListener('click', () => {
        uploadedMaterial = null;
        EduAIMaterial.clear();
        chip.hidden = true;
    });
}

function setUploadFormat(fmt) {
    guideData.formats = [fmt];
    document.querySelectorAll('#upload-formats button').forEach(b =>
        b.classList.toggle('selected', b.dataset.format === fmt));
}

function initUpload() {
    const btn = document.querySelector('.upload-btn');
    if (!btn) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pptx,.pdf,.txt,.md,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf,text/plain';
    input.hidden = true;
    document.body.appendChild(input);
    btn.addEventListener('click', () => input.click());

    document.querySelectorAll('#upload-formats button').forEach(b =>
        b.addEventListener('click', () => setUploadFormat(b.dataset.format)));

    input.addEventListener('change', async () => {
        const f = input.files[0];
        input.value = '';
        if (!f) return;
        const name = escapeHtml(f.name);
        showUploadChip(`<span class="material-symbols-outlined">hourglass_top</span><span class="uc-name">正在讀取 ${name}…</span>`);
        try {
            let m;
            const lower = f.name.toLowerCase();
            if (lower.endsWith('.pptx')) {
                m = await extractPptx(f);
            } else if (lower.endsWith('.pdf')) {
                const j = await EduAI.extractPdf(f);
                if (!j.content) throw new Error('PDF 裡讀不到文字（可能是掃描圖片）');
                const images = [];
                for (const im of j.images || []) {
                    try { images.push({ blob: await (await fetch(im.data)).blob(), caption: im.caption || '' }); }
                    catch { /* 單張壞掉就略過 */ }
                }
                m = { title: '', text: j.content, pages: j.pages, images };
            } else if (lower.endsWith('.ppt')) {
                throw new Error('舊版 .ppt 讀不了，請在 PowerPoint 另存成 .pptx 再上傳');
            } else {
                m = { title: '', text: (await f.text()).trim(), pages: 0 };
            }
            uploadedMaterial = { name: f.name, ...m };
            await EduAIMaterial.save(m.images || []);
            const nImg = (m.images || []).length;
            const meta = `${m.pages ? m.pages + ' 頁・' : ''}${m.text.length.toLocaleString()} 字` +
                (nImg ? `・${nImg} 張圖` : '');
            showUploadChip(`<span class="material-symbols-outlined">attach_file</span>` +
                `<span class="uc-name" title="${name}">${name}</span><span class="uc-meta">${meta}</span>` +
                `<button type="button" title="移除">✕</button>`);
            // 上傳的是 PPT 又還沒選格式 → 預設生成簡報
            if (!guideData.formats.length) setUploadFormat(lower.endsWith('.pptx') ? '智慧簡報' : '文字講義');
            const ta = document.getElementById('main-textarea');
            if (ta && !ta.value.trim()) ta.placeholder = '可以補充想怎麼生成（例如：整理成 10 頁、加上例題），不填也可以直接生成';
        } catch (e) {
            uploadedMaterial = null;
            EduAIMaterial.clear();
            showUploadChip(`<span class="material-symbols-outlined">error</span><span class="uc-name">${escapeHtml(e.message)}</span>` +
                `<button type="button" title="關閉">✕</button>`, true);
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initUpload();
    document.querySelectorAll('.mode-card').forEach(card => {
        card.addEventListener('click', () => selectMode(card.dataset.mode));
    });

    document.querySelectorAll('[data-back="mode-select"]').forEach(btn => {
        btn.addEventListener('click', goToModeSelect);
    });

    document.querySelectorAll('.guide-back-btn[data-back-step]').forEach(btn => {
        btn.addEventListener('click', () => goToStep(Number(btn.dataset.backStep)));
    });

    document.querySelectorAll('.guide-next-btn[data-next-step]').forEach(btn => {
        btn.addEventListener('click', () => goToStep(Number(btn.dataset.nextStep)));
    });

    const finishBtn = document.querySelector('.guide-finish-btn');
    if (finishBtn) finishBtn.addEventListener('click', finishGuide);

    document.querySelectorAll('.suggestion-chip').forEach(chip => {
        chip.addEventListener('click', () => fillSuggestion(chip.dataset.topic));
    });

    document.querySelectorAll('.level-card').forEach(card => {
        card.addEventListener('click', () => selectLevel(card, card.dataset.level));
    });

    document.querySelectorAll('.format-card').forEach(card => {
        card.addEventListener('click', () => toggleFormat(card, card.dataset.format));
    });

    // ── 快速工具：原本只是普通連結，跳過去沒有主題會卡在「尚未選定主題」──
    //    已選過主題 → 直接跳頁（該頁會用同一主題自動生成）
    //    還沒選主題 → 開引導流程並先勾好對應格式，填完主題按生成就會跳到那一頁
    const QUICK_FORMAT = {
        'text-page.html': '文字講義',
        'presentation.html': '智慧簡報',
        'video-page.html': '影音教材',
    };
    function openGuideFor(fmt) {
        selectMode('guide');
        guideData.formats = [fmt];
        document.querySelectorAll('.format-card').forEach(c => {
            c.classList.toggle('selected', c.dataset.format === fmt);
        });
        const guide = document.getElementById('block-guide');
        if (guide) guide.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const input = document.getElementById('input-topic');
        if (input) input.focus();
    }
    document.querySelectorAll('.feature-card[href]').forEach(a => {
        const fmt = QUICK_FORMAT[a.getAttribute('href')];
        if (!fmt) return;
        a.addEventListener('click', (e) => {
            const saved = EduAIGuide.load();
            if (saved && saved.topic) {          // 有主題就照原連結跳頁，並用這個主題生成
                EduAIGuide.requestStart(a.getAttribute('href'));
                return;
            }
            e.preventDefault();
            openGuideFor(fmt);
        });
    });
    // 其他頁面可用 index.html?tool=video|slides|text 直接打開對應的引導流程
    const toolParam = new URLSearchParams(location.search).get('tool');
    const toolMap = { video: '影音教材', slides: '智慧簡報', text: '文字講義' };
    if (toolParam && toolMap[toolParam]) openGuideFor(toolMap[toolParam]);
    const generateBtn = document.querySelector('.generate-main-btn');
    const textArea = document.querySelector('.prompt-box textarea');
    if (generateBtn && textArea) {
        generateBtn.addEventListener('click', async () => {
            const typed = textArea.value.trim();
            if (!typed && !uploadedMaterial) {
                alert('請先輸入學習內容或主題，或上傳講義喔！');
                return;
            }
            // 有上傳講義：主題用輸入的文字，沒輸入就用投影片標題或檔名；內容交給 AI 當教材
            const fileTopic = uploadedMaterial
                ? (uploadedMaterial.title || uploadedMaterial.name.replace(/\.[^.]+$/, '')).slice(0, 40)
                : '';
            // 把主題帶到功能頁，讓該頁自動生成（原本只跳頁、沒帶資料）
            EduAIGuide.save({
                topic: guideData.topic || (typed && typed.length <= 60 ? typed : '') || fileTopic || typed.slice(0, 40),
                level: guideData.level,
                formats: guideData.formats,
                content: uploadedMaterial
                    ? (typed && typed !== guideData.topic ? `【使用者需求】${typed}\n\n` : '') + uploadedMaterial.text
                    : '',
            });
            // 講義圖片跟著這次的主題；沒上傳講義就清掉，免得帶到別的主題
            const savedTopic = EduAIGuide.load().topic;
            if (uploadedMaterial) await EduAIMaterial.setTopic(savedTopic);
            else await EduAIMaterial.clear();
            // 依選擇的輸出格式決定要去哪一頁
            const f = guideData.formats;
            const page = f.includes('智慧簡報') ? 'presentation.html'
                : f.includes('影音教材') ? 'video-page.html' : 'text-page.html';
            EduAIGuide.requestStart(page);
            window.location.href = page;
        });
    }
});
