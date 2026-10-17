import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // needed behind Render/Railway/Vercel so limits use the real visitor IP
app.use(express.json({ limit: "50kb" }));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const PER_IP = Number(process.env.MAX_REQUESTS_PER_IP_PER_HOUR || 40);
const PER_DAY = Number(process.env.MAX_REQUESTS_PER_DAY_TOTAL || 1500);

// --- Limits -----------------------------------------------------------
app.use("/api", rateLimit({
  windowMs: 60 * 60 * 1000, limit: PER_IP, standardHeaders: true, legacyHeaders: false,
  message: { error: "You've used a lot of practice sessions this hour. Try again in a little while." },
}));
let day = new Date().toDateString(), dayCount = 0;
app.use("/api", (req, res, next) => {
  const today = new Date().toDateString();
  if (today !== day) { day = today; dayCount = 0; }
  if (++dayCount > PER_DAY) return res.status(503).json({ error: "InterviewBuddy is at capacity today. Please come back tomorrow." });
  next();
});

// --- Claude helper ----------------------------------------------------
async function askClaude(system, user, maxTokens = 1200) {
  if (!API_KEY) throw new Error("Server is missing GEMINI_API_KEY.");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: maxTokens + 1500, temperature: 0.7 },
    }),
  });
  if (!r.ok) throw new Error(`AI API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

const clip = (s, n) => String(s ?? "").slice(0, n);
const setup = b => ({
  role: clip(b.role, 80) || "General role",
  difficulty: ["Easy", "Medium", "Hard"].includes(b.difficulty) ? b.difficulty : "Medium",
  language: clip(b.language, 30) || "English",
});
const PERSONA = `You are Riya, a warm, encouraging interview coach. Be friendly, specific and honest. Respond with ONLY valid JSON, no markdown, no preamble.`;

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req.body || {})); }
  catch (e) { console.error(e.message); res.status(502).json({ error: "Something went wrong on our side. Please try again." }); }
};

// --- Routes -----------------------------------------------------------
app.post("/api/questions", wrap(async b => {
  const s = setup(b);
  const out = await askClaude(PERSONA,
    `Write 5 interview questions for a "${s.role}" candidate. Difficulty: ${s.difficulty}. Language: ${s.language} (write the questions in this language).
Mix 1 intro/motivation, 2 role-specific, 1 behavioural (STAR style), 1 situational. Keep each under 30 words.
Return: {"questions":["...","...","...","...","..."]}`, 600);
  const questions = (out.questions || []).slice(0, 5).map(q => clip(q, 300));
  if (questions.length < 5) throw new Error("Bad question set");
  return { questions };
}));

app.post("/api/feedback", wrap(async b => {
  const s = setup(b);
  const question = clip(b.question, 300), answer = clip(b.answer, 4000);
  if (answer.trim().split(/\s+/).length < 3) return { score: 0, strengths: "", improvements: "Your answer was too short to review. Try a few full sentences.", tip: "" };
  return await askClaude(PERSONA,
    `Role: ${s.role}. Difficulty: ${s.difficulty}. Reply in ${s.language}.
Question: ${question}
Candidate answer: ${answer}
Give friendly, specific feedback. Score 0-100 for relevance, structure, specifics and clarity.
Return: {"score":int,"strengths":"1-2 sentences","improvements":"1-2 sentences","tip":"one concrete rewrite or technique, 1 sentence"}`, 700);
}));

app.post("/api/summary", wrap(async b => {
  const s = setup(b);
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 5)
    .map(i => `Q: ${clip(i.question, 300)}\nScore: ${Number(i.score) || 0}\nFeedback: ${clip(i.improvements, 300)}`).join("\n\n");
  return await askClaude(PERSONA,
    `Role: ${s.role}. Reply in ${s.language}. Here is how a candidate did across five questions:\n\n${items}
Write a short, encouraging wrap-up.
Return: {"headline":"one short sentence","summary":"2-3 sentences","focus":["up to 3 short things to practise next"]}`, 600);
}));

app.get("/healthz", (_, res) => res.send("ok"));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(process.env.PORT || 3000, () => console.log("InterviewBuddy running"));
