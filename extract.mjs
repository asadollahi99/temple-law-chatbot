import * as cheerio from "cheerio";
import crypto from "crypto";

export function extractCore(html) {
    const $ = cheerio.load(html);
    $("script,style,noscript").remove();
    const title = $("title").first().text().trim();
    const h1 = $("h1").first().text().trim();
    const main = $("main").text().trim() || $("body").text().trim();
    const header = [title, h1].filter(Boolean).join(" — ");
    const text = `${header ? header + "\n\n" : ""}${main}`.replace(/\s+/g, " ").trim();
    return { text, title: title || h1 || "" };
}

export function chunkText(s, max = 2000, overlap = 250) {
    const out = []; const step = Math.max(1, max - overlap);
    for (let i = 0; i < s.length; i += step) {
        out.push(s.slice(i, i + max));
        if (i + max >= s.length) break;
    }
    return out;
}

export function sha256Hex(s) {
    return crypto.createHash("sha256").update(s).digest("hex");
}
