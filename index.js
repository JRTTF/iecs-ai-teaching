// 引導問答流程

let guideData = { topic: '', level: '', formats: [] };

function selectMode(mode) {
    document.getElementById('block-mode-select').classList.add('js-hidden');
    if (mode === 'upload') {
        document.getElementById('block-input').classList.remove('js-hidden');
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
}

document.addEventListener('DOMContentLoaded', () => {
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
            if (saved && saved.topic) return;   // 有主題就照原連結跳頁
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
        generateBtn.addEventListener('click', () => {
            if (textArea.value.trim() === '') {
                alert('請先輸入學習內容或主題喔！');
                return;
            }
            // 把主題帶到功能頁，讓該頁自動生成（原本只跳頁、沒帶資料）
            EduAIGuide.save({
                topic: guideData.topic || textArea.value.trim(),
                level: guideData.level,
                formats: guideData.formats,
                content: '',
            });
            // 依選擇的輸出格式決定要去哪一頁
            const f = guideData.formats;
            if (f.includes('智慧簡報')) {
                window.location.href = 'presentation.html';
            } else if (f.includes('影音教材')) {
                window.location.href = 'video-page.html';
            } else {
                window.location.href = 'text-page.html';
            }
        });
    }
});
