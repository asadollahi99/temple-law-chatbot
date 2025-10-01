import dotenv from "dotenv"; dotenv.config();
import axios from "axios";
import { getDb } from "./db.mjs";
import { extractCore, chunkText, sha256Hex } from "./extract.mjs";
import { embed } from "./embeddings.mjs";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";

// ---------- collect URLs from sitemap index ----------
// ---------- collect URLs from sitemap index (no deprecated deps) ----------
export async function collectFromSitemap(rootUrl, limit = 5000) {
    const urls = new Set();
    const seen = new Set();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

    async function fetchText(u) {
        const r = await axios.get(u, {
            timeout: 20000,
            headers: { "User-Agent": "Temple-Law-Indexer", "Accept": "application/xml,text/xml" },
            responseType: "text",
            validateStatus: s => s >= 200 && s < 400
        });
        return r.data;
    }

    async function walk(smUrl) {
        if (seen.has(smUrl) || urls.size >= limit) return;
        seen.add(smUrl);

        let xml; try { xml = await fetchText(smUrl); } catch { return; }
        let doc;
        try { doc = parser.parse(xml); } catch { return; }

        // Handle both sitemapindex and urlset (namespaced or not)
        const si = doc.sitemapindex || doc["sitemapindex"];
        const us = doc.urlset || doc["urlset"];

        if (si && si.sitemap) {
            const list = Array.isArray(si.sitemap) ? si.sitemap : [si.sitemap];
            for (const it of list) {
                const loc = (it.loc || "").trim();
                if (!loc) continue;
                if (urls.size >= limit) break;
                if (loc.endsWith(".xml") || loc.includes(".xml?")) {
                    await walk(loc);
                } else {
                    urls.add(normalize(loc));
                }
            }
            return;
        }

        if (us && us.url) {
            const list = Array.isArray(us.url) ? us.url : [us.url];
            for (const it of list) {
                const loc = (it.loc || "").trim();
                if (!loc) continue;
                if (urls.size >= limit) break;
                urls.add(normalize(loc));
            }
        }
    }

    const normalize = (u) => {
        try { const x = new URL(u); x.hash = ""; x.pathname = x.pathname.replace(/\/{2,}/g, "/"); return x.href; }
        catch { return u; }
    };

    await walk(rootUrl);
    return [...urls];
}


// ---------- index one URL ----------
async function indexUrl(db, url, deny = []) {
    if (deny.some(rx => rx.test(url))) return { url, skipped: true, reason: "deny" };

    let html;
    try {
        const r = await axios.get(url, { timeout: 20000, headers: { "User-Agent": "Temple-Law-Indexer" } });
        if (!/^text\/html/i.test(r.headers["content-type"] || "")) return { url, skipped: true, reason: "not-html" };
        html = r.data;
    } catch (e) {
        return { url, error: String(e.message || e) };
    }

    const { text, title } = extractCore(html);
    if (!text || text.length < 80) return { url, skipped: true, reason: "too-short" };

    const hash = sha256Hex(text);
    const pages = db.collection("pages");
    const chunksCol = db.collection("chunks");

    const prior = await pages.findOne({ url });
    if (prior && prior.hash === hash) {
        await pages.updateOne({ _id: prior._id }, { $set: { updatedAt: new Date() } });
        return { url, status: "unchanged", chunks: 0 };
    }

    // delete old chunks for this url
    await chunksCol.deleteMany({ url });

    const chunks = chunkText(text, 2000, 250).slice(0, 6);
    let added = 0;
    for (let i = 0; i < chunks.length; i++) {
        const e = await embed(chunks[i]);
        await chunksCol.insertOne({
            url,
            text: chunks[i],
            idx: i,
            embedding: e
        });
        added++;
    }

    await pages.updateOne(
        { url },
        { $set: { url, title, hash, updatedAt: new Date() } },
        { upsert: true }
    );

    return { url, status: prior ? "updated" : "added", chunks: added };
}

// ---------- CLI: node indexer.mjs <sitemapUrl> ----------
if (process.argv[1].endsWith("indexer.mjs")) {
    const sitemap = process.argv[2] || "https://law.temple.edu/sitemap_index.xml";
    const db = await getDb();

    const deny = [
        /\/wp-admin/i, /\/wp-json/i, /\/feed/i,
        /\.pdf$/i, /\.jpg$/i, /\.jpeg$/i, /\.png$/i, /\.gif$/i, /\.svg$/i,
        /twitter\.com/i, /facebook\.com/i, /linkedin\.com/i
    ];

    console.log("Collecting URLs from sitemap…");
    const urls = await collectFromSitemap(sitemap, 8000);
    console.log("Candidates:", urls.length);

    const limit = pLimit(3); // parallelism
    let done = 0, added = 0, updated = 0, unchanged = 0;
    for (const u of urls) {
        await limit(async () => {
            const r = await indexUrl(db, u, deny);
            if (r.status === "added") added++;
            else if (r.status === "updated") updated++;
            else if (r.status === "unchanged") unchanged++;
            done++;
            if (done % 20 === 0) console.log(`Indexed ${done}/${urls.length}`);
        });
    }
    await limit.clearQueue();

    console.log({ added, updated, unchanged, total: urls.length });
    process.exit(0);
}

export { indexUrl };
