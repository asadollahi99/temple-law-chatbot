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
    "https://templelawwidget.onrender.com"
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
async function appendTurn(db, sid, { role, content, sources = [], meta = {} }) {
    const now = new Date();
    await db.collection("sessions").updateOne(
        { sid },
        {
            $setOnInsert: { sid, createdAt: now },
            $push: { history: { role, content, sources, ts: now, ...meta } },
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
app.post("/ask", async (req, res) => {
    try {
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

        // Load short history for conversational grounding
        const history = await loadHistory(db, sid);
        const lastUser = [...history].reverse().find(m => m.role === "user")?.content || "";
        const retrievalQuery = lastUser ? `${query} (context: ${lastUser.slice(0, 400)})` : query;

        // 1) Embed query
        //const qvec = await embed(retrievalQuery);

        // Normalize user question using GPT before embedding
        const normRes = await axios.post(
            "https://api.openai.com/v1/responses",
            {
                model: "gpt-4o-mini",
                input: `Rewrite this question in clear, grammatically correct English (keep meaning same): ${query}`
            },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );
        const normalizedQuery = normRes.data.output_text?.trim() || query;
        console.log("Normalized query:", normalizedQuery);

        const qvec = await embed(normalizedQuery);

        // 2) Prefilter candidate chunks (text index or regex fallback)
        const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3))];
        let prefilter = [];
        if (words.length) {
            prefilter = await db.collection("chunks")
                .find({ $text: { $search: words.join(" ") } })
                .project({ embedding: 1, text: 1, url: 1 })
                .limit(400)
                .toArray()
                .catch(async () => {
                    const or = words.map(w => ({ text: new RegExp(`\\b${w}\\b`, "i") }));
                    return db.collection("chunks").find({ $or: or }).limit(400).toArray();
                });
        }
        if (!prefilter.length) {
            prefilter = await db.collection("chunks")
                .find({})
                .project({ embedding: 1, text: 1, url: 1 })
                .limit(400)
                .toArray();
        }

        // 3) Rank by cosine & select top
        const ranked = prefilter.map(c => ({
            url: c.url, text: c.text, score: cosine(qvec, c.embedding)
        })).sort((a, b) => b.score - a.score);
        if (ranked[0]?.score < 0.6) {
            console.warn("Low embedding similarity detected — using keyword fallback for:", query);
            const keyword = await db.collection("chunks")
                .find({ text: { $regex: query, $options: "i" } })
                .project({ text: 1, url: 1, embedding: 1 })
                .limit(3)
                .toArray();
            ranked.push(...keyword.map(k => ({ ...k, score: 0.99 })));
        }
        const MIN_SIM = 0.2;
        let top = ranked.filter(r => r.score >= MIN_SIM).slice(0, 12);
        if (!top.length) top = ranked.slice(0, 12);

        const context = top.map((t, i) => `Source ${i + 1}:\n${t.text}\n(URL: ${t.url})`).join("\n\n");
        console.log("Query:", query);
        console.log("Top retrieved chunks:");
        for (const r of ranked.slice(0, 10)) {
            console.log(`→ Score: ${r.score.toFixed(3)} | ${r.url}`);
            console.log(r.text.slice(0, 200).replace(/\n+/g, " ") + "...");
        }
        console.log("Selected top context URLs:", top.map(t => t.url));
        // 4) Call OpenAI (Responses API)
        const system =
            "You are Temple Law’s website assistant. Answer ONLY using the context below (from law.temple.edu). " +
            "If the answer isn't present, say you don’t know and suggest the closest relevant Temple Law page. " +
            "Always cite the page URLs in parentheses.";

        const messages = [
            { role: "system", content: system },
            ...history.map(h => ({ role: h.role, content: h.content })),
            { role: "user", content: `Question: ${query}\n\n=== WEBSITE CONTEXT START ===\n${context}\n=== WEBSITE CONTEXT END ===` }
        ];

        const r = await axios.post(
            "https://api.openai.com/v1/responses",
            { model: "gpt-4o", input: messages, temperature: 0.2, max_output_tokens: 500 },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );

        const answer =
            r.data.output_text ??
            (Array.isArray(r.data.output)
                ? r.data.output.map(o =>
                    Array.isArray(o.content) ? o.content.map(c => (c.text ?? "")).join("") : ""
                ).join("\n")
                : "") ??
            (r.data.choices && r.data.choices[0]?.message?.content) ??
            "I couldn't find relevant info in the provided pages.";

        const sources = top.map(t => t.url);

        // Save assistant turn
        await appendTurn(db, sid, { role: "assistant", content: answer, sources });

        return res.json({ sid, answer, sources });
    } catch (e) {
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
                            count: { $size: { $ifNull: ["$history", []] } }
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
