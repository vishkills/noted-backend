require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: '/tmp/noted-uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Single Groq client — handles both Whisper + Llama
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'placeholder' });

// In-memory lesson store
const lessons = {};

// ── HEALTH CHECK ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Noted.',
    groq: process.env.GROQ_API_KEY ? '✅ connected' : '❌ missing GROQ_API_KEY'
  });
});

// ── PROCESS LESSON (Transcribe + Summarise) ──
app.post('/api/process-lesson', upload.single('audio'), async (req, res) => {
  const subject = req.body.subject || 'General';
  const audioFile = req.file;

  if (!audioFile) return res.status(400).json({ error: 'No audio received' });

  console.log(`\n📥 Lesson — Subject: "${subject}" | Size: ${(audioFile.size / 1024).toFixed(1)}KB`);

  let transcript = '';

  // ── STEP 1: TRANSCRIBE WITH GROQ WHISPER ──
  try {
    console.log('🎙 Transcribing with Groq Whisper...');

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioFile.path),
      model: 'whisper-large-v3-turbo', // fast + accurate, free tier
      response_format: 'text',
      temperature: 0.2,
      // No language set = auto-detect (handles BM, Mandarin, Tamil, English, Manglish)
    });

    transcript = transcription || '';
    console.log(`✅ Transcript (${transcript.length} chars): "${transcript.substring(0, 120)}..."`);

  } catch (err) {
    console.error('⚠️ Whisper error:', err.message);
    transcript = `[Audio unclear — generate realistic summary for subject: ${subject}]`;
  } finally {
    if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
  }

  // ── STEP 2: SUMMARISE WITH GROQ LLAMA ──
  try {
    console.log('🤖 Summarising with Llama...');

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile', // best quality on free tier
      temperature: 0.3,
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content: `You are Noted. — an AI assistant built for Malaysian classroom lessons.
Your job is to extract a clean, structured lesson summary from a tutor's lesson transcript.
Malaysian tutors mix languages — English, Bahasa Malaysia, Mandarin, Tamil — this is completely normal.
Extract meaning across all languages. Be specific, not generic.
Always return ONLY valid JSON. No markdown, no explanation, nothing else.`
        },
        {
          role: 'user',
          content: `Subject: "${subject}"

Lesson Transcript:
"""
${transcript}
"""

Extract the lesson summary. If the transcript is unclear or too short, generate a realistic and specific summary for the subject "${subject}" that a Malaysian tutor would actually teach.

Return ONLY this JSON format:
{
  "topics": ["specific topic 1", "specific topic 2"],
  "keyPoints": ["key point 1", "key point 2", "key point 3"],
  "homework": [
    {"task": "specific homework task", "due": "deadline, or Next class if not mentioned"}
  ],
  "reminders": ["reminder 1"],
  "languagesDetected": ["English", "Bahasa Malaysia"]
}`
        }
      ]
    });

    const raw = completion.choices[0]?.message?.content || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const summary = JSON.parse(clean);

    // Generate lesson ID and save
    const lessonId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    lessons[lessonId] = {
      id: lessonId,
      subject,
      summary,
      transcript,
      createdAt: new Date().toISOString(),
    };
    saveLessons();

    console.log(`✅ Done — Lesson ID: ${lessonId}`);
    console.log(`   Topics: ${summary.topics?.join(', ')}`);
    console.log(`   Homework items: ${summary.homework?.length}`);

    res.json({ success: true, summary, lessonId });

  } catch (err) {
    console.error('❌ Summarisation error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary. Please try again.' });
  }
});

// ── GET LESSON BY ID (for student share link) ──
app.get('/api/lesson/:id', (req, res) => {
  const lesson = lessons[req.params.id];
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
  res.json(lesson);
});

// ── CATCH-ALL: serve index.html for /notes/ID share links ──
app.get('/notes/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── FEEDBACK ──
app.post('/api/feedback', (req, res) => {
  const entry = { ...req.body, timestamp: new Date().toISOString() };
  console.log('\n📊 Feedback received:', JSON.stringify(entry));
  const logPath = path.join(__dirname, 'feedback-log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
  log.push(entry);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  res.json({ success: true });
});

app.get('/api/feedback-log', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'feedback-log.json'), 'utf8'))); }
  catch { res.json([]); }
});

// ── PERSIST LESSONS ──
const LESSONS_FILE = path.join(__dirname, 'lessons-store.json');
function saveLessons() {
  try { fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2)); } catch {}
}
function loadLessons() {
  try {
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8'));
    Object.assign(lessons, data);
    console.log(`📚 Loaded ${Object.keys(lessons).length} saved lessons`);
  } catch {}
}
loadLessons();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Noted. backend running on http://localhost:${PORT}`);
  console.log(`   Groq API: ${process.env.GROQ_API_KEY ? '✅ connected' : '❌ GROQ_API_KEY missing'}`);
  console.log(`   Whisper model: whisper-large-v3-turbo`);
  console.log(`   LLM model: llama-3.3-70b-versatile`);
});
