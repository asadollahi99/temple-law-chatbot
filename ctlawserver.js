// server/index.mjs
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import morgan from "morgan";
import axios from "axios";
import cors from "cors";
import crypto from "crypto";

import { getDb } from "./db.mjs";
import { embed, cosine } from "./embeddings.mjs";
import { collectFromSitemap, indexUrl } from "./indexer.mjs";
import { registerUser, loginUser, verifyToken } from "./auth.mjs";

// ---------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------
const app = express();

const allowedOrigins = [
    "http://localhost:5173",
    "https://templelawwidget.onrender.com",
    "https://law-dev.temple.edu"
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-token"],
}));


app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

// ---------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
function requireAdmin(req, res, next) {
    const t = (req.headers["x-admin-token"] || req.query.token || "").trim();
    if (ADMIN_TOKEN && t === ADMIN_TOKEN) return next();
    return res.status(401).json({ error: "Unauthorized" });
}

// ---------------------------------------------------------------------
// Session helpers (Mongo)
// ---------------------------------------------------------------------
import { randomUUID } from "crypto"; // Node's crypto randomUUID
async function appendTurn(db, sid, { role, content, sources = [], meta = {} }) {
    const now = new Date();
    const mid = randomUUID();
    await db.collection("sessions").updateOne(
        { sid },
        {
            $setOnInsert: { sid, createdAt: now },
            $push: { history: { mid, role, content, sources, ts: now, ...meta } },
            $set: { updatedAt: now }
        },
        { upsert: true }
    );
}

async function loadHistory(db, sid) {
    if (!sid) return [];
    const s = await db.collection("sessions").findOne({ sid });
    return s?.history || [];
}

// Ensure useful indexes at boot (safe to run every start)
(async () => {
    const db = await getDb();
    await db.collection("sessions").createIndex({ sid: 1 }, { unique: true });
    await db.collection("sessions").createIndex({ updatedAt: -1 });
    await db.collection("sessions").createIndex({ "history.content": "text" });
    await db.collection("chunks").createIndex({ text: "text" }).catch(() => { });
    // safe helper to convert id to ObjectId or return null if invali

})();

// Add these imports near the top with your other imports
import { ObjectId } from "mongodb";

// Safe helper (place this once near the top, BEFORE any routes)
function toObjectId(id) {
    if (!id) return null;
    try {
        // tolerate objects like { $oid: "..." } or raw string id
        if (typeof id === "object" && id !== null && id.$oid) id = id.$oid;
        if (typeof id !== "string") id = String(id);
        if (!ObjectId.isValid(id)) return null;
        return new ObjectId(id);
    } catch (err) {
        return null;
    }
}

// ---------------------------------------------------------------------
// Health & Stats
// ---------------------------------------------------------------------
app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/stats", async (_req, res) => {
    try {
        const db = await getDb();
        const [pages, chunks, sessions] = await Promise.all([
            db.collection("pages").countDocuments().catch(() => 0),
            db.collection("chunks").countDocuments().catch(() => 0),
            db.collection("sessions").countDocuments().catch(() => 0),
        ]);
        res.json({ db: db.databaseName, pages, chunks, sessions });
    } catch (e) {
        res.status(500).json({ error: e.message || String(e) });
    }
});

// ---------------------------------------------------------------------
// Ask (RAG + session persistence)
// ---------------------------------------------------------------------
app.post("/ask", async (req, res) => {
    try {
        // read incoming body early and normalize
        const { q = "", sid: clientSid } = req.body || {};
        const query = (q || "").trim();
        if (!query) return res.status(400).json({ error: "Empty question" });

        const sid = clientSid || crypto.randomUUID();
        const db = await getDb();

        // Save user turn
        await appendTurn(db, sid, {
            role: "user",
            content: query,
            meta: { ip: req.ip, ua: req.headers["user-agent"] || "" }
        });

        // STEP: expand "explain more"
        let expandedQuery = query;
        if (/^(explain|tell|say)\s+more/i.test(query)) {
            const s = await db.collection("sessions").findOne({ sid });
            if (s?.history?.length) {
                const lastAssistant = [...s.history].reverse().find(h => h.role === "assistant" && h.content && !/conversation reset/i.test(h.content));
                const lastUser = [...s.history].reverse().find(h => h.role === "user" && h.content && h.content !== query);
                const context = [
                    lastUser?.content ? `Previous question: ${lastUser.content}` : "",
                    lastAssistant?.content ? `Previous answer: ${lastAssistant.content}` : ""
                ].filter(Boolean).join("\n");
                expandedQuery = `Please elaborate on the previous topic.\n${context}`;
                console.log("Expanded 'explain more' →", expandedQuery);
            }
        }

        // Load short history for grounding
        const history = await loadHistory(db, sid);

        // Normalize grammar via GPT (keep meaning)
        const normRes = await axios.post(
            "https://api.openai.com/v1/responses",
            {
                model: "gpt-4o-mini",
                input: [
                    { role: "system", content: "You are a grammar normalizer. Fix grammar and phrasing but keep meaning identical." },
                    { role: "user", content: expandedQuery }
                ],
                temperature: 0
            },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );
        const normalizedQuery = normRes.data.output?.[0]?.content?.[0]?.text?.trim() || expandedQuery;
        console.log("Normalized query:", normalizedQuery);

        // STEP: compute embedding
        const qvec = await embed(normalizedQuery);
        if (qvec.length !== 1536) console.warn("Unexpected embedding length:", qvec.length);

        // STEP: keyword expansion and prefilter
        const words = [...new Set(normalizedQuery.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3))];
        const synonyms = { start: ["begin", "open", "commence"], finish: ["end", "close"], tuition: ["fees", "billing"], academic: ["school", "semester", "classes"], calendar: ["schedule", "term", "dates"], law: ["temple law", "beasley school of law"], policy: ["rule", "procedure"] };
        let expanded = new Set(words);
        for (const w of words) if (synonyms[w]) synonyms[w].forEach(s => expanded.add(s));
        const expandedWords = [...expanded];

        let prefilter = [];
        if (expandedWords.length) {
            try {
                prefilter = await db.collection("chunks")
                    .find({ $text: { $search: expandedWords.join(" ") } })
                    .project({ embedding: 1, text: 1, url: 1 })
                    .limit(400)
                    .toArray();
            } catch {
                const or = expandedWords.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
                prefilter = await db.collection("chunks").find({ $or: or }).limit(400).toArray();
            }
        }

        // Fallback context enrichment if few hits
        if (prefilter.length < 30) {
            const keywordPool = ["academic", "calendar", "semester", "schedule", "start", "dates", "program", "tuition", "policy", "admissions"];
            const orExtra = keywordPool.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
            const extras = await db.collection("chunks").find({ $or: orExtra }).project({ embedding: 1, text: 1, url: 1 }).limit(100).toArray();
            prefilter.push(...extras);
        }

        // Force include environmental docs if relevant
        const qLower = normalizedQuery.toLowerCase();
        if (qLower.includes("environmental law") || qLower.includes("energy") || qLower.includes("climate") || qLower.includes("sustainability")) {
            const envDocs = await db.collection("chunks").find({ url: { $regex: "environmental-law", $options: "i" } }).project({ embedding: 1, text: 1, url: 1 }).toArray();
            if (envDocs.length) prefilter.push(...envDocs);
        }

        if (!prefilter.length) {
            prefilter = await db.collection("chunks").find({}).project({ embedding: 1, text: 1, url: 1 }).limit(400).toArray();
        }

        // Rank by cosine similarity
        const ranked = prefilter.map(c => {
            const emb = Array.isArray(c.embedding) ? c.embedding.map(Number) : [];
            return { url: c.url, text: c.text, score: cosine(qvec, emb) };
        }).sort((a, b) => b.score - a.score);

        console.log("Top 3 similarity scores:", ranked.slice(0, 3).map(r => r.score.toFixed(3)));

        // Deep retrieval if low-similarity and previous assistant said "I don't know"
        if (!ranked.length || ranked[0].score < 0.45) {
            console.warn("Low embedding similarity — deep retrieval:", normalizedQuery);
            const session = await db.collection("sessions").findOne({ sid });
            const lastAssistant = [...(session?.history || [])].reverse().find(h => h.role === "assistant");
            let deepMode = false;
            if (lastAssistant && /i don't know/i.test(lastAssistant.content)) deepMode = true;

            let fallbackDocs = [];
            if (deepMode) {
                fallbackDocs = await db.collection("chunks").find({ text: { $regex: ".", $options: "i" } }).project({ text: 1, url: 1, embedding: 1 }).limit(1500).toArray();
            } else {
                fallbackDocs = await db.collection("chunks").find({ text: { $regex: normalizedQuery, $options: "i" } }).project({ text: 1, url: 1, embedding: 1 }).limit(100).toArray();
            }

            const rescored = fallbackDocs.map(doc => ({ url: doc.url, text: doc.text, score: cosine(qvec, doc.embedding.map(Number)) }));
            ranked.push(...rescored.sort((a, b) => b.score - a.score).slice(0, 15));
        }

        // choose top candidates
        const MIN_SIM = 0.12;
        let top = ranked.filter(r => r.score >= MIN_SIM).slice(0, 12);
        if (!top.length) top = ranked.slice(0, 12);

        // Build context for LLM
        const context = top.map((t, i) => `Source ${i + 1}:\n${t.text.trim().toLowerCase()}\n(URL: ${t.url})`).join("\n\n");

        console.log("Top retrieved chunks (first 10):");
        for (const r of ranked.slice(0, 10)) {
            console.log(`→ Score: ${r.score.toFixed(3)} | ${r.url}`);
        }

        // Decision constants
        const SITE_THRESHOLD = 0.45;
        const OVERRIDE_EMB_THRESHOLD = 0.82;

        // normalize query (ensure same normalization used when saving overrides)
        const normQuery = (query || "").trim().toLowerCase();

        // ensure topScore numeric
        const topScore = Number(ranked?.[0]?.score ?? 0);

        // safe mid generator
        const makeMid = () => {
            if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
            return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        };

        // 1) exact normalized match / force check
        let overrideDoc = null;

        try {
            const overridesCol = db.collection("faq_overrides");
            const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const qRegex = new RegExp(`^${escapeRegex((normQuery || "").trim())}$`, "i");

            // try normalized field first, then question
            overrideDoc = await overridesCol.findOne({ normQuestion: { $regex: qRegex } })
                || await overridesCol.findOne({ question: { $regex: qRegex } });

            console.log("overrideDoc (force-check):", overrideDoc ? { question: overrideDoc.question, force: overrideDoc.force } : null);

            if (overrideDoc && overrideDoc.force === true && (overrideDoc.answer || overrideDoc.assistantContent)) {
                const answer = overrideDoc.answer ?? overrideDoc.assistantContent;

                console.log("Returning forced override answer for:", normQuery, "answer:", answer?.slice?.(0, 120));
                const mid = makeMid();
                const sources = ["Reviewed Answer"];

                // write assistant turn to sessions
                await appendTurn(db, sid, { role: "assistant", content: answer, sources, meta: { override: true, reviewer: overrideDoc.reviewer, forced: true } });

                return res.json({ sid, answer, sources, mid });
            }
        } catch (err) {
            console.error("Override force-check error:", err);
            // fall through to normal flow
        }

        // 2) semantic matching fallback (only run if no exact override matched)
        if (!overrideDoc) {
            try {
                const candidates = await db.collection("faq_overrides")
                    .find({ questionEmbedding: { $exists: true } })
                    .project({ assistantContent: 1, answer: 1, force: 1, reviewer: 1, questionEmbedding: 1, question: 1 })
                    .toArray();

                console.log("Semantic override candidates:", candidates.length);
                if (candidates.length && Array.isArray(qvec)) {
                    let best = null;
                    for (const c of candidates) {
                        if (!Array.isArray(c.questionEmbedding)) continue;
                        const emb = c.questionEmbedding.map(Number);
                        const sim = cosine(qvec, emb);
                        if (!best || sim > best.sim) best = { doc: c, sim };
                    }
                    if (best) {
                        console.log("Best semantic override sim:", best.sim.toFixed(3), "question:", best.doc.question);
                    }
                    if (best && best.sim >= OVERRIDE_EMB_THRESHOLD) {
                        overrideDoc = best.doc;
                    } else {
                        console.log("No semantic override match (best sim):", best ? best.sim.toFixed(3) : "n/a");
                    }
                }
            } catch (err) {
                console.warn("Semantic override lookup failed:", err);
            }
        }

        // debug logs
        console.log("normQuery:", normQuery);
        console.log("Top chunk score:", topScore.toFixed ? topScore.toFixed(3) : topScore);
        console.log("overrideDoc (final):", overrideDoc ? { question: overrideDoc.question, force: overrideDoc.force } : null);

        // Decision rules: ONLY return an override when force === true.
        if (overrideDoc && overrideDoc.force) {
            console.log("Using forced override for:", normQuery);
            const answer = overrideDoc.answer ?? overrideDoc.assistantContent;
            const mid = makeMid();
            await appendTurn(db, sid, { role: "assistant", content: answer, sources: ["Reviewed Answer"], meta: { override: true, reviewer: overrideDoc.reviewer, forced: true } });
            return res.json({ sid, answer, sources: ["Reviewed Answer"], mid });
        }

        // If site is confident, prefer site answer (do not use non-forced override)
        if (topScore >= SITE_THRESHOLD) {
            console.log("Site confident — using RAG/LLM answer (override not applied).");
        } else {
            // site not confident but override is NOT forced -> DO NOT automatically return override.
            if (overrideDoc) {
                console.log("Site not confident and admin override exists but is not forced. Continuing to RAG/LLM pipeline (override will not be auto-applied).");
            } else {
                console.log("Site not confident and no admin override — proceeding with RAG/LLM pipeline.");
            }
        }

        // STEP: Generate answer using OpenAI (system + history + context)
        const system = "You are Temple Law’s website assistant. Answer ONLY using the context below (from law.temple.edu). If the context seems insufficient, search across the full law.temple.edu website (already indexed) before saying you don't know. If still missing, suggest the most relevant Temple Law page or section.";
        const messages = [
            { role: "system", content: system },
            ...history.map(h => ({ role: h.role, content: h.content })),
            { role: "user", content: `Question: ${normalizedQuery}\n\n=== WEBSITE CONTEXT START ===\n${context}\n=== WEBSITE CONTEXT END ===` }
        ];

        const r = await axios.post(
            "https://api.openai.com/v1/responses",
            { model: "gpt-4o-mini", input: messages, temperature: 0.2, max_output_tokens: 500 },
            { headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );

        const answer =
            r.data.output_text ??
            (Array.isArray(r.data.output) ? r.data.output.map(o => Array.isArray(o.content) ? o.content.map(c => c.text ?? "").join("") : "").join("\n") : "") ??
            (r.data.choices && r.data.choices[0]?.message?.content) ??
            "I couldn't find relevant info in the provided pages.";

        const sources = top.map(t => t.url);

        // Save assistant turn
        const mid = crypto.randomUUID();
        await db.collection("sessions").updateOne(
            { sid },
            {
                $push: { history: { mid, role: "assistant", content: answer, sources, ts: new Date() } },
                $set: { updatedAt: new Date() }
            },
            { upsert: true }
        );

        console.log("normQuery:", normQuery);
        console.log("Top chunk score:", (topScore || 0).toFixed(3));
        console.log("overrideDoc (db lookup):", overrideDoc);

        return res.json({ sid, answer, sources, mid });

    } catch (e) {
        console.error("ASK error:", e.stack || e);
        return res.status(500).json({ error: e.message || String(e) });
    }
});

// ---------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------
app.post("/review", verifyToken, async (req, res) => {
    try {
        const { question, correctedAnswer, force = false, sid, assistantMid, assistantContent } = req.body || {};
        if (!question || !correctedAnswer) return res.status(400).json({ error: "Missing question or correctedAnswer" });

        const db = await getDb();
        const clean = question.trim();
        const norm = clean.toLowerCase();
        const now = new Date();

        // compute an embedding for the normalized question so we can do semantic lookup later
        let questionEmbedding = null;
        try {
            questionEmbedding = await embed(norm);
        } catch (err) {
            console.warn("Question embedding failed (proceeding without embedding):", err.message || err);
            questionEmbedding = null;
        }

        await db.collection("faq_overrides").updateOne(
            { normQuestion: norm },
            {
                $set: {
                    question: clean,
                    normQuestion: norm,
                    answer: correctedAnswer,
                    reviewer: req.adminUser || "admin",
                    force: !!force,
                    sid: sid || null,
                    assistantMid: assistantMid || null,
                    assistantContent: assistantContent || null,
                    updatedAt: now,
                    ...(questionEmbedding ? { questionEmbedding } : {})
                },
                $setOnInsert: { createdAt: now }
            },
            { upsert: true }
        );

        return res.json({ ok: true });
    } catch (e) {
        console.error("Error in /review:", e);
        return res.status(500).json({ error: e.message || String(e) });
    }
});

// ---------------------------------------------------------------------
// Reset (delete a session)
app.post("/reset", async (req, res) => {
    const { sid } = req.body || {};
    if (!sid) return res.json({ ok: true });
    const db = await getDb();
    await db.collection("sessions").deleteOne({ sid });
    res.json({ ok: true });
});

// Feedback endpoint (existing)
app.post("/feedback", async (req, res) => {
    try {
        const { sid, mid, correct, comment } = req.body;
        if (!sid || !mid) return res.status(400).json({ error: "Missing sid or mid" });

        const db = await getDb();
        await db.collection("sessions").updateOne(
            { sid, "history.mid": mid },
            {
                $set: {
                    "history.$.feedback": {
                        correct,
                        comment,
                        ts: new Date()
                    }
                }
            }
        );
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message || String(e) });
    }
});

// Indexing endpoint (unchanged)
app.post("/index", async (req, res) => {
    try {
        const { sitemap = "https://law.temple.edu/sitemap_index.xml", max = 2000 } = req.body || {};
        const db = await getDb();

        const deny = [
            /\/wp-admin/i, /\/wp-json/i, /\/feed/i,
            /\.pdf$/i, /\.jpg$/i, /\.jpeg$/i, /\.png$/i, /\.gif$/i, /\.svg$/i,
            /twitter\.com/i, /facebook\.com/i, /linkedin\.com/i
        ];

        const urls = (await collectFromSitemap(sitemap, max))
            .filter(u => u.startsWith("https://law.temple.edu/"));

        let done = 0, added = 0, updated = 0, unchanged = 0, skipped = 0;
        for (const u of urls) {
            const r = await indexUrl(db, u, deny);
            if (r.status === "added") added++;
            else if (r.status === "updated") updated++;
            else if (r.status === "unchanged") unchanged++;
            else if (r.skipped) skipped++;
            done++;
            if (done % 20 === 0) console.log(`Indexed ${done}/${urls.length}`);
        }
        res.json({ ok: true, total: urls.length, added, updated, unchanged, skipped });
    } catch (e) {
        res.status(500).json({ error: e.message || String(e) });
    }
});

// Admin/history endpoints (unchanged)
app.get("/history", async (req, res) => {
    try {
        const sid = (req.query.sid || "").trim();
        if (!sid) return res.status(400).json({ error: "Missing sid" });
        const db = await getDb();
        const s = await db.collection("sessions").findOne({ sid });
        return res.json({ sid, history: s?.history || [] });
    } catch (e) {
        return res.status(500).json({ error: e.message || String(e) });
    }
});

app.get("/admin/sessions", verifyToken, async (req, res) => {
    const db = await getDb();
    const { q = "", from = "", to = "", limit = "25", skip = "0" } = req.query;

    const L = Math.min(parseInt(limit, 10) || 25, 200);
    const S = Math.max(parseInt(skip, 10) || 0, 0);

    const match = {};
    if (q) match.$text = { $search: q };
    if (from || to) {
        match.updatedAt = {};
        if (from) match.updatedAt.$gte = new Date(from);
        if (to) match.updatedAt.$lte = new Date(to);
    }

    const pipeline = [
        { $match: match },
        { $sort: { updatedAt: -1 } },
        {
            $facet: {
                rows: [
                    { $skip: S },
                    { $limit: L },
                    {
                        $project: {
                            _id: 0,
                            sid: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            count: { $size: { $ifNull: ["$history", []] } },
                            correctCount: {
                                $size: {
                                    $filter: {
                                        input: { $ifNull: ["$history", []] },
                                        as: "h",
                                        cond: { $eq: ["$$h.feedback.correct", true] }
                                    }
                                }
                            },
                            incorrectCount: {
                                $size: {
                                    $filter: {
                                        input: { $ifNull: ["$history", []] },
                                        as: "h",
                                        cond: { $eq: ["$$h.feedback.correct", false] }
                                    }
                                }
                            }
                        }
                    }
                ],
                meta: [{ $count: "total" }]
            }
        }
    ];

    const [out] = await db.collection("sessions").aggregate(pipeline).toArray();
    const total = out?.meta?.[0]?.total || 0;
    res.json({ total, limit: L, skip: S, rows: out?.rows || [] });
});

app.get("/admin/session/:sid", verifyToken, async (req, res) => {
    const db = await getDb();
    const doc = await db.collection("sessions").findOne({ sid: req.params.sid });
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ sid: doc.sid, createdAt: doc.createdAt, updatedAt: doc.updatedAt, history: doc.history || [] });
});

app.get("/admin/export.ndjson", verifyToken, async (req, res) => {
    const db = await getDb();
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    const cur = db.collection("sessions").find({}, { sort: { updatedAt: -1 } });
    for await (const doc of cur) res.write(JSON.stringify(doc) + "\n");
    res.end();
});

app.delete("/admin/session/:sid", verifyToken, async (req, res) => {
    const db = await getDb();
    const r = await db.collection("sessions").deleteOne({ sid: req.params.sid });
    res.json({ ok: true, deleted: r.deletedCount || 0 });
});

// ---------- AUTH ROUTES ----------
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "templelawsecret";

// User login
app.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        const db = await getDb();
        const user = await db.collection("users").findOne({ username });
        if (!user) return res.status(401).json({ error: "Invalid username or password" });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: "Invalid username or password" });

        const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: "8h" });
        res.json({ token, role: user.role });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Verify JWT middleware
// function verifyToken(req, res, next) {
//     const header = req.headers.authorization;
//     if (!header) return res.status(401).json({ error: "No token" });
//     const token = header.split(" ")[1];
//     try {
//         const decoded = jwt.verify(token, JWT_SECRET);
//         req.user = decoded;
//         next();
//     } catch {
//         res.status(401).json({ error: "Invalid token" });
//     }
// }

// Super admin creates users
app.get("/admin/users", verifyToken, async (req, res) => {
    try {
        if (req.user.role !== "superadmin") {
            return res.status(403).json({ error: "Not authorized" });
        }
        const db = await getDb();
        const users = await db.collection("users").find({}, { projection: { password: 0 } }).toArray();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

// Create new user (superadmin only)
app.post("/admin/users", verifyToken, async (req, res) => {
    try {
        if (req.user.role !== "superadmin") {
            return res.status(403).json({ error: "Not authorized" });
        }
        const { username, password, role } = req.body;
        if (!username || !password || !role) return res.status(400).json({ error: "Missing fields" });

        const db = await getDb();
        const existing = await db.collection("users").findOne({ username });
        if (existing) return res.status(400).json({ error: "User already exists" });

        const hashed = await bcrypt.hash(password, 10);
        await db.collection("users").insertOne({
            username,
            password: hashed,
            role,
            createdAt: new Date(),
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

// Update user (superadmin only)
app.patch("/admin/users/:username", verifyToken, async (req, res) => {
    try {
        if (req.user.role !== "superadmin") {
            return res.status(403).json({ error: "Not authorized" });
        }
        const { username } = req.params;
        const { password, role } = req.body;
        const db = await getDb();

        const update = {};
        if (password) {
            update.password = await bcrypt.hash(password, 10);
        }
        if (role) update.role = role;
        if (Object.keys(update).length === 0)
            return res.status(400).json({ error: "Nothing to update" });

        await db.collection("users").updateOne({ username }, { $set: update });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

// Delete user (superadmin only)
app.delete("/admin/users/:username", verifyToken, async (req, res) => {
    try {
        if (req.user.role !== "superadmin") {
            return res.status(403).json({ error: "Not authorized" });
        }
        const db = await getDb();
        const r = await db.collection("users").deleteOne({ username: req.params.username });
        res.json({ ok: true, deleted: r.deletedCount || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});



// GET /admin/overrides
app.get("/admin/overrides", verifyToken, async (req, res) => {
    try {
        const db = await getDb();
        const q = (req.query.q || "").trim();
        const filter = {};
        if (q) filter.$text = { $search: q };
        const out = await db.collection("faq_overrides")
            .find(filter)
            .project({ question: 1, normQuestion: 1, answer: 1, assistantContent: 1, force: 1, reviewer: 1, updatedAt: 1, createdAt: 1, sid: 1 })
            .sort({ updatedAt: -1 })
            .limit(500)
            .toArray();
        res.json({ ok: true, rows: out });
    } catch (e) {
        console.error("GET /admin/overrides error:", e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

// GET /admin/override/:id
app.get("/admin/override/:id", verifyToken, async (req, res) => {
    try {
        const id = req.params.id;
        if (!id) return res.status(400).json({ error: "Missing id" });

        const oid = toObjectId(id);
        if (!oid) return res.status(400).json({ error: "Invalid id" });

        const db = await getDb();
        const doc = await db.collection("faq_overrides").findOne({ _id: oid });
        if (!doc) return res.status(404).json({ error: "Not found" });
        res.json({ ok: true, doc });
    } catch (e) {
        console.error("GET /admin/override/:id error:", e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

// POST /admin/override (create/upsert by normQuestion)
app.post("/admin/override", verifyToken, async (req, res) => {
    try {
        const { question, answer, assistantContent = null, force = false, reviewer = null, sid = null } = req.body || {};
        if (!question || !answer) return res.status(400).json({ error: "Missing question or answer" });

        const db = await getDb();
        const clean = question.trim();
        const norm = clean.toLowerCase();
        const now = new Date();

        let questionEmbedding = null;
        try { questionEmbedding = await embed(norm); } catch (err) { /* continue without embedding */ }

        const setDoc = {
            question: clean,
            normQuestion: norm,
            answer,
            assistantContent: assistantContent || null,
            reviewer: reviewer || req.adminUser || "admin",
            force: !!force,
            sid: sid || null,
            updatedAt: now,
            ...(questionEmbedding ? { questionEmbedding } : {})
        };

        await db.collection("faq_overrides").updateOne(
            { normQuestion: norm },
            { $set: setDoc, $setOnInsert: { createdAt: now } },
            { upsert: true }
        );

        res.json({ ok: true });
    } catch (e) {
        console.error("POST /admin/override error:", e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

// PATCH /admin/override/:id
app.patch("/admin/override/:id", verifyToken, async (req, res) => {
    try {
        const id = req.params.id;
        if (!id) return res.status(400).json({ error: "Missing id" });

        const oid = toObjectId(id);
        if (!oid) return res.status(400).json({ error: "Invalid id" });

        const { question, answer, assistantContent, force, reviewer, sid } = req.body || {};
        const db = await getDb();

        const set = {};
        if (typeof question === "string" && question.trim()) {
            set.question = question.trim();
            set.normQuestion = question.trim().toLowerCase();
        }
        if (typeof answer === "string") set.answer = answer;
        if (typeof assistantContent === "string") set.assistantContent = assistantContent;
        if (typeof force !== "undefined") set.force = !!force;
        if (typeof reviewer !== "undefined") set.reviewer = reviewer;
        if (typeof sid !== "undefined") set.sid = sid;
        if (!Object.keys(set).length) return res.status(400).json({ error: "Nothing to update" });

        if (set.normQuestion) {
            try {
                const emb = await embed(set.normQuestion);
                if (Array.isArray(emb) && emb.length) set.questionEmbedding = emb;
            } catch (err) { /* ignore embedding failure */ }
        }

        set.updatedAt = new Date();
        await db.collection("faq_overrides").updateOne({ _id: oid }, { $set: set });

        const doc = await db.collection("faq_overrides").findOne({ _id: oid });
        res.json({ ok: true, doc });
    } catch (e) {
        console.error("PATCH /admin/override/:id error:", e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

// DELETE /admin/override/:id
app.delete("/admin/override/:id", verifyToken, async (req, res) => {
    try {
        const id = req.params.id;
        if (!id) return res.status(400).json({ error: "Missing id" });

        const oid = toObjectId(id);
        if (!oid) return res.status(400).json({ error: "Invalid id" });

        const db = await getDb();
        const r = await db.collection("faq_overrides").deleteOne({ _id: oid });
        res.json({ ok: true, deleted: r.deletedCount || 0 });
    } catch (e) {
        console.error("DELETE /admin/override/:id error:", e);
        res.status(500).json({ error: e.message || String(e) });
    }
});
// POST /admin/compare-models
// Body: { q: "question text", models: ["gpt-4o-mini","gpt-4o","gpt-3.5-turbo"] }
app.post("/admin/compare-models", verifyToken, async (req, res) => {
    try {
        const { q = "", models = [] } = req.body || {};
        if (!q || !Array.isArray(models) || models.length === 0) {
            return res.status(400).json({ error: "Missing question or models array" });
        }

        // small helper to build the prompt (you can expand to include context/history)
        const system = "You are Temple Law’s website assistant. Answer briefly and clearly using your general knowledge. If you are unsure, say 'I don't know'.";

        // build shared messages
        const messages = [
            { role: "system", content: system },
            { role: "user", content: `Question: ${q}\n\nAnswer succinctly.` }
        ];

        // call all models concurrently (map to promises)
        const calls = models.map(async (model) => {
            try {
                const resp = await axios.post(
                    "https://api.openai.com/v1/responses",
                    {
                        model,
                        input: messages,
                        temperature: 0.2,
                        max_output_tokens: 500
                    },
                    {
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
                        }
                    }
                );

                // extract textual answer
                let answer = "";
                if (resp.data.output_text) answer = resp.data.output_text;
                else if (Array.isArray(resp.data.output)) {
                    answer = resp.data.output.map(o => {
                        if (Array.isArray(o.content)) return o.content.map(c => c.text ?? "").join("");
                        if (o.content && typeof o.content === "string") return o.content;
                        return "";
                    }).join("\n");
                } else if (resp.data.choices && resp.data.choices[0]?.message?.content) {
                    answer = resp.data.choices[0].message.content;
                }

                // attempt to gather sources if any were returned in metadata (best-effort)
                let sources = [];
                // some of your flows attach 'sources' field — try to parse
                if (resp.data?.metadata?.sources && Array.isArray(resp.data.metadata.sources)) {
                    sources = resp.data.metadata.sources;
                }

                return { model, answer: (answer || "").trim(), sources, ts: new Date().toISOString() };
            } catch (err) {
                console.error("compare-models call failed for", model, err?.response?.data || err.message || err);
                return { model, answer: `Error: ${err?.response?.data?.error?.message || err.message || String(err)}`, sources: [], ts: new Date().toISOString() };
            }
        });

        const results = await Promise.all(calls);
        return res.json({ ok: true, results });
    } catch (e) {
        console.error("POST /admin/compare-models error:", e.stack || e);
        return res.status(500).json({ error: e.message || String(e) });
    }
});

// ---------------------------------------------------------------------
const PORT = process.env.PORT || 8790;
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
