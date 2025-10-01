
// server/test-db.mjs
import { getDb } from "./db.mjs";

(async () => {
    try {
        const db = await getDb();
        console.log("✅ Connected to:", db.databaseName);

        // Insert test doc
        const result = await db.collection("pages").insertOne({
            url: "http://example.com",
            title: "Example Page",
            createdAt: new Date()
        });
        console.log("Inserted test doc:", result.insertedId);

        // Count docs
        const count = await db.collection("pages").countDocuments();
        console.log("Total docs in pages collection:", count);

        process.exit(0);
    } catch (err) {
        console.error("❌ DB connection failed:", err.message);
        process.exit(1);
    }
})();
