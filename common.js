// 後端位址：由 Express 自己提供網頁時（部署後、或本機直接連 3306）與 API 同源，
// 用相對路徑才不會寫死網域；用 dev-server.py（3000）或直接開檔案時，後端在 3306。
const API_BASE_URL = (location.protocol === 'file:' || location.port === '3000')
    ? 'http://localhost:3306'
    : '';
const AUTH_STORAGE_KEY = 'iecs_logged_in';
const USER_STORAGE_KEY = 'iecs_user';

function isLoggedIn() {
    return localStorage.getItem(AUTH_STORAGE_KEY) === 'true';
}

function setLoggedIn(value, user) {
    localStorage.setItem(AUTH_STORAGE_KEY, value ? 'true' : 'false');
    if (value && user) {
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    } else {
        localStorage.removeItem(USER_STORAGE_KEY);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    enforceAuthGuard();
    initSidebarToggle();
    initHistoryList();
    initAccountToggle();
    initSettingsButton();
    initLoginForm();
    initRegisterForm();
    initForgotPasswordForm();
    initQuizTextarea();
    initAvatarUpload();
    initProfileSave();
    loadCurrentUser();
});

// 只有帳戶與設定頁（個人資料、密碼）需要真的登入；其他頁面訪客也能瀏覽。
function enforceAuthGuard() {
    const isProtectedPage = document.getElementById('profile-account') !== null;
    if (isProtectedPage && !isLoggedIn()) {
        window.location.href = 'login.html';
    }
}

// 側邊欄名字/大頭貼跟帳戶設定表單都吃同一份使用者資料。
// 沒登入時顯示訪客狀態；有登入則先用 localStorage 的快取立刻畫出來，
// 再打 API 拿最新資料覆蓋一次（這樣即使快取是舊版本欄位、或大頭貼剛換過，畫面都會自動補上最新的）。
async function loadCurrentUser() {
    if (!isLoggedIn()) {
        renderGuestUser();
        return;
    }

    const cachedJson = localStorage.getItem(USER_STORAGE_KEY);
    if (!cachedJson) {
        renderGuestUser();
        return;
    }
    const cached = JSON.parse(cachedJson);

    renderCurrentUser(cached);

    try {
        const response = await fetch(`${API_BASE_URL}/api/users/${cached.id}`);
        if (!response.ok) return;
        const fresh = await response.json();
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(fresh));
        renderCurrentUser(fresh);
    } catch (err) {
        // 後端還沒啟動時，畫面就先用本地快取顯示，不擋住使用
    }
}

function renderGuestUser() {
    document.querySelectorAll('.user-profile .user-name').forEach(el => {
        el.textContent = '訪客';
    });
    document.querySelectorAll('.user-profile .user-status').forEach(el => {
        el.innerHTML = '<span class="status-dot status-dot--guest"></span> 訪客瀏覽中';
    });
    document.querySelectorAll('.user-profile .avatar').forEach(el => {
        el.style.backgroundImage = 'none';
        el.textContent = '?';
    });
}

function renderCurrentUser(user) {
    const displayName = user.nickname || user.realName || user.account;

    document.querySelectorAll('.user-profile .user-name').forEach(el => {
        el.textContent = displayName;
    });
    document.querySelectorAll('.user-profile .user-status').forEach(el => {
        el.innerHTML = '<span class="status-dot"></span> 已登入';
    });
    document.querySelectorAll('.user-profile .avatar').forEach(el => {
        applyAvatar(el, user, displayName);
    });

    const accountField = document.getElementById('profile-account');
    if (accountField) {
        document.getElementById('profile-role').value = user.role || 'student';
        document.getElementById('profile-school').value = user.schoolName || '';
        document.getElementById('profile-name').value = user.realName || '';
        document.getElementById('profile-nickname').value = user.nickname || '';
        accountField.value = user.account || '';
        applyAvatar(document.getElementById('profile-avatar'), user, displayName);
    }
}

function applyAvatar(el, user, displayName) {
    if (user.avatarUrl) {
        el.style.backgroundImage = `url(${API_BASE_URL}${user.avatarUrl})`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.textContent = '';
    } else {
        el.style.backgroundImage = 'none';
        el.textContent = displayName.charAt(0);
    }
}

function initAvatarUpload() {
    const btn = document.querySelector('.avatar-upload-btn');
    const fileInput = document.getElementById('avatar-file-input');
    if (!btn || !fileInput) return;

    btn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;

        if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
            alert('只支援 JPG 或 PNG 格式。');
            fileInput.value = '';
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            alert('檔案大小不能超過 2MB。');
            fileInput.value = '';
            return;
        }

        const userJson = localStorage.getItem(USER_STORAGE_KEY);
        if (!userJson) return;
        const user = JSON.parse(userJson);

        const formData = new FormData();
        formData.append('avatar', file);

        try {
            const response = await fetch(`${API_BASE_URL}/api/users/${user.id}/avatar`, {
                method: 'POST',
                body: formData,
            });
            const data = await response.json();

            if (!response.ok) {
                alert(data.error || '上傳失敗，請再試一次。');
                return;
            }

            localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data));
            renderCurrentUser(data);
        } catch (err) {
            alert('無法連線到伺服器，請確認後端 API（npm run dev）是否已啟動。');
        } finally {
            fileInput.value = '';
        }
    });
}

function initProfileSave() {
    const btn = document.getElementById('profile-save-btn');
    if (!btn) return;

    const messageEl = document.getElementById('profile-message');
    const passwordField = document.getElementById('profile-password');

    btn.addEventListener('click', async () => {
        const userJson = localStorage.getItem(USER_STORAGE_KEY);
        if (!userJson) return;
        const currentUser = JSON.parse(userJson);

        messageEl.classList.remove('is-visible', 'is-success');

        const payload = {
            account: document.getElementById('profile-account').value.trim(),
            role: document.getElementById('profile-role').value,
            realName: document.getElementById('profile-name').value.trim(),
            nickname: document.getElementById('profile-nickname').value.trim(),
            schoolName: document.getElementById('profile-school').value.trim(),
        };
        if (passwordField.value) {
            payload.password = passwordField.value;
        }

        btn.disabled = true;
        try {
            const response = await fetch(`${API_BASE_URL}/api/users/${currentUser.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();

            if (!response.ok) {
                messageEl.textContent = data.error || '儲存失敗，請再試一次。';
                messageEl.classList.add('is-visible');
                return;
            }

            localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data));
            renderCurrentUser(data);
            passwordField.value = '';
            messageEl.textContent = '設定已儲存。';
            messageEl.classList.add('is-visible', 'is-success');
        } catch (err) {
            messageEl.textContent = '無法連線到伺服器，請確認後端 API（npm run dev）是否已啟動。';
            messageEl.classList.add('is-visible');
        } finally {
            btn.disabled = false;
        }
    });
}

function initSidebarToggle() {
    const btn = document.getElementById('sidebar-toggle-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        document.querySelector('.secondary-sidebar').classList.toggle('collapsed');
    });
}

function initHistoryList() {
    document.querySelectorAll('.history-item').forEach(item => {
        item.addEventListener('click', function () {
            document.querySelectorAll('.history-item').forEach(i => i.classList.remove('active'));
            this.classList.add('active');
        });
    });
}

function initAccountToggle() {
    const btn = document.querySelector('.nav-bottom-group .icon-btn');
    if (!btn) return;
    const icon = btn.querySelector('.material-symbols-outlined');

    function render() {
        if (isLoggedIn()) {
            icon.textContent = 'logout';
            btn.title = '登出';
        } else {
            icon.textContent = 'account_circle';
            btn.title = '登入';
        }
    }
    render();

    btn.addEventListener('click', () => {
        if (isLoggedIn()) {
            if (confirm('確定要登出嗎？')) {
                setLoggedIn(false);
                window.location.href = 'index.html';
            }
        } else {
            window.location.href = 'login.html';
        }
    });
}

function initSettingsButton() {
    document.querySelectorAll('.settings-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            window.location.href = 'profile.html';
        });
    });
}

function generateCaptcha() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function initLoginForm() {
    const form = document.getElementById('login-form');
    if (!form) return;

    const captchaImage = document.getElementById('captcha-image');
    const captchaInput = document.getElementById('captcha');
    const errorEl = document.getElementById('login-error');
    let currentCaptcha = generateCaptcha();
    captchaImage.textContent = currentCaptcha;

    captchaImage.addEventListener('click', () => {
        currentCaptcha = generateCaptcha();
        captchaImage.textContent = currentCaptcha;
        captchaInput.value = '';
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorEl.classList.remove('is-visible');

        if (captchaInput.value.trim().toUpperCase() !== currentCaptcha.toUpperCase()) {
            errorEl.textContent = '驗證碼錯誤，請重新輸入。';
            errorEl.classList.add('is-visible');
            currentCaptcha = generateCaptcha();
            captchaImage.textContent = currentCaptcha;
            captchaInput.value = '';
            return;
        }

        const account = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        try {
            const response = await fetch(`${API_BASE_URL}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account, password }),
            });
            const data = await response.json();

            if (!response.ok) {
                errorEl.textContent = data.error || '登入失敗，請再試一次。';
                errorEl.classList.add('is-visible');
                return;
            }

            setLoggedIn(true, data);
            window.location.href = 'index.html';
        } catch (err) {
            errorEl.textContent = '無法連線到伺服器，請確認後端 API（npm run dev）是否已啟動。';
            errorEl.classList.add('is-visible');
        } finally {
            submitBtn.disabled = false;
        }
    });
}

function initRegisterForm() {
    const form = document.getElementById('register-form');
    if (!form) return;

    const messageEl = document.getElementById('register-message');

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        messageEl.classList.remove('is-visible', 'is-success');

        const account = document.getElementById('reg-account').value.trim();
        const password = document.getElementById('reg-password').value;
        const passwordConfirm = document.getElementById('reg-password-confirm').value;
        const role = document.getElementById('reg-role').value;
        const schoolName = document.getElementById('reg-school').value.trim();
        const realName = document.getElementById('reg-name').value.trim();
        const nickname = document.getElementById('reg-nickname').value.trim();

        if (password !== passwordConfirm) {
            messageEl.textContent = '兩次輸入的密碼不一致。';
            messageEl.classList.add('is-visible');
            return;
        }

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        try {
            const response = await fetch(`${API_BASE_URL}/api/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account, password, role, realName, nickname, schoolName }),
            });
            const data = await response.json();

            if (!response.ok) {
                messageEl.textContent = data.error || '註冊失敗，請再試一次。';
                messageEl.classList.add('is-visible');
                return;
            }

            messageEl.textContent = '註冊成功，即將帶你前往登入頁面...';
            messageEl.classList.add('is-visible', 'is-success');
            setTimeout(() => {
                window.location.href = 'login.html';
            }, 1200);
        } catch (err) {
            messageEl.textContent = '無法連線到伺服器，請確認後端 API（npm run dev）是否已啟動。';
            messageEl.classList.add('is-visible');
        } finally {
            submitBtn.disabled = false;
        }
    });
}

function initForgotPasswordForm() {
    const form = document.getElementById('forgot-password-form');
    if (!form) return;

    const messageEl = document.getElementById('forgot-password-message');

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        messageEl.classList.remove('is-visible', 'is-success');

        const account = document.getElementById('fp-account').value.trim();
        const newPassword = document.getElementById('fp-new-password').value;
        const newPasswordConfirm = document.getElementById('fp-new-password-confirm').value;

        if (newPassword !== newPasswordConfirm) {
            messageEl.textContent = '兩次輸入的密碼不一致。';
            messageEl.classList.add('is-visible');
            return;
        }

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        try {
            const response = await fetch(`${API_BASE_URL}/api/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account, newPassword }),
            });
            const data = await response.json();

            if (!response.ok) {
                messageEl.textContent = data.error || '重設失敗，請再試一次。';
                messageEl.classList.add('is-visible');
                return;
            }

            messageEl.textContent = '密碼已重設，即將帶你前往登入頁面...';
            messageEl.classList.add('is-visible', 'is-success');
            setTimeout(() => {
                window.location.href = 'login.html';
            }, 1200);
        } catch (err) {
            messageEl.textContent = '無法連線到伺服器，請確認後端 API（npm run dev）是否已啟動。';
            messageEl.classList.add('is-visible');
        } finally {
            submitBtn.disabled = false;
        }
    });
}

function initQuizTextarea() {
    const textarea = document.getElementById('quiz-textarea');
    if (!textarea) return;
    textarea.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = this.scrollHeight + 'px';
    });
}
