import { getDb } from "./db.mjs";
import { collectFromSitemap, indexUrl } from "./indexer.mjs";

const sitemap = "https://law.temple.edu/sitemap_index.xml";
const max = 2000;

const deny = [
    /\/wp-admin/i, /\/wp-json/i, /\/feed/i,
    /\.pdf$/i, /\.jpg$/i, /\.jpeg$/i, /\.png$/i, /\.gif$/i, /\.svg$/i,
    /twitter\.com/i, /facebook\.com/i, /linkedin\.com/i
];

(async () => {
    try {
        const db = await getDb();

        // clear old data
        await db.collection("pages").deleteMany({});
        await db.collection("chunks").deleteMany({});

        console.log("Cleared old pages & chunks ✅");

        // fetch sitemap URLs
        const urls = (await collectFromSitemap(sitemap, max))
            .filter(u => u.startsWith("https://law.temple.edu/"));

        console.log(`Found ${urls.length} URLs to index`);

        let added = 0, denied = 0, empty = 0, other = 0;
        const skippedUrls = [];

        for (let i = 0; i < urls.length; i++) {
            const u = urls[i];
            const r = await indexUrl(db, u, deny);

            if (r.status === "added") {
                added++;
            } else if (r.status === "denied") {
                denied++;
                skippedUrls.push({ url: u, reason: "denied" });
                console.log(`❌ DENIED: ${u}`);
            } else if (r.status === "empty") {
                empty++;
                skippedUrls.push({ url: u, reason: "empty" });
                console.log(`⚠️ EMPTY: ${u}`);
            } else {
                other++;
                skippedUrls.push({ url: u, reason: r.status || "unknown" });
                console.log(`❓ SKIPPED: ${u} -> ${r.status}`);
            }

            if (i % 50 === 0) console.log(`Progress: ${i}/${urls.length}`);
        }

        console.log(`\nFinished ✅ 
      Total Added: ${added}, 
      Denied: ${denied}, 
      Empty: ${empty}, 
      Other: ${other}`);

        // Save skipped URLs into a collection for debugging
        if (skippedUrls.length > 0) {
            await db.collection("skipped").deleteMany({});
            await db.collection("skipped").insertMany(skippedUrls);
            console.log(`Saved ${skippedUrls.length} skipped URLs into "skipped" collection 📂`);
        }

        process.exit(0);
    } catch (err) {
        console.error("Error:", err);
        process.exit(1);
    }
})();
