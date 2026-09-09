# IECS AI 智慧教材生成系統

逢甲大學 IECS 畢業專題。輸入一個主題，AI 生成講義、簡報、教學影片與隨堂測驗。

## 架構

```
瀏覽器
  ├─► 網站（Express，3306）  登入 / 論壇 / 測驗 / 資料庫
  └─► EduAI 引擎（FastAPI，8000）  簡報 / 影片 / 問答 / 出題
                └─► Ollama + Qwen2.5（本機 GPU）
```

網站與 AI 引擎是兩個獨立服務。網站沒有 AI 引擎也能跑（登入、論壇、看歷史紀錄正常），
只是不能生成新教材。前端靠 `eduai.js` 這一層橋接去呼叫 AI，換引擎只要改那支檔案。

---

## 組員快速開始（只要網站，不含 AI）

需要先裝 [Node.js](https://nodejs.org/)（LTS 版即可）。開啟 **cmd**，依序貼上：

```cmd
git clone https://github.com/JRTTF/iecs-ai-teaching.git
cd iecs-ai-teaching
npm install
copy .env.example .env
npx prisma migrate deploy
npx prisma generate
node server.js
```

跑完後開瀏覽器進 **http://localhost:3306** 就是完整網站。

之後每次要開網站，只要：

```cmd
cd iecs-ai-teaching
node server.js
```

> 第一次跑會建立 `prisma/dev.db`，裡面是空的，請先到註冊頁建立帳號。
> 資料庫檔案不會上傳到 GitHub，所以每個人的資料是各自獨立的。

---

## 加上 AI 引擎（要有 NVIDIA 顯卡）

AI 引擎在另一個資料夾（`ai-engine/`，未包含在本 repo）。需要：

1. 安裝 [Ollama](https://ollama.com/) 並下載模型
2. `pip install -r requirements.txt`
3. 啟動：

```cmd
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

網站會自動偵測 8000 埠。沒啟動時頁面會顯示「無法連線到 EduAI」，
正在生成時顯示「AI 引擎正在忙」——引擎一次只處理一個請求。

---

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `server.js` | Express：網頁伺服器 + REST API（使用者、論壇、教材、測驗） |
| `eduai.js` | 橋接層：前端呼叫 AI 引擎的唯一入口 |
| `common.js` | 登入狀態、使用者資料、共用 UI |
| `index.html` / `index.js` | 首頁與引導流程（選主題 → 跳到功能頁自動生成） |
| `presentation.html` | 智慧簡報（可匯出 PPTX，能匯入 Canva） |
| `video-page.html` | 影音合成（含字幕時間軸） |
| `quiz.html` | 隨堂測驗：頁內作答、自動批改、成績存資料庫 |
| `chat.html` | 日常對話（可掛教材） |
| `forum.html` | 知識論壇 |
| `prisma/schema.prisma` | 資料庫結構（12 張表） |

## 注意事項

- `.env`、`prisma/dev.db`、`uploads/`、`node_modules/` **不會**進版控，本來就該留在各自電腦。
- 改到資料庫結構後，請一併 commit `prisma/migrations/` 底下的新檔案，其他人才 migrate 得起來。
- `dev-server.py` 是舊的前端開發用小程式，現在 Express 已經自己提供網頁，平常用不到。
