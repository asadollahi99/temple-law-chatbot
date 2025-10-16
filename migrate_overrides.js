// scripts/migrate_overrides.js
import { getDb } from "../db.mjs";   // adjust path as needed
import embed from "../embeddings.mjs"; // or whatever your embed util is
import crypto from "crypto";

(async () => {
    const db = await getDb();
    const cur = await db.collection("faq_overrides").find({}).toArray();
    console.log("Found", cur.length, "override docs.");
    for (const d of cur) {
        const q = (d.question || "").trim();
        const norm = q.toLowerCase();
        const upd = { normQuestion: norm };
        try {
            const emb = await embed(norm);
            if (emb && emb.length) upd.questionEmbedding = emb;
        } catch (err) {
            console.warn("Embedding failed for:", norm, err.message || err);
        }
        upd.updatedAt = new Date();
        await db.collection("faq_overrides").updateOne({ _id: d._id }, { $set: upd });
        console.log("Updated doc:", d._id.toString());
    }
    // optional: create index
    await db.collection("faq_overrides").createIndex({ normQuestion: 1 });
    console.log("Migration done.");
    process.exit(0);
})();
