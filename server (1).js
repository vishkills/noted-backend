require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: '/tmp/noted-uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'placeholder' });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'placeholder' });

// In-memory lesson store (resets on server restart — fine for demo)
const lessons = {};

// ── HEALTH CHECK ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Noted.' });
});

// ── PROCESS LESSON ──
app.post('/api/process-lesson', upload.single('audio'), async (req, res) => {
  const subject = req.body.subject || 'General';
  const audioFile = req.file;
  if (!audioFile) return res.status(400).json({ error: 'No audio received' });

  console.log(`\n📥 Lesson — Subject: "${subject}" | Size: ${(audioFile.size/1024).toFixed(1)}KB`);

  let transcript = '';
  try {
    console.log('🎙 Transcribing...');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile.path),
      model: 'whisper-1',
      response_format: 'text',
      temperature: 0.2,
    });
    transcript = transcription || '';
    console.log(`✅ Transcript: ${transcript.substring(0, 100)}...`);
  } catch (err) {
    console.error('⚠️ Whisper error:', err.message);
    transcript = `[Summarise based on subject: ${subject}]`;
  } finally {
    if (fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path);
  }

  try {
    console.log('🤖 Summarising...');
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are Noted. — AI assistant for Malaysian classroom lessons.

Subject: "${subject}"
Transcript: """${transcript}"""

Extract a clean lesson summary. Base it strictly on the transcript.
If transcript is unclear, generate a realistic specific summary for "${subject}".
Malaysian tutors mix English, BM, Mandarin, Tamil — extract meaning across all.

Return ONLY valid JSON, no markdown:
{
  "topics": ["topic 1"],
  "keyPoints": ["point 1", "point 2"],
  "homework": [{"task": "task description", "due": "deadline or Next class"}],
  "reminders": ["reminder"],
  "languagesDetected": ["English"]
}`
      }]
    });

    const raw = message.content.map(b => b.text || '').join('');
    const summary = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // Generate lesson ID and store it
    const lessonId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const lessonData = {
      id: lessonId,
      subject,
      summary,
      transcript,
      createdAt: new Date().toISOString(),
    };
    lessons[lessonId] = lessonData;

    // Save to file for persistence across restarts
    saveLessons();

    console.log(`✅ Lesson saved: ${lessonId}`);
    res.json({ success: true, summary, lessonId });

  } catch (err) {
    console.error('❌ Claude error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ── GET LESSON BY ID (for share link) ──
app.get('/api/lesson/:id', (req, res) => {
  const lesson = lessons[req.params.id];
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
  res.json(lesson);
});

// ── FEEDBACK ──
app.post('/api/feedback', (req, res) => {
  const entry = { ...req.body, timestamp: new Date().toISOString() };
  console.log('\n📊 Feedback:', JSON.stringify(entry));
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

// Catch-all: serve index.html for /notes/ID share links
app.get("/notes/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Noted. running on http://localhost:${PORT}`);
  console.log(`   Whisper: ${process.env.OPENAI_API_KEY ? '✅' : '❌ Missing OPENAI_API_KEY'}`);
  console.log(`   Claude:  ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌ Missing ANTHROPIC_API_KEY'}`);
});
