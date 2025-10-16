// server/index.mjs
import dotenv from "dotenv"; dotenv.config();
import express from "express";
import morgan from "morgan";
import axios from "axios";
import cors from "cors";
import crypto from "crypto";

import { getDb } from "./db.mjs";
import { embed, cosine } from "./embeddings.mjs";
import { collectFromSitemap, indexUrl } from "./indexer.mjs";

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
    allowedHeaders: ["Content-Type", "x-admin-token"],
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
import { randomUUID } from "crypto"; // add this near the top of the file

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
})();

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
// app.post("/ask", async (req, res) => {
//     try {
//         const { q = "", sid: clientSid } = req.body || {};
//         const query = (q || "").trim();
//         if (!query) return res.status(400).json({ error: "Empty question" });

//         const sid = clientSid || crypto.randomUUID();
//         const db = await getDb();

//         // Save user turn
//         await appendTurn(db, sid, {
//             role: "user",
//             content: query,
//             meta: { ip: req.ip, ua: req.headers["user-agent"] || "" }
//         });

//         // ✅ Handle "Explain more" intelligently
//         let normalizedQuery = query;
//         if (/^(explain|tell|say)\s+more/i.test(query)) {
//             // load session history
//             const s = await db.collection("sessions").findOne({ sid });
//             if (s?.history?.length) {
//                 // find last assistant message that had a real answer
//                 const lastAssistant = [...s.history].reverse().find(
//                     h => h.role === "assistant" && h.content && !/conversation reset/i.test(h.content)
//                 );
//                 const lastUser = [...s.history].reverse().find(
//                     h => h.role === "user" && h.content && h.content !== query
//                 );

//                 // combine context
//                 const context = [
//                     lastUser?.content ? `Previous question: ${lastUser.content}` : "",
//                     lastAssistant?.content ? `Previous answer: ${lastAssistant.content}` : ""
//                 ].filter(Boolean).join("\n");

//                 normalizedQuery = `Please elaborate on the previous topic.\n${context}`;
//                 console.log("Expanded 'explain more' →", normalizedQuery);
//             }
//         }

//         // Load short history for conversational grounding
//         const history = await loadHistory(db, sid);
//         const lastUser = [...history].reverse().find(m => m.role === "user")?.content || "";
//         //const retrievalQuery = lastUser ? `${query} (context: ${lastUser.slice(0, 400)})` : query;

//         // 1) Embed query
//         //const qvec = await embed(retrievalQuery);

//         // Normalize user question using GPT before embedding
//         // --- Normalize user question ---
//         const normRes = await axios.post(
//             "https://api.openai.com/v1/responses",
//             {
//                 model: "gpt-4o-mini",
//                 input: [
//                     {
//                         role: "system",
//                         content: "You are a grammar normalizer. Fix grammar and phrasing but keep meaning identical."
//                     },
//                     {
//                         role: "user",
//                         content: query
//                     }
//                 ],
//                 temperature: 0
//             },
//             { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
//         );

//         const normalizedQuery =
//             normRes.data.output?.[0]?.content?.[0]?.text?.trim() || query;

//         console.log("Normalized query:", normalizedQuery);

//         const qvec = await embed(normalizedQuery);
//         if (qvec.length !== 1536) {
//             console.error("Bad embedding length:", qvec.length);
//         }

//         // 2) Prefilter candidate chunks (text index or regex fallback)
//         /*const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3))];
//         let prefilter = [];
//         // if (words.length) {
//         //     prefilter = await db.collection("chunks")
//         //         .find({ $text: { $search: words.join(" ") } })
//         //         .project({ embedding: 1, text: 1, url: 1 })
//         //         .limit(400)
//         //         .toArray()
//         //         .catch(async () => {
//         //             const or = words.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
//         //             return db.collection("chunks").find({ $or: or }).limit(400).toArray();
//         //         });
//         // }
//         if (words.length) {
//             prefilter = await db.collection("chunks")
//                 .find({ $text: { $search: words.join(" ") } })
//                 .project({ embedding: 1, text: 1, url: 1 })
//                 .limit(400)
//                 .toArray()
//                 .catch(async () => {
//                     const or = words.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
//                     return db.collection("chunks").find({ $or: or }).limit(400).toArray();
//                 });
//         }

//         //fallback: always include academic calendar pages if question mentions schedule/start
//         const qLower = query.toLowerCase();
//         if (
//             qLower.includes("school start") ||
//             qLower.includes("classes start") ||
//             qLower.includes("semester") ||
//             qLower.includes("academic calendar") ||
//             qLower.includes("term start")
//         ) {
//             const calendarDocs = await db.collection("chunks")
//                 .find({ url: { $regex: "academic-calendar", $options: "i" } })
//                 .project({ embedding: 1, text: 1, url: 1 })
//                 .toArray();
//             prefilter.push(...calendarDocs);
//         }
//         */
//         const words = [...new Set(
//             normalizedQuery.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3)
//         )];
//         let prefilter = [];
//         const synonyms = {
//             start: ["begin", "open", "commence"],
//             finish: ["end", "close", "complete"],
//             refund: ["withdrawal", "reimbursement", "money back"],
//             tuition: ["fees", "payment", "billing", "cost"],
//             academic: ["school", "semester", "classes"],
//             calendar: ["schedule", "term", "dates"],
//             law: ["temple law", "beasley school of law"],
//             policy: ["rule", "procedure", "guideline"],
//         };

//         let expanded = new Set(words);
//         for (const w of words) {
//             if (synonyms[w]) synonyms[w].forEach(s => expanded.add(s));
//         }

//         // Replace words with expanded set
//         const expandedWords = [...expanded];
//         if (expandedWords.length) {
//             try {
//                 prefilter = await db.collection("chunks")
//                     .find({ $text: { $search: expandedWords.join(" ") } })
//                     .project({ embedding: 1, text: 1, url: 1 })
//                     .limit(400)
//                     .toArray();
//             } catch {
//                 const or = expandedWords.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
//                 prefilter = await db.collection("chunks").find({ $or: or }).limit(400).toArray();
//             }
//         }

//         // Universal semantic fallback
//         // If $text yields too few hits (<30), add extra semantic context pages
//         if (prefilter.length < 30) {
//             const keywordPool = ["academic", "calendar", "semester", "schedule", "start", "dates", "program", "tuition", "policy", "admissions"];
//             const orExtra = keywordPool.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
//             const extras = await db.collection("chunks")
//                 .find({ $or: orExtra })
//                 .project({ embedding: 1, text: 1, url: 1 })
//                 .limit(100)
//                 .toArray();
//             prefilter.push(...extras);
//         }
//         if (!prefilter.length) {
//             prefilter = await db.collection("chunks")
//                 .find({})
//                 .project({ embedding: 1, text: 1, url: 1 })
//                 .limit(400)
//                 .toArray();
//         }

//         // 3) Rank by cosine & select top
//         // const ranked = prefilter.map(c => ({
//         //     url: c.url, text: c.text, score: cosine(qvec, c.embedding)
//         // })).sort((a, b) => b.score - a.score);
//         // if (ranked[0]?.score < 0.6) {
//         //     console.warn("Low embedding similarity detected — using keyword fallback for:", query);
//         //     const keyword = await db.collection("chunks")
//         //         .find({ text: { $regex: query, $options: "i" } })
//         //         .project({ text: 1, url: 1, embedding: 1 })
//         //         .limit(3)
//         //         .toArray();
//         //     ranked.push(...keyword.map(k => ({ ...k, score: 0.99 })));
//         // }
//         // const MIN_SIM = 0.15;
//         // let top = ranked.filter(r => r.score >= MIN_SIM).slice(0, 12);
//         // if (!top.length) top = ranked.slice(0, 12);

//         // const context = top.map((t, i) => `Source ${i + 1}:\n${t.text}\n(URL: ${t.url})`).join("\n\n");
//         const ranked = prefilter.map(c => {
//             const emb = Array.isArray(c.embedding) ? c.embedding.map(Number) : [];
//             return {
//                 url: c.url,
//                 text: c.text,
//                 score: cosine(qvec, emb)
//             };
//         }).sort((a, b) => b.score - a.score);
//         const topChunk = prefilter.find(c => c.url?.includes("academic-calendar"));
//         if (topChunk) {
//             const test = cosine(qvec, topChunk.embedding.map(Number));
//             console.log("Cosine with academic-calendar:", test);
//         }
//         // const ranked = prefilter.map(c => ({
//         //     url: c.url,
//         //     text: c.text,
//         //     score: cosine(qvec, c.embedding)
//         // })).sort((a, b) => b.score - a.score);

//         // Log for debug
//         console.log("Top 3 similarity scores:", ranked.slice(0, 3).map(r => r.score.toFixed(3)));

//         // If all scores are low (<0.45), fallback to keyword search
//         if (!ranked.length || ranked[0].score < 0.45) {
//             console.warn("Low embedding similarity detected — triggering keyword fallback for:", normalizedQuery);
//             const keyword = await db.collection("chunks")
//                 .find({ text: { $regex: normalizedQuery, $options: "i" } })
//                 .project({ text: 1, url: 1, embedding: 1 })
//                 .limit(5)
//                 .toArray();
//             ranked.push(...keyword.map(k => ({ ...k, score: 0.9 })));
//         }

//         // Relaxed threshold for selection
//         const MIN_SIM = 0.12;
//         let top = ranked.filter(r => r.score >= MIN_SIM).slice(0, 12);
//         if (!top.length) top = ranked.slice(0, 12);

//         // Normalize repeated queries: lowercased, trimmed
//         const context = top.map((t, i) => `Source ${i + 1}:\n${t.text.trim().toLowerCase()}\n(URL: ${t.url})`).join("\n\n");
//         console.log("Query:", query);
//         console.log("Top retrieved chunks:");
//         for (const r of ranked.slice(0, 10)) {
//             console.log(`→ Score: ${r.score.toFixed(3)} | ${r.url}`);
//             console.log(r.text.slice(0, 200).replace(/\n+/g, " ") + "...");
//         }
//         console.log("Selected top context URLs:", top.map(t => t.url));
//         // 4) Call OpenAI (Responses API)
//         const system =
//             "You are Temple Law’s website assistant. Answer ONLY using the context below (from law.temple.edu). " +
//             "If the answer isn't present, say you don’t know and suggest the closest relevant Temple Law page. " +
//             "Always cite the page URLs in parentheses.";

//         const messages = [
//             { role: "system", content: system },
//             ...history.map(h => ({ role: h.role, content: h.content })),
//             { role: "user", content: `Question: ${query}\n\n=== WEBSITE CONTEXT START ===\n${context}\n=== WEBSITE CONTEXT END ===` }
//         ];

//         const r = await axios.post(
//             "https://api.openai.com/v1/responses",
//             { model: "gpt-4o-mini", input: messages, temperature: 0.2, max_output_tokens: 500 },
//             { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
//         );

//         const answer =
//             r.data.output_text ??
//             (Array.isArray(r.data.output)
//                 ? r.data.output.map(o =>
//                     Array.isArray(o.content) ? o.content.map(c => (c.text ?? "")).join("") : ""
//                 ).join("\n")
//                 : "") ??
//             (r.data.choices && r.data.choices[0]?.message?.content) ??
//             "I couldn't find relevant info in the provided pages.";

//         const sources = top.map(t => t.url);

//         // Save assistant turn
//         const mid = crypto.randomUUID();
//         await db.collection("sessions").updateOne(
//             { sid },
//             {
//                 $push: {
//                     history: { mid, role: "assistant", content: answer, sources, ts: new Date() }
//                 },
//                 $set: { updatedAt: new Date() }
//             },
//             { upsert: true }
//         );
//         return res.json({ sid, answer, sources, mid });

//     } catch (e) {
//         return res.status(500).json({ error: e.message || String(e) });
//     }
// });
// app.post("/ask", async (req, res) => {
//     try {
//         const override = await db.collection("faq_overrides").findOne(
//             { $text: { $search: query } },
//             { projection: { answer: 1 } }
//         );
//         if (override) {
//             console.log("Returning reviewed override answer for:", query);
//             const mid = crypto.randomUUID();
//             await appendTurn(db, sid, {
//                 role: "assistant",
//                 content: override.answer,
//                 sources: ["Reviewed Answer"],
//                 meta: { override: true }
//             });
//             return res.json({ sid, answer: override.answer, sources: ["Reviewed Answer"], mid });
//         }
//         const { q = "", sid: clientSid } = req.body || {};
//         const query = (q || "").trim();
//         if (!query) return res.status(400).json({ error: "Empty question" });

//         const sid = clientSid || crypto.randomUUID();
//         const db = await getDb();

//         // Save user turn
//         await appendTurn(db, sid, {
//             role: "user",
//             content: query,
//             meta: { ip: req.ip, ua: req.headers["user-agent"] || "" }
//         });

//         // ✅ STEP 1: Handle "Explain more" intelligently
//         let expandedQuery = query;
//         if (/^(explain|tell|say)\s+more/i.test(query)) {
//             const s = await db.collection("sessions").findOne({ sid });
//             if (s?.history?.length) {
//                 const lastAssistant = [...s.history].reverse().find(
//                     h => h.role === "assistant" && h.content && !/conversation reset/i.test(h.content)
//                 );
//                 const lastUser = [...s.history].reverse().find(
//                     h => h.role === "user" && h.content && h.content !== query
//                 );

//                 const context = [
//                     lastUser?.content ? `Previous question: ${lastUser.content}` : "",
//                     lastAssistant?.content ? `Previous answer: ${lastAssistant.content}` : ""
//                 ].filter(Boolean).join("\n");

//                 expandedQuery = `Please elaborate on the previous topic.\n${context}`;
//                 console.log("Expanded 'explain more' →", expandedQuery);
//             }
//         }

//         // Load short history for conversational grounding
//         const history = await loadHistory(db, sid);

//         //  STEP 2: Normalize user query (grammar fix) but KEEP expanded meaning
//         const normRes = await axios.post(
//             "https://api.openai.com/v1/responses",
//             {
//                 model: "gpt-4o-mini",
//                 input: [
//                     {
//                         role: "system",
//                         content: "You are a grammar normalizer. Fix grammar and phrasing but keep meaning identical."
//                     },
//                     {
//                         role: "user",
//                         content: expandedQuery
//                     }
//                 ],
//                 temperature: 0
//             },
//             { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
//         );

//         const normalizedQuery =
//             normRes.data.output?.[0]?.content?.[0]?.text?.trim() || expandedQuery;

//         console.log("Normalized query:", normalizedQuery);

//         // STEP 3: Embed normalized (and expanded if needed) query
//         const qvec = await embed(normalizedQuery);
//         if (qvec.length !== 1536) {
//             console.error("Bad embedding length:", qvec.length);
//         }

//         //  STEP 4: Keyword expansion for retrieval
//         const words = [...new Set(
//             normalizedQuery.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3)
//         )];

//         let prefilter = [];
//         const synonyms = {
//             start: ["begin", "open", "commence"],
//             finish: ["end", "close", "complete"],
//             refund: ["withdrawal", "reimbursement", "money back"],
//             tuition: ["fees", "payment", "billing", "cost"],
//             academic: ["school", "semester", "classes"],
//             calendar: ["schedule", "term", "dates"],
//             law: ["temple law", "beasley school of law"],
//             policy: ["rule", "procedure", "guideline"],
//         };

//         let expanded = new Set(words);
//         for (const w of words) {
//             if (synonyms[w]) synonyms[w].forEach(s => expanded.add(s));
//         }

//         const expandedWords = [...expanded];
//         if (expandedWords.length) {
//             try {
//                 prefilter = await db.collection("chunks")
//                     .find({ $text: { $search: expandedWords.join(" ") } })
//                     .project({ embedding: 1, text: 1, url: 1 })
//                     .limit(400)
//                     .toArray();
//             } catch {
//                 const or = expandedWords.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
//                 prefilter = await db.collection("chunks").find({ $or: or }).limit(400).toArray();
//             }
//         }

//         //  STEP 5: Add semantic fallback if too few hits
//         // if (prefilter.length < 30) {
//         //     const keywordPool = [
//         //         "academic", "calendar", "semester", "schedule",
//         //         "start", "dates", "program", "tuition", "policy", "admissions"
//         //     ];
//         //     const orExtra = keywordPool.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
//         //     const extras = await db.collection("chunks")
//         //         .find({ $or: orExtra })
//         //         .project({ embedding: 1, text: 1, url: 1 })
//         //         .limit(100)
//         //         .toArray();
//         //     prefilter.push(...extras);
//         // }
//         //  If too few matches, add contextually relevant fallback pages
//         if (prefilter.length < 30) {
//             const keywordPool = [
//                 "academic", "calendar", "semester", "schedule",
//                 "start", "dates", "program", "tuition", "policy", "admissions",
//                 "environmental", "energy", "climate", "sustainability", "law"
//             ];
//             const orExtra = keywordPool.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
//             const extras = await db.collection("chunks")
//                 .find({ $or: orExtra })
//                 .project({ embedding: 1, text: 1, url: 1 })
//                 .limit(100)
//                 .toArray();
//             prefilter.push(...extras);
//         }

//         //  Force-include Environmental Law page if relevant
//         const qLower = normalizedQuery.toLowerCase();
//         if (
//             qLower.includes("environmental law") ||
//             qLower.includes("energy") ||
//             qLower.includes("climate") ||
//             qLower.includes("sustainability")
//         ) {
//             const envDocs = await db.collection("chunks")
//                 .find({ url: { $regex: "environmental-law", $options: "i" } })
//                 .project({ embedding: 1, text: 1, url: 1 })
//                 .toArray();
//             if (envDocs.length) {
//                 console.log(`✅ Injected ${envDocs.length} Environmental Law chunks.`);
//                 prefilter.push(...envDocs);
//             }
//         }

//         if (!prefilter.length) {
//             prefilter = await db.collection("chunks")
//                 .find({})
//                 .project({ embedding: 1, text: 1, url: 1 })
//                 .limit(400)
//                 .toArray();
//         }

//         //  STEP 6: Rank by cosine similarity
//         const ranked = prefilter.map(c => {
//             const emb = Array.isArray(c.embedding) ? c.embedding.map(Number) : [];
//             return {
//                 url: c.url,
//                 text: c.text,
//                 score: cosine(qvec, emb)
//             };
//         }).sort((a, b) => b.score - a.score);

//         console.log("Top 3 similarity scores:", ranked.slice(0, 3).map(r => r.score.toFixed(3)));

//         //  STEP 7: Fallback for low-similarity queries
//         // if (!ranked.length || ranked[0].score < 0.45) {
//         //     console.warn("Low embedding similarity detected — triggering keyword fallback for:", normalizedQuery);
//         //     const keyword = await db.collection("chunks")
//         //         .find({ text: { $regex: normalizedQuery, $options: "i" } })
//         //         .project({ text: 1, url: 1, embedding: 1 })
//         //         .limit(5)
//         //         .toArray();
//         //     ranked.push(...keyword.map(k => ({ ...k, score: 0.9 })));
//         // }

//         //  SMART FALLBACK: deep retrieval if repeated low-similarity
//         if (!ranked.length || ranked[0].score < 0.45) {
//             console.warn("Low embedding similarity detected — triggering deep retrieval for:", normalizedQuery);

//             // Look at previous assistant turn — if last answer was also "I don't know", we go deep
//             const session = await db.collection("sessions").findOne({ sid });
//             const lastAssistant = [...(session?.history || [])].reverse().find(h => h.role === "assistant");

//             let deepMode = false;
//             if (lastAssistant && /i don't know/i.test(lastAssistant.content)) {
//                 deepMode = true;
//                 console.log("Deep retrieval mode activated — expanding search to entire law.temple.edu index");
//             }

//             // If deepMode: search entire collection (not limited prefilter)
//             let fallbackDocs = [];
//             if (deepMode) {
//                 fallbackDocs = await db.collection("chunks")
//                     .find({ text: { $regex: ".", $options: "i" } }) // match all
//                     .project({ text: 1, url: 1, embedding: 1 })
//                     .limit(1500)
//                     .toArray();
//             } else {
//                 fallbackDocs = await db.collection("chunks")
//                     .find({ text: { $regex: normalizedQuery, $options: "i" } })
//                     .project({ text: 1, url: 1, embedding: 1 })
//                     .limit(100)
//                     .toArray();
//             }

//             // Rank and merge into main set
//             const rescored = fallbackDocs.map(doc => ({
//                 url: doc.url,
//                 text: doc.text,
//                 score: cosine(qvec, doc.embedding.map(Number))
//             }));
//             ranked.push(...rescored.sort((a, b) => b.score - a.score).slice(0, 15));

//             // Optional: annotate in the logs
//             console.log(`Deep retrieval results: ${ranked.length} chunks re-ranked.`);
//         }
//         const MIN_SIM = 0.12;
//         let top = ranked.filter(r => r.score >= MIN_SIM).slice(0, 12);
//         if (!top.length) top = ranked.slice(0, 12);

//         const context = top.map(
//             (t, i) => `Source ${i + 1}:\n${t.text.trim().toLowerCase()}\n(URL: ${t.url})`
//         ).join("\n\n");

//         console.log("Query:", query);
//         console.log("Top retrieved chunks:");
//         for (const r of ranked.slice(0, 10)) {
//             console.log(`→ Score: ${r.score.toFixed(3)} | ${r.url}`);
//             console.log(r.text.slice(0, 200).replace(/\n+/g, " ") + "...");
//         }

//         //  STEP 8: Generate answer using OpenAI
//         // const system =
//         //     "You are Temple Law’s website assistant. Answer ONLY using the context below (from law.temple.edu). " +
//         //     "If the answer isn't present, say you don’t know and suggest the closest relevant Temple Law page. " +
//         //     "Always cite the page URLs in parentheses.";
//         const system = "You are Temple Law’s website assistant.Answer ONLY using the context below (from law.temple.edu).\
//                         If the context seems insufficient, search across the full law.temple.edu website(already indexed) before saying you don't know. \
//                         If still missing, suggest the most relevant Temple Law page or section."


//         const messages = [
//             { role: "system", content: system },
//             ...history.map(h => ({ role: h.role, content: h.content })),
//             { role: "user", content: `Question: ${normalizedQuery}\n\n=== WEBSITE CONTEXT START ===\n${context}\n=== WEBSITE CONTEXT END ===` }
//         ];

//         // const r = await axios.post(
//         //     "https://api.openai.com/v1/responses",
//         //     { model: "gpt-4o-mini", input: messages, temperature: 0.2, max_output_tokens: 500 },
//         //     { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
//         // );
//         const r = await axios.post(
//             "https://api.openai.com/v1/responses",
//             {
//                 model: "gpt-4o-mini",
//                 input: messages,
//                 temperature: 0.2,
//                 max_output_tokens: 500,
//             },
//             {
//                 headers: {
//                     "Content-Type": "application/json",
//                     Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
//                 },
//             }
//         );

//         const answer =
//             r.data.output_text ??
//             (Array.isArray(r.data.output)
//                 ? r.data.output.map(o =>
//                     Array.isArray(o.content)
//                         ? o.content.map(c => c.text ?? "").join("")
//                         : ""
//                 ).join("\n")
//                 : "") ??
//             (r.data.choices && r.data.choices[0]?.message?.content) ??
//             "I couldn't find relevant info in the provided pages.";

//         const sources = top.map(t => t.url);

//         //  STEP 9: Save assistant turn
//         const mid = crypto.randomUUID();
//         await db.collection("sessions").updateOne(
//             { sid },
//             {
//                 $push: {
//                     history: { mid, role: "assistant", content: answer, sources, ts: new Date() }
//                 },
//                 $set: { updatedAt: new Date() }
//             },
//             { upsert: true }
//         );

//         return res.json({ sid, answer, sources, mid });

//     } catch (e) {
//         return res.status(500).json({ error: e.message || String(e) });
//     }
// });
// IMPORTANT: replace your existing /ask handler with this block
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

        // STEP: keyword expansion and prefilter (unchanged)
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

        // Force include environmental docs if relevant (unchanged)
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
        const SITE_THRESHOLD = 0.45;               // your existing threshold for trusting site content
        const OVERRIDE_EMB_THRESHOLD = 0.82;      // semantic similarity threshold to match admin override
        const normQuery = query.trim().toLowerCase();
        const topScore = ranked?.[0]?.score ?? 0;

        // 1) Try exact normalized question match
        let overrideDoc = null;
        try {
            overrideDoc = await db.collection("faq_overrides").findOne(
                { normQuestion: normQuery },
                { projection: { answer: 1, force: 1, reviewer: 1, questionEmbedding: 1, question: 1 } }
            );
        } catch (err) {
            console.warn("Override lookup (exact) failed:", err);
            overrideDoc = null;
        }

        // 2) If not found exactly, try semantic matching against admin overrides (embedding)
        if (!overrideDoc) {
            try {
                // fetch candidates that have embeddings (small collection expected)
                const candidates = await db.collection("faq_overrides")
                    .find({ questionEmbedding: { $exists: true } })
                    .project({ answer: 1, force: 1, reviewer: 1, questionEmbedding: 1, question: 1 })
                    .toArray();

                if (candidates.length && Array.isArray(qvec)) {
                    let best = null;
                    for (const c of candidates) {
                        if (!Array.isArray(c.questionEmbedding)) continue;
                        const emb = c.questionEmbedding.map(Number);
                        const sim = cosine(qvec, emb);
                        if (!best || sim > best.sim) best = { doc: c, sim };
                    }
                    if (best && best.sim >= OVERRIDE_EMB_THRESHOLD) {
                        console.log(`Matched override semantically (sim=${best.sim.toFixed(3)}):`, best.doc.question);
                        overrideDoc = best.doc;
                    } else {
                        console.log("No semantic override match (best sim):", best ? best.sim.toFixed(3) : "n/a");
                    }
                }
            } catch (err) {
                console.warn("Semantic override lookup failed:", err);
            }
        }

        // Logging for debugging
        console.log("normQuery:", normQuery);
        console.log("Top chunk score:", topScore.toFixed(3));
        console.log("overrideDoc (final):", overrideDoc ? { question: overrideDoc.question, force: overrideDoc.force } : null);

        // Decision rules (force first)
        if (overrideDoc && overrideDoc.force) {
            console.log("Using forced override for:", normQuery);
            const answer = overrideDoc.answer;
            const mid = crypto.randomUUID();
            await appendTurn(db, sid, { role: "assistant", content: answer, sources: ["Reviewed Answer"], meta: { override: true, reviewer: overrideDoc.reviewer, forced: true } });
            return res.json({ sid, answer, sources: ["Reviewed Answer"], mid });
        }

        // If site is confident, prefer site answer (do not use non-forced override)
        if (topScore >= SITE_THRESHOLD) {
            console.log("Site confident — using RAG/LLM answer (override not applied).");
        } else {
            // site not confident: use override if exists
            if (overrideDoc) {
                console.log("Site not confident — using admin override.");
                const answer = overrideDoc.answer;
                const mid = crypto.randomUUID();
                await appendTurn(db, sid, { role: "assistant", content: answer, sources: ["Reviewed Answer"], meta: { override: true, reviewer: overrideDoc.reviewer, forced: !!overrideDoc.force } });
                return res.json({ sid, answer, sources: ["Reviewed Answer"], mid });
            }
        }
        // else continue to LLM generation

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
// ---------------------------------------------------------------------
// Reviwe (correct a chat answer)
// ---------------------------------------------------------------------
// Admin review/save corrected answer (upsert with optional force flag)
// server: ctlawserver.js (or wherever /review is defined)
app.post("/review", requireAdmin, async (req, res) => {
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
            questionEmbedding = await embed(norm); // you already have embed() in your codebase
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
// ---------------------------------------------------------------------
app.post("/reset", async (req, res) => {
    const { sid } = req.body || {};
    if (!sid) return res.json({ ok: true });
    const db = await getDb();
    await db.collection("sessions").deleteOne({ sid });
    res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Feedback endpoint
// ---------------------------------------------------------------------
// app.post("/feedback", async (req, res) => {
//     try {
//         const { sid, index, correct, comment } = req.body || {};
//         if (!sid || typeof index !== "number")
//             return res.status(400).json({ error: "Missing sid or index" });

//         const db = await getDb();
//         const s = await db.collection("sessions").findOne({ sid });
//         if (!s) return res.status(404).json({ error: "Session not found" });

//         // Locate target message (index corresponds to its position in history)
//         const path = `history.${index}.feedback`;
//         await db.collection("sessions").updateOne(
//             { sid },
//             { $set: { [path]: { correct, comment, ts: new Date() } } }
//         );

//         res.json({ ok: true });
//     } catch (e) {
//         res.status(500).json({ error: e.message || String(e) });
//     }
// });


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


// ---------------------------------------------------------------------
// On-demand sitemap index (manual trigger)
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// History & Admin
// ---------------------------------------------------------------------
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

// List sessions (paged, filterable)
app.get("/admin/sessions", requireAdmin, async (req, res) => {
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

// Get one session (full history)
app.get("/admin/session/:sid", requireAdmin, async (req, res) => {
    const db = await getDb();
    const doc = await db.collection("sessions").findOne({ sid: req.params.sid });
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ sid: doc.sid, createdAt: doc.createdAt, updatedAt: doc.updatedAt, history: doc.history || [] });
});

// Export all sessions as NDJSON
app.get("/admin/export.ndjson", requireAdmin, async (req, res) => {
    const db = await getDb();
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    const cur = db.collection("sessions").find({}, { sort: { updatedAt: -1 } });
    for await (const doc of cur) res.write(JSON.stringify(doc) + "\n");
    res.end();
});

// Delete one session
app.delete("/admin/session/:sid", requireAdmin, async (req, res) => {
    const db = await getDb();
    const r = await db.collection("sessions").deleteOne({ sid: req.params.sid });
    res.json({ ok: true, deleted: r.deletedCount || 0 });
});

// ---------------------------------------------------------------------
const PORT = process.env.PORT || 8790;
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
