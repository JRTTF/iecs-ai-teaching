const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
      cb(null, `avatar-${req.params.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('UNSUPPORTED_TYPE'));
    }
  },
});

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

function publicUser(user) {
  return {
    id: user.id,
    account: user.account,
    role: user.role,
    realName: user.realName,
    nickname: user.nickname,
    schoolName: user.schoolName,
    avatarUrl: user.avatarUrl,
  };
}

app.get('/api/health', async (req, res) => {
  const userCount = await prisma.user.count();
  res.json({ status: 'ok', userCount });
});

app.get('/api/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: Number(req.params.id) } });
  if (!user) {
    return res.status(404).json({ error: '找不到這個使用者。' });
  }
  res.json(publicUser(user));
});

app.post('/api/register', async (req, res) => {
  const { account, password, role, realName, nickname, schoolName } = req.body;

  if (!account || !password || !role || !realName || !schoolName) {
    return res.status(400).json({ error: '請填寫所有必填欄位。' });
  }

  const existing = await prisma.user.findUnique({ where: { account } });
  if (existing) {
    return res.status(409).json({ error: '這個帳號已經被註冊過了。' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      account,
      passwordHash,
      role,
      realName,
      nickname: nickname || realName,
      schoolName,
    },
  });

  res.status(201).json(publicUser(user));
});

app.post('/api/login', async (req, res) => {
  const { account, password } = req.body;

  if (!account || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼。' });
  }

  const user = await prisma.user.findUnique({ where: { account } });
  if (!user) {
    return res.status(401).json({ error: '帳號或密碼錯誤。' });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({ error: '帳號或密碼錯誤。' });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  res.json(publicUser(updated));
});

app.put('/api/users/:id', async (req, res) => {
  const userId = Number(req.params.id);
  const { account, role, realName, nickname, schoolName, password } = req.body;

  if (!account || !role || !realName || !schoolName) {
    return res.status(400).json({ error: '請填寫所有必填欄位。' });
  }

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) {
    return res.status(404).json({ error: '找不到這個使用者。' });
  }

  if (account !== existing.account) {
    const accountTaken = await prisma.user.findUnique({ where: { account } });
    if (accountTaken) {
      return res.status(409).json({ error: '這個帳號已經被使用了。' });
    }
  }

  const data = {
    account,
    role,
    realName,
    nickname: nickname || realName,
    schoolName,
  };

  if (password) {
    if (password.length < 6) {
      return res.status(400).json({ error: '密碼至少需要 6 碼。' });
    }
    data.passwordHash = await bcrypt.hash(password, 10);
  }

  const user = await prisma.user.update({ where: { id: userId }, data });
  res.json(publicUser(user));
});

app.post('/api/reset-password', async (req, res) => {
  const { account, newPassword } = req.body;

  if (!account || !newPassword) {
    return res.status(400).json({ error: '請輸入帳號與新密碼。' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '密碼至少需要 6 碼。' });
  }

  const user = await prisma.user.findUnique({ where: { account } });
  if (!user) {
    return res.status(404).json({ error: '找不到這個帳號。' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  res.json({ success: true });
});

app.post('/api/users/:id/avatar', (req, res) => {
  upload.single('avatar')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: '只支援 JPG / PNG 格式，檔案上限 2MB。' });
    }
    if (!req.file) {
      return res.status(400).json({ error: '沒有收到上傳的檔案。' });
    }

    const userId = Number(req.params.id);
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return res.status(404).json({ error: '找不到這個使用者。' });
    }

    if (existing.avatarUrl) {
      const oldPath = path.join(__dirname, existing.avatarUrl);
      fs.unlink(oldPath, () => {});
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: `/uploads/${req.file.filename}` },
    });

    res.json(publicUser(user));
  });
});

// ── 論壇 API ──────────────────────────────────────────
// 資料表（forum_posts / forum_comments / forum_likes）在 schema 已定義好，
// 但先前沒有對應的 API，前端因此只能顯示寫死的假文章。以下補上。
// 沿用本專案既有做法：不使用 session，由前端帶 userId。

function publicPost(post) {
  let tags = [];
  try { tags = JSON.parse(post.tags || '[]'); } catch { tags = []; }
  return {
    id: post.id,
    title: post.title,
    content: post.content,
    tags,
    createdAt: post.createdAt,
    author: post.user ? { id: post.user.id, nickname: post.user.nickname, realName: post.user.realName } : null,
    likeCount: post._count ? post._count.likes : 0,
    commentCount: post._count ? post._count.comments : 0,
  };
}

app.get('/api/posts', async (req, res) => {
  const posts = await prisma.forumPost.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: true, _count: { select: { likes: true, comments: true } } },
  });
  res.json(posts.map(publicPost));
});

app.post('/api/posts', async (req, res) => {
  const { userId, title, content, tags } = req.body;

  if (!userId || !title || !content) {
    return res.status(400).json({ error: '請填寫標題與內容。' });
  }

  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) {
    return res.status(404).json({ error: '找不到這個使用者，請重新登入。' });
  }

  const post = await prisma.forumPost.create({
    data: {
      userId: Number(userId),
      title,
      content,
      tags: JSON.stringify(Array.isArray(tags) ? tags : []),
    },
    include: { user: true, _count: { select: { likes: true, comments: true } } },
  });

  res.status(201).json(publicPost(post));
});

// 按讚採切換式：已按過就取消，避免同一人重複灌讚（schema 對 postId+userId 也有 unique 限制）
app.post('/api/posts/:id/like', async (req, res) => {
  const postId = Number(req.params.id);
  const userId = Number(req.body.userId);

  if (!userId) {
    return res.status(400).json({ error: '請先登入才能按讚。' });
  }

  const post = await prisma.forumPost.findUnique({ where: { id: postId } });
  if (!post) {
    return res.status(404).json({ error: '找不到這篇文章。' });
  }

  const existing = await prisma.forumLike.findUnique({
    where: { postId_userId: { postId, userId } },
  });

  if (existing) {
    await prisma.forumLike.delete({ where: { id: existing.id } });
  } else {
    await prisma.forumLike.create({ data: { postId, userId } });
  }

  const likeCount = await prisma.forumLike.count({ where: { postId } });
  res.json({ liked: !existing, likeCount });
});

app.get('/api/posts/:id/comments', async (req, res) => {
  const comments = await prisma.forumComment.findMany({
    where: { postId: Number(req.params.id) },
    orderBy: { createdAt: 'asc' },
    include: { user: true },
  });
  res.json(comments.map((c) => ({
    id: c.id,
    content: c.content,
    createdAt: c.createdAt,
    author: c.user ? { id: c.user.id, nickname: c.user.nickname } : null,
  })));
});

app.post('/api/posts/:id/comments', async (req, res) => {
  const postId = Number(req.params.id);
  const { userId, content } = req.body;

  if (!userId || !content) {
    return res.status(400).json({ error: '請輸入留言內容。' });
  }

  const post = await prisma.forumPost.findUnique({ where: { id: postId } });
  if (!post) {
    return res.status(404).json({ error: '找不到這篇文章。' });
  }

  const comment = await prisma.forumComment.create({
    data: { postId, userId: Number(userId), content },
    include: { user: true },
  });

  res.status(201).json({
    id: comment.id,
    content: comment.content,
    createdAt: comment.createdAt,
    author: comment.user ? { id: comment.user.id, nickname: comment.user.nickname } : null,
  });
});

// ═══════════════════════════════════════════════════════════
//  教材與生成結果：把 AI 產出的東西寫進資料庫
//
//  這幾張表（materials / material_outputs / presentation_slides /
//  video_captions / quizzes / quiz_questions / quiz_attempts /
//  quiz_answers）schema 裡本來就有，只是一直沒有程式碼讀寫它們。
//  這裡照原本的欄位設計接上，沒有改動 schema。
// ═══════════════════════════════════════════════════════════

/** 教材含生成結果的對外格式。 */
function publicMaterial(m) {
  return {
    id: m.id,
    title: m.title,
    sourceType: m.sourceType,
    topic: m.topic,
    level: m.level,
    status: m.status,
    createdAt: m.createdAt,
    outputs: (m.outputs || []).map(o => ({
      id: o.id,
      formatType: o.formatType,
      contentText: o.contentText,
      fileUrl: o.fileUrl,
      createdAt: o.createdAt,
      slides: o.slides || [],
      captions: o.captions || [],
    })),
  };
}

/** 建立教材紀錄：生成「之前」就先建，這樣中途失敗也留得下痕跡。 */
app.post('/api/materials', async (req, res) => {
  const { userId, title, sourceType, topic, level } = req.body || {};
  if (!userId || !title) {
    return res.status(400).json({ error: '缺少 userId 或 title。' });
  }
  try {
    const material = await prisma.material.create({
      data: {
        userId: Number(userId),
        title: String(title).slice(0, 200),
        sourceType: sourceType || 'topic_guide',
        topic: topic || null,
        level: level || null,
        status: 'processing',
      },
    });
    res.status(201).json(publicMaterial(material));
  } catch (err) {
    res.status(500).json({ error: '建立教材失敗。' });
  }
});

/** 更新教材狀態（done / failed）。 */
app.patch('/api/materials/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'processing', 'done', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'status 不合法。' });
  }
  try {
    const material = await prisma.material.update({
      where: { id: Number(req.params.id) },
      data: { status },
    });
    res.json(publicMaterial(material));
  } catch (err) {
    res.status(404).json({ error: '找不到這份教材。' });
  }
});

/** 儲存一份生成結果；簡報的每頁標題、影片的字幕時間軸也一併存。 */
app.post('/api/materials/:id/outputs', async (req, res) => {
  const materialId = Number(req.params.id);
  const { formatType, contentText, fileUrl, slides, captions } = req.body || {};
  if (!['text', 'presentation', 'video'].includes(formatType)) {
    return res.status(400).json({ error: 'formatType 必須是 text / presentation / video。' });
  }
  try {
    const output = await prisma.materialOutput.create({
      data: {
        materialId,
        formatType,
        contentText: contentText || null,
        fileUrl: fileUrl || null,
      },
    });

    if (Array.isArray(slides) && slides.length) {
      await prisma.presentationSlide.createMany({
        data: slides.map((s, i) => ({
          outputId: output.id,
          orderIndex: Number(s.orderIndex ?? i),
          title: String(s.title || `第 ${i + 1} 頁`).slice(0, 200),
          content: s.content ? String(s.content) : null,
        })),
      });
    }

    if (Array.isArray(captions) && captions.length) {
      await prisma.videoCaption.createMany({
        data: captions.map((c, i) => ({
          outputId: output.id,
          orderIndex: Number(c.orderIndex ?? i),
          startTime: String(c.startTime ?? '0'),
          captionText: String(c.captionText || ''),
          segmentLabel: c.segmentLabel ? String(c.segmentLabel) : null,
        })),
      });
    }

    // 有了輸出就算完成
    await prisma.material.update({ where: { id: materialId }, data: { status: 'done' } });
    res.status(201).json({ id: output.id, formatType: output.formatType });
  } catch (err) {
    res.status(500).json({ error: '儲存生成結果失敗。' });
  }
});

/** 列出某使用者的教材（新到舊）。 */
app.get('/api/materials', async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: '缺少 userId。' });
  const materials = await prisma.material.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { outputs: true },
  });
  res.json(materials.map(publicMaterial));
});

/** 單一教材，含每頁標題與字幕。 */
app.get('/api/materials/:id', async (req, res) => {
  const material = await prisma.material.findUnique({
    where: { id: Number(req.params.id) },
    include: {
      outputs: {
        include: {
          slides: { orderBy: { orderIndex: 'asc' } },
          captions: { orderBy: { orderIndex: 'asc' } },
        },
      },
    },
  });
  if (!material) return res.status(404).json({ error: '找不到這份教材。' });
  res.json(publicMaterial(material));
});

// ═══════════════════════════════════════════════════════════
//  測驗：題目、作答、自動批改、成績紀錄
// ═══════════════════════════════════════════════════════════

/** 題目對外格式；withAnswers 為 false 時不送出正確答案，避免在瀏覽器就被看光。 */
function publicQuestion(q, withAnswers) {
  const base = {
    id: q.id,
    questionType: q.questionType,
    questionText: q.questionText,
    orderIndex: q.orderIndex,
    options: [],
  };
  if (q.options) {
    try { base.options = JSON.parse(q.options); } catch { base.options = []; }
  }
  if (withAnswers) base.correctAnswer = q.correctAnswer;
  return base;
}

/** 儲存一份測驗（題目一起寫入）。 */
app.post('/api/quizzes', async (req, res) => {
  const { userId, materialId, title, questions } = req.body || {};
  if (!userId || !title || !Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: '缺少 userId、title 或題目。' });
  }
  try {
    const quiz = await prisma.quiz.create({
      data: {
        userId: Number(userId),
        materialId: materialId ? Number(materialId) : null,
        title: String(title).slice(0, 200),
        questions: {
          create: questions.map((q, i) => ({
            questionType: q.questionType === 'short_answer' ? 'short_answer' : 'single_choice',
            questionText: String(q.questionText || '').slice(0, 2000),
            // SQLite 沒有 JSON 型態，選項存成 JSON 字串（schema 註解就是這樣寫的）
            options: Array.isArray(q.options) && q.options.length ? JSON.stringify(q.options) : null,
            correctAnswer: String(q.correctAnswer || ''),
            orderIndex: Number(q.orderIndex ?? i),
          })),
        },
      },
      include: { questions: true },
    });
    res.status(201).json({ id: quiz.id, title: quiz.title, questionCount: quiz.questions.length });
  } catch (err) {
    res.status(500).json({ error: '儲存測驗失敗。' });
  }
});

/** 列出測驗；帶上題數與這個人的最佳分數，紀錄列表才有東西可顯示。 */
app.get('/api/quizzes', async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: '缺少 userId。' });
  const quizzes = await prisma.quiz.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      questions: { select: { id: true, questionType: true } },
      attempts: { where: { userId }, select: { score: true, submittedAt: true } },
    },
  });
  res.json(quizzes.map(q => {
    const scores = q.attempts.map(a => a.score).filter(s => s !== null && s !== undefined);
    return {
      id: q.id,
      title: q.title,
      createdAt: q.createdAt,
      mcCount: q.questions.filter(x => x.questionType === 'single_choice').length,
      saCount: q.questions.filter(x => x.questionType === 'short_answer').length,
      attemptCount: q.attempts.length,
      bestScore: scores.length ? Math.max(...scores) : null,
    };
  }));
});

/** 取一份測驗的題目。預設不含答案；作答完要對答案時才帶 ?withAnswers=1。 */
app.get('/api/quizzes/:id', async (req, res) => {
  const withAnswers = req.query.withAnswers === '1';
  const quiz = await prisma.quiz.findUnique({
    where: { id: Number(req.params.id) },
    include: { questions: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!quiz) return res.status(404).json({ error: '找不到這份測驗。' });
  res.json({
    id: quiz.id,
    title: quiz.title,
    createdAt: quiz.createdAt,
    questions: quiz.questions.map(q => publicQuestion(q, withAnswers)),
  });
});

/** 把答案正規化再比對：選擇題只看字母，(A) / a / A. 都算同一個。 */
function normalizeChoice(text) {
  const m = String(text || '').toUpperCase().match(/[A-D]/);
  return m ? m[0] : '';
}

/** 交卷：自動批改選擇題，存成 QuizAttempt + QuizAnswer。 */
app.post('/api/quizzes/:id/attempts', async (req, res) => {
  const quizId = Number(req.params.id);
  const { userId, answers } = req.body || {};
  if (!userId || !Array.isArray(answers)) {
    return res.status(400).json({ error: '缺少 userId 或作答內容。' });
  }
  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    include: { questions: true },
  });
  if (!quiz) return res.status(404).json({ error: '找不到這份測驗。' });

  const byId = new Map(quiz.questions.map(q => [q.id, q]));
  const graded = [];
  let mcTotal = 0, mcRight = 0;

  for (const a of answers) {
    const q = byId.get(Number(a.questionId));
    if (!q) continue;
    let isCorrect = null;              // 簡答題無法自動批改，留 null 由使用者對照參考答案
    if (q.questionType === 'single_choice') {
      mcTotal += 1;
      isCorrect = normalizeChoice(a.userAnswer) === normalizeChoice(q.correctAnswer);
      if (isCorrect) mcRight += 1;
    }
    graded.push({ questionId: q.id, userAnswer: String(a.userAnswer || ''), isCorrect });
  }

  // 分數只算選擇題（簡答題沒有客觀標準，硬算會誤導）
  const score = mcTotal ? Math.round((mcRight / mcTotal) * 1000) / 10 : null;

  try {
    const attempt = await prisma.quizAttempt.create({
      data: {
        quizId,
        userId: Number(userId),
        score,
        answers: { create: graded },
      },
      include: { answers: true },
    });
    res.status(201).json({
      attemptId: attempt.id,
      score,
      mcTotal,
      mcRight,
      results: graded.map(g => ({
        questionId: g.questionId,
        userAnswer: g.userAnswer,
        isCorrect: g.isCorrect,
        correctAnswer: byId.get(g.questionId).correctAnswer,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: '儲存作答紀錄失敗。' });
  }
});

/** 某份測驗的作答紀錄。 */
app.get('/api/quizzes/:id/attempts', async (req, res) => {
  const userId = Number(req.query.userId);
  const attempts = await prisma.quizAttempt.findMany({
    where: { quizId: Number(req.params.id), ...(userId ? { userId } : {}) },
    orderBy: { submittedAt: 'desc' },
    take: 20,
    select: { id: true, score: true, submittedAt: true },
  });
  res.json(attempts);
});

// ═══════════════════════════════════════════════════════════
//  提供前端網頁：讓這支 Express 同時當網頁伺服器
//
//  刻意不用 express.static(__dirname)。專案根目錄裡混著 server.js、
//  .env、prisma/schema.prisma，整個資料夾丟出去等於把後端原始碼和
//  資料庫結構公開。這裡只放行「副檔名是前端資源、且直接位於根目錄」
//  的檔案，其餘一律不給。
// ═══════════════════════════════════════════════════════════
const PUBLIC_EXT = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg',
                            '.svg', '.ico', '.webp', '.gif', '.woff', '.woff2']);
const PRIVATE_FILES = new Set(['server.js', 'dev-server.py']);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get(/^\/[^/]+$/, (req, res, next) => {
  const name = decodeURIComponent(req.path.slice(1));
  // 只認根目錄下的單一檔名：擋掉 ../、子目錄與隱藏檔
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) return next();
  if (PRIVATE_FILES.has(name)) return next();
  if (!PUBLIC_EXT.has(path.extname(name).toLowerCase())) return next();

  const full = path.join(__dirname, name);
  if (!full.startsWith(__dirname) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return next();
  }
  res.sendFile(full);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
